#!/usr/bin/env node
/**
 * Houtini LM — MCP Server for Local LLMs via OpenAI-compatible API
 *
 * Connects to LM Studio (or any OpenAI-compatible endpoint) and exposes
 * chat, custom prompts, code tasks, and model discovery as MCP tools.
 */

// Must be first: registers the node:sqlite experimental-warning filter BEFORE
// the model-cache import (which pulls in node:sqlite and would emit the warning
// at import time, i.e. before any later-registered handler could catch it).
import './suppress-experimental-warnings.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ReadResourceRequest,
  type ReadResourceResult,
  type ListResourcesResult,
  type ListToolsResult,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  profileModelsAtStartup,
  getCachedProfile,
  toModelProfile as cachedToProfile,
  getHFEnrichmentLine,
  getPromptHints,
  getThinkingSupport,
  recordPerformance,
  getAllPerformance,
  getLifetimeTotals,
  recordPrefillSample,
  getPrefillSamples,
  fitPrefillLinear,
  type PromptHints,
} from './model-cache.js';
import { acquireInferenceLock } from './inference-lock.js';
import { SERVER_VERSION } from './version.js';
import { parseContextOverflow, correctedMaxTokens } from './context-overflow.js';
import { formatReasoningBlock } from './reasoning-block.js';
import { resolveThinkingDecision, type ThinkingDecision } from './thinking-mode.js';
import { ConversationStore, formatConversationLine, formatConversationList, type ConversationTurn } from './conversation-store.js';
import {
  JobStore,
  formatJobSubmitted,
  formatJobStatus,
  formatJobList,
  sliceResult,
  formatJobChunkFooter,
  type JobTool,
  type JobRecord,
} from './job-store.js';
import { readFile, stat, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isAbsolute, basename, resolve, sep } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

// Env var naming: HOUTINI_LM_* is the preferred namespace now that we
// support more than just LM Studio. The legacy LM_STUDIO_* names remain
// accepted indefinitely so existing users don't need to change anything.
const LM_BASE_URL =
  process.env.HOUTINI_LM_ENDPOINT_URL ||
  process.env.LM_STUDIO_URL ||
  'http://localhost:1234';
const LM_MODEL =
  process.env.HOUTINI_LM_MODEL ||
  process.env.LM_STUDIO_MODEL ||
  '';
const LM_PASSWORD =
  process.env.HOUTINI_LM_API_KEY ||
  process.env.LM_STUDIO_PASSWORD ||
  process.env.LM_PASSWORD ||
  process.env.OPENROUTER_API_KEY ||
  '';
const HOUTINI_LM_PROVIDER = (process.env.HOUTINI_LM_PROVIDER || '').toLowerCase();
const DEFAULT_MAX_TOKENS = 16384;             // fallback when model context is unknown — overridden by dynamic calculation below
const DEFAULT_TEMPERATURE = 0.3;
const CONNECT_TIMEOUT_MS = 5000;
const INFERENCE_CONNECT_TIMEOUT_MS = 30_000; // generous connect timeout for inference
const SOFT_TIMEOUT_MS = 300_000;             // 5 min — progress notifications reset MCP client timeout, so this is a safety net not the primary limit
const READ_CHUNK_TIMEOUT_MS = 30_000;        // max wait for a single SSE chunk mid-stream
const PREFILL_TIMEOUT_MS = 180_000;          // max wait for the FIRST chunk — prompt prefill on slow hardware with big inputs can legitimately take 1-2 min
const PREFILL_KEEPALIVE_MS = 10_000;         // fire a progress notification every N ms while waiting for prefill to finish
const STREAM_PROGRESS_THROTTLE_MS = 500;     // min gap between per-delta streaming progress pings — decoupled from token rate so a fast model can't flood stdio
const FALLBACK_CONTEXT_LENGTH = parseInt(
  process.env.HOUTINI_LM_CONTEXT_WINDOW || process.env.LM_CONTEXT_WINDOW || '100000',
  10,
);

// ── code_task_files read guards ──────────────────────────────────────
// Per-file size cap (default 10 MB) — files are read fully into memory before
// the token estimator runs, so an unbounded read risks memory exhaustion.
const MAX_FILE_BYTES = Math.max(1, parseInt(process.env.HOUTINI_LM_MAX_FILE_MB || '10', 10)) * 1024 * 1024;
// Optional allowlist of directory roots that code_task_files may read from.
// Unset = current behaviour (any absolute path). When set (colon- or
// comma-separated), reads are confined to these roots AFTER symlink resolution,
// so a prompt-injected call can't escape to ~/.ssh/id_rsa via a planted symlink.
// Roots are realpath'd (not just resolved) so they compare correctly against the
// realpath'd file below — otherwise a root under a symlinked ancestor (e.g. macOS
// /tmp → /private/tmp) would never match and every confined read would fail. A
// non-existent root falls back to resolve(), which simply won't match anything.
const FILE_ROOTS: string[] = (process.env.HOUTINI_LM_FILE_ROOTS || '')
  .split(/[:,]/)
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => { try { return realpathSync(resolve(r)); } catch { return resolve(r); } });

/**
 * Read a file for code_task_files with size and (optional) root confinement.
 * Resolves symlinks first so neither the allowlist check nor the caller can be
 * tricked by a symlink pointing outside an allowed root. Throws on violation;
 * the caller turns the throw into an inline "READ FAILED" section.
 */
async function readGuardedFile(p: string): Promise<string> {
  const real = await realpath(p);
  if (FILE_ROOTS.length > 0) {
    const ok = FILE_ROOTS.some((root) => real === root || real.startsWith(root + sep));
    if (!ok) throw new Error('path is outside the allowed roots (HOUTINI_LM_FILE_ROOTS)');
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error('not a regular file');
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`file is ${(info.size / 1024 / 1024).toFixed(1)} MB, over the ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB limit (set HOUTINI_LM_MAX_FILE_MB to raise)`);
  }
  return readFile(real, 'utf8');
}

/**
 * Redact secrets embedded in an endpoint URL before echoing it to the client
 * or logs. Strips userinfo (`user:pass@`) and common secret query params
 * (`api_key`, `token`, …). Returns the input unchanged when it parses to no
 * secret, so the common `http://localhost:1234` case is displayed verbatim.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let hadSecret = false;
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      hadSecret = true;
    }
    for (const key of ['api_key', 'apikey', 'key', 'token', 'password', 'access_token']) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, '***');
        hadSecret = true;
      }
    }
    return hadSecret ? u.toString() : raw;
  } catch {
    return raw;
  }
}

// ── Session-level token accounting ───────────────────────────────────
// Tracks cumulative tokens offloaded to the local LLM across all calls
// in this session. Shown in every response footer so Claude can reason
// about cost savings and continue delegating strategically.

const session = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  /** Per-model performance tracking for routing insights */
  modelStats: new Map<string, { calls: number; ttftCalls: number; perfCalls: number; totalTtftMs: number; totalTokPerSec: number }>(),
};

// Lifetime mirror — kept in sync with the SQLite `model_performance` table
// so the footer/discover path stays synchronous. Hydrated once at startup
// from `getAllPerformance()`, then updated in-memory alongside every DB
// write in `recordUsage`. Also updated after the async DB write completes
// so counters can only ever run a tick behind, never ahead.
const lifetime = {
  totalCalls: 0,
  totalTokens: 0,
  modelsUsed: 0,
  firstSeenAt: null as number | null,
  /** Per-model lifetime stats — same shape as session.modelStats for easy formatting. */
  modelStats: new Map<string, { calls: number; ttftCalls: number; perfCalls: number; totalTtftMs: number; totalTokPerSec: number; totalPromptTokens: number; firstSeenAt: number; lastUsedAt: number }>(),
};

async function hydrateLifetimeFromDb(): Promise<void> {
  try {
    const totals = await getLifetimeTotals();
    lifetime.totalCalls = totals.totalCalls;
    lifetime.totalTokens = totals.totalTokens;
    lifetime.modelsUsed = totals.modelsUsed;
    lifetime.firstSeenAt = totals.firstSeenAt;

    const rows = await getAllPerformance();
    lifetime.modelStats.clear();
    for (const r of rows) {
      lifetime.modelStats.set(r.modelId, {
        calls: r.totalCalls,
        ttftCalls: r.ttftCalls,
        perfCalls: r.perfCalls,
        totalTtftMs: r.totalTtftMs,
        totalTokPerSec: r.totalTokPerSec,
        totalPromptTokens: r.totalPromptTokens,
        firstSeenAt: r.firstSeenAt,
        lastUsedAt: r.lastUsedAt,
      });
    }
  } catch (err) {
    process.stderr.write(`[houtini-lm] Lifetime hydration failed (stats will build from this session): ${err}\n`);
  }
}

/**
 * Compose the system prompt sent to the local model. Guarantees a non-empty,
 * directionally-productive instruction on EVERY call — the previous per-handler
 * merge sent no system message at all when the caller passed none and the model
 * family had no outputConstraint (Llama/Nemotron/Granite/gpt-oss/unknown).
 * Layers, in order:
 *   base       — persona (+ task, for code tasks); always present
 *   grounding  — universal anti-hallucination line (the trust lever for the QA loop)
 *   format     — JSON-only when a json_schema is set (which SUPPRESSES the
 *                markdown guidance that would otherwise contradict it);
 *                otherwise the task-appropriate format line plus any per-family
 *                constraint.
 * Compact by design — every token here is prefill the estimator and latency pay for.
 */
function buildSystemPrompt(opts: {
  base: string;
  formatLine?: string;
  modelConstraint?: string;
  structuredOutput?: boolean;
}): string {
  const layers: string[] = [opts.base.trim()];
  layers.push(
    'Base your answer only on the information provided in this conversation. ' +
    'If it is insufficient to answer correctly, say what is missing rather than guessing.',
  );
  if (opts.structuredOutput) {
    layers.push('Return only valid JSON conforming to the requested schema — no prose, no markdown, no code fences.');
  } else {
    if (opts.formatLine && opts.formatLine.trim()) layers.push(opts.formatLine.trim());
    if (opts.modelConstraint && opts.modelConstraint.trim()) layers.push(opts.modelConstraint.trim());
  }
  return layers.join('\n\n');
}

/**
 * Generation throughput in tokens/sec, isolating decode time from prefill.
 * `generationMs` spans connect + prefill + decode; dividing by the whole span
 * makes a large-prompt call look many times slower than the model actually
 * decodes, and that pessimistic number is what the footer, the first-call
 * benchmark, and the persisted per-model stats report back to the orchestrator.
 * Subtract TTFT so the denominator is the decode window. Returns null when it
 * can't be measured.
 *
 * Known limitation (tracked separately): for thinking models TTFT is time to
 * first *visible* token, so reasoning time is excluded from the denominator
 * while reasoning tokens remain in completion_tokens — resolving that needs the
 * TTFT-vs-reasoning fix, out of scope for this change.
 */
function computeTokPerSec(resp: StreamingResult): number | null {
  if (!resp.usage) return null;
  const decodeMs = resp.generationMs - (resp.ttftMs ?? 0);
  if (decodeMs <= 50) return null;
  return resp.usage.completion_tokens / (decodeMs / 1000);
}

function recordUsage(resp: StreamingResult) {
  session.calls++;
  const promptTokens = resp.usage?.prompt_tokens ?? 0;
  let completionTokens = resp.usage?.completion_tokens ?? 0;
  const reasoningTokens = resp.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (resp.usage) {
    session.promptTokens += promptTokens;
    session.completionTokens += completionTokens;
  } else if (resp.content.length > 0) {
    // Estimate when usage is missing (truncated responses)
    const est = Math.ceil(resp.content.length / 4);
    completionTokens = est;
    session.completionTokens += est;
  }

  // Tok/s used by both session and lifetime stats
  const tokPerSec = computeTokPerSec(resp) ?? 0;

  // Session per-model (unchanged behaviour)
  if (resp.model) {
    const existing = session.modelStats.get(resp.model) || { calls: 0, ttftCalls: 0, perfCalls: 0, totalTtftMs: 0, totalTokPerSec: 0 };
    existing.calls++;
    if (resp.ttftMs) {
      existing.totalTtftMs += resp.ttftMs;
      existing.ttftCalls++;
    }
    if (tokPerSec > 0) {
      existing.perfCalls++;
      existing.totalTokPerSec += tokPerSec;
    }
    session.modelStats.set(resp.model, existing);
  }

  // Lifetime mirror + SQLite write — fire-and-forget so a DB hiccup can't
  // stall a tool response. The in-memory mirror is updated synchronously so
  // the footer and discover output reflect this call immediately.
  if (resp.model && (promptTokens > 0 || completionTokens > 0)) {
    const now = Date.now();
    const wasFirstEver = !lifetime.modelStats.has(resp.model);
    const lExisting = lifetime.modelStats.get(resp.model) || {
      calls: 0, ttftCalls: 0, perfCalls: 0, totalTtftMs: 0, totalTokPerSec: 0, totalPromptTokens: 0,
      firstSeenAt: now, lastUsedAt: now,
    };
    lExisting.calls++;
    if (resp.ttftMs) {
      lExisting.totalTtftMs += resp.ttftMs;
      lExisting.ttftCalls++;
    }
    if (tokPerSec > 0) {
      lExisting.perfCalls++;
      lExisting.totalTokPerSec += tokPerSec;
    }
    lExisting.totalPromptTokens += promptTokens;
    lExisting.lastUsedAt = now;
    lifetime.modelStats.set(resp.model, lExisting);

    lifetime.totalCalls++;
    lifetime.totalTokens += promptTokens + completionTokens;
    if (wasFirstEver) {
      lifetime.modelsUsed++;
      if (lifetime.firstSeenAt === null) lifetime.firstSeenAt = now;
    }

    recordPerformance(resp.model, {
      ttftMs: resp.ttftMs,
      tokPerSec: tokPerSec > 0 ? tokPerSec : undefined,
      promptTokens,
      completionTokens,
      reasoningTokens,
    }).catch((err) => {
      process.stderr.write(`[houtini-lm] Performance write failed (continuing): ${err}\n`);
    });

    // Record (prompt_tokens, TTFT) pair for the linear-fit prefill estimator.
    // Only meaningful when both values are real (we have actual usage and a
    // measured TTFT). Fire-and-forget alongside recordPerformance.
    if (resp.ttftMs && promptTokens > 0) {
      recordPrefillSample(resp.model, promptTokens, resp.ttftMs).catch((err) => {
        process.stderr.write(`[houtini-lm] Prefill sample write failed (continuing): ${err}\n`);
      });
    }
  }
}

function sessionSummary(): string {
  const total = session.promptTokens + session.completionTokens;
  if (session.calls === 0 && lifetime.totalCalls === 0) return '';

  const callWord = (n: number) => (n === 1 ? 'call' : 'calls');
  const sessionPart = session.calls > 0
    ? `this session: ${total.toLocaleString()} tokens / ${session.calls} ${callWord(session.calls)}`
    : 'this session: 0 tokens';

  // Lifetime numbers only show once there's something in the DB — avoids a
  // confusing "lifetime: 0" on a truly fresh install.
  if (lifetime.totalCalls > 0) {
    return `💰 Claude quota saved — ${sessionPart} · lifetime: ${lifetime.totalTokens.toLocaleString()} tokens / ${lifetime.totalCalls} ${callWord(lifetime.totalCalls)}`;
  }
  return `💰 Claude quota saved ${sessionPart}`;
}

/**
 * Return true when this response is the first one with measurable perf stats
 * for its model in the current session. Used to surface a one-off "benchmarked"
 * line so Claude sees the real speed of the local model on a genuine task,
 * not an artificial warmup.
 */
function isFirstBenchmarkedCall(modelId: string, tokPerSec: number): boolean {
  if (!modelId || tokPerSec <= 0) return false;
  const stats = session.modelStats.get(modelId);
  // After recordUsage has run, perfCalls === 1 means this was the first measured call.
  return !!stats && stats.perfCalls === 1;
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (LM_PASSWORD) h['Authorization'] = `Bearer ${LM_PASSWORD}`;
  const profile = getProviderProfile();
  for (const [k, v] of Object.entries(profile.extraHeaders)) h[k] = v;
  return h;
}

// ── Request semaphore ────────────────────────────────────────────────
// Most local LLM servers run a single model and queue parallel requests,
// which stacks timeouts and wastes the budget. This semaphore ensures only one
// inference call runs at a time; others wait in line.

// Global override: HOUTINI_LM_SERIALISE=0 (or false/no/off) turns OFF inference
// serialisation entirely — both the in-process semaphore and the cross-process
// file lock. The right setting for backends that batch requests natively (vLLM,
// TGI, SGLang), where one-at-a-time only throttles throughput. Default on, which
// suits a single-model LM Studio / Ollama host contending for one GPU.
const SERIALISE_INFERENCE = !/^(0|false|no|off)$/i.test(process.env.HOUTINI_LM_SERIALISE || '');

/** Serialise inference for the current backend? Combines the env override with
 *  the provider profile (OpenRouter and other parallel-friendly backends off). */
function shouldSerialiseInference(): boolean {
  return SERIALISE_INFERENCE && getProviderProfile().serialiseInference;
}

let inferenceLock: Promise<void> = Promise.resolve();

function withInferenceLock<T>(fn: () => Promise<T>): Promise<T> {
  // Skip when serialisation is off (env override) or the backend is
  // parallel-friendly (OpenRouter etc.) — serialising there just throttles us.
  if (!shouldSerialiseInference()) return fn();
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const wait = inferenceLock;
  inferenceLock = next;
  return wait.then(fn).finally(() => release!());
}

// ── Server-side conversation history (chat) ──────────────────────────
// Default on: HOUTINI_LM_CONVERSATIONS=0 (or false/no/off) disables the
// feature entirely — CONVERSATION_PROPS is then left out of the tool schema
// (see TOOLS below) and any start_conversation/conversation_id argument
// becomes a hard error instead of being silently ignored (see handleCallTool).
const CONVERSATIONS_ENABLED = !/^(0|false|no|off)$/i.test(process.env.HOUTINI_LM_CONVERSATIONS || '');
const CONVERSATION_TTL_MIN = Math.max(1, parseInt(process.env.HOUTINI_LM_CONVERSATION_TTL_MIN || '60', 10) || 60);
const CONVERSATION_MAX = Math.max(1, parseInt(process.env.HOUTINI_LM_CONVERSATION_MAX || '50', 10) || 50);
const CONVERSATION_MAX_TURNS = Math.max(1, parseInt(process.env.HOUTINI_LM_CONVERSATION_MAX_TURNS || '40', 10) || 40);
const CONVERSATION_MAX_CHARS = Math.max(1, parseInt(process.env.HOUTINI_LM_CONVERSATION_MAX_CHARS || '48000', 10) || 48000);
// Optional: when set, resolveConversationOwner() derives the owner key from
// this HTTP request header (an authenticated user identity forwarded by a
// front-end proxy) instead of the MCP session ID — see that function for the
// fail-closed contract this enables. Only the header *name* is lower-cased
// here (the SDK always hands back requestInfo.headers with lower-case keys,
// since it builds them via Object.fromEntries() over a Web Headers object);
// the header *value* is read verbatim in resolveConversationOwner() — lower-
// casing an identity claim like `sub` could collapse two distinct users into
// one owner key.
const CONVERSATION_OWNER_HEADER = (process.env.HOUTINI_LM_CONVERSATION_OWNER_HEADER || '').trim().toLowerCase();
const conversations = new ConversationStore({
  ttlMs: CONVERSATION_TTL_MIN * 60_000,
  maxConversations: CONVERSATION_MAX,
  maxTurns: CONVERSATION_MAX_TURNS,
  maxChars: CONVERSATION_MAX_CHARS,
});

// ── Async job execution (custom_prompt / code_task_files only) ────────
// Phase 13: `async: true` submits the call as a background job instead of
// running it inline. See job-store.ts's header for the storage model and
// multi-tenant safety story; this section owns env config, the JobStore
// instance, and the runner (submitJob/pump/runJob) that drains it. Wired
// into custom_prompt and code_task_files only — chat and code_task are
// untouched by phase 13.
//
// Default on: HOUTINI_LM_JOBS=0 (or false/no/off) disables the feature
// entirely — the `jobs` tool is hidden from tools/list (see the conditional
// spread in TOOLS below) and `async: true` becomes a hard error instead of
// being silently ignored.
const JOBS_ENABLED = !/^(0|false|no|off)$/i.test(process.env.HOUTINI_LM_JOBS || '');
const JOB_TTL_MIN = Math.max(1, parseInt(process.env.HOUTINI_LM_JOB_TTL_MIN || '60', 10) || 60);
const JOB_MAX = Math.max(1, parseInt(process.env.HOUTINI_LM_JOB_MAX || '50', 10) || 50);
const JOB_ACTIVE_MAX_PER_OWNER = Math.max(1, parseInt(process.env.HOUTINI_LM_JOB_ACTIVE_MAX_PER_OWNER || '2', 10) || 2);
const JOB_CONCURRENCY = Math.max(1, parseInt(process.env.HOUTINI_LM_JOB_CONCURRENCY || '1', 10) || 1);
const JOB_SOFT_TIMEOUT_MIN = Math.max(1, parseInt(process.env.HOUTINI_LM_JOB_SOFT_TIMEOUT_MIN || '15', 10) || 15);
// Not one of phase 13's headline 6 env vars, but added for the same reason
// HOUTINI_LM_CONVERSATION_MAX_CHARS exists for ConversationStore: a
// completed job's result is the same text a synchronous call would have
// returned, so 200K is generous headroom for real use, but tests (see
// scripts/test-jobs-e2e.mjs's truncation case) need a much smaller ceiling
// to exercise truncation without generating a 200K-char fake response.
const JOB_MAX_RESULT_CHARS = Math.max(1, parseInt(process.env.HOUTINI_LM_JOB_MAX_RESULT_CHARS || '200000', 10) || 200_000);

// jobs get's per-response inline size ceiling (phase 14-1) — distinct from
// JOB_MAX_RESULT_CHARS above: that one bounds how much of a job's result is
// *kept* server-side (excess silently truncated with a marker); this one
// bounds how much of the *kept* result a single `jobs get` call returns
// inline before switching to offset/limit-paged chunks (sliceResult /
// formatJobChunkFooter in job-store.ts). Phase 14-0's D1 measurement found
// N=100,000 chars succeeds end-to-end over the production MCP path but with
// TTFT ~6x N=50,000's; 50,000 is the D1c-recommended default, giving ~2x
// headroom under the largest N actually exercised.
//
// 0 is a meaningful value here (the D2 kill switch — disables auto-chunking,
// restoring phase 13's always-return-everything-inline behavior), so this
// can't use the `parseInt(...) || default` idiom the JOB_* vars above use:
// that idiom can't distinguish "unset" from "explicitly 0" and would
// silently reinterpret a typo'd value as the kill switch. Handled explicitly
// instead: unset/blank -> default; a non-negative integer (0 included) ->
// that value; anything else (negative, NaN, non-numeric) -> default, with a
// stderr warning so a typo doesn't silently disable chunking.
const JOB_RESULT_INLINE_MAX_CHARS_RAW = (process.env.HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS || '').trim();
const JOB_RESULT_INLINE_MAX_CHARS = (() => {
  if (JOB_RESULT_INLINE_MAX_CHARS_RAW === '') return 50_000;
  const n = parseInt(JOB_RESULT_INLINE_MAX_CHARS_RAW, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  process.stderr.write(
    `[houtini-lm] Invalid HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS="${JOB_RESULT_INLINE_MAX_CHARS_RAW}" (must be a non-negative integer) — using default 50000\n`,
  );
  return 50_000;
})();

const jobs = new JobStore({
  ttlMs: JOB_TTL_MIN * 60_000,
  maxJobs: JOB_MAX,
  maxResultChars: JOB_MAX_RESULT_CHARS,
});

// Job-scoped chatCompletionStreaming timeouts — longer than the interactive
// defaults (SOFT_TIMEOUT_MS/PREFILL_TIMEOUT_MS above) because a job has no
// MCP client watching a request timeout; it can afford to wait out a slow
// prefill or a long generation instead of truncating early.
const JOB_SOFT_TIMEOUT_MS = JOB_SOFT_TIMEOUT_MIN * 60_000;
const JOB_PREFILL_TIMEOUT_MS = JOB_SOFT_TIMEOUT_MS;
// A job never has an MCP progress channel to keep a client's request alive
// (see runJob below), so chatCompletionStreamingInner's fail-open default
// for the cross-process lock (45s — see canKeepalive at that call site)
// would apply and let two jobs drive the model in parallel. Give the lock
// the job's full soft-timeout budget instead.
//
// STALE_MS in inference-lock.ts is 7 minutes — less than
// JOB_SOFT_TIMEOUT_MIN's default of 15. A long-running job's cross-process
// lock CAN therefore be stolen by another process before the job finishes,
// degrading cross-process serialisation for that job to best-effort. This is
// accepted, not an oversight: acquireInferenceLock()'s whole contract is
// fail-open/best-effort (see that module's header — "serialisation is a
// throughput optimisation, never a correctness dependency"), and lowering
// STALE_MS to accommodate jobs would risk prematurely stealing a genuinely
// slow *interactive* call elsewhere. Same-process serialisation
// (withInferenceLock, inside chatCompletionStreaming itself) remains a hard
// guarantee for jobs regardless — only the cross-process layer degrades.
const JOB_LOCK_MAX_WAIT_MS = JOB_SOFT_TIMEOUT_MS;

// Job execution functions, keyed by job id. JobStore (job-store.ts) tracks
// only state + result/error — the actual () => Promise<string> to run is a
// runner-only concern that lives here. Removed as soon as pump() claims a
// job (see below), so a fn can never leak or run twice.
const jobFns = new Map<string, () => Promise<string>>();
let jobsRunning = 0;

/**
 * Create a job record and register its execution function, then kick the
 * queue. Returns the new job id immediately — actual execution happens
 * later, drained by pump()/runJob() below.
 */
function submitJob(owner: string, tool: JobTool, fn: () => Promise<string>): string {
  const id = jobs.create(owner, tool);
  jobFns.set(id, fn);
  process.stderr.write(`[houtini-lm] job ${id} (${tool}) submitted\n`);
  pump();
  return id;
}

/**
 * Claim and start pending jobs up to HOUTINI_LM_JOB_CONCURRENCY. Called from
 * exactly two places — submitJob() right after a new job is queued, and
 * runJob()'s `finally` right after a job finishes — no timer drives this, by
 * design (see phase 13's plan).
 */
function pump(): void {
  while (jobsRunning < JOB_CONCURRENCY) {
    const record = jobs.takeNextPending();
    if (!record) return;
    const fn = jobFns.get(record.id);
    jobFns.delete(record.id);
    if (!fn) {
      // Unreachable in practice — every pending job got its fn registered by
      // submitJob() before takeNextPending() could ever see it. Defensive
      // only: fail it outright rather than leave it wedged in `running`
      // forever with nothing to execute, and keep pumping.
      jobs.markFailed(record.id, 'internal error: job function missing');
      continue;
    }
    jobsRunning++;
    process.stderr.write(`[houtini-lm] job ${record.id} (${record.tool}) started\n`);
    void runJob(record, fn);
  }
}

/**
 * Run one job to completion. try/catch/finally is UNCONDITIONAL — an
 * uncaught rejection from fn() would otherwise be an unhandled promise
 * rejection at the process level, killing the whole server (Node's default
 * behaviour) and taking every other in-flight request down with it. A single
 * job's failure must never do that.
 *
 * Deliberately does NOT wrap fn() in withInferenceLock()/acquireInferenceLock()
 * — fn() is expected to call chatCompletionStreaming() itself, which already
 * takes the in-process semaphore internally (see withInferenceLock at that
 * function's definition, above). The semaphore is not reentrant: wrapping
 * this call in another withInferenceLock would deadlock the moment fn()'s
 * own chatCompletionStreaming() call tried to acquire it a second time from
 * inside the first acquisition. Found via plan-deep-check's Fable review
 * before any of this shipped — see phase13-async-jobs.md.
 */
async function runJob(record: JobRecord, fn: () => Promise<string>): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    jobs.markCompleted(record.id, result);
    process.stderr.write(`[houtini-lm] job ${record.id} completed in ${Date.now() - startedAt}ms (${result.length} chars)\n`);
  } catch (err) {
    jobs.markFailed(record.id, err instanceof Error ? err.message : String(err));
    process.stderr.write(`[houtini-lm] job ${record.id} failed after ${Date.now() - startedAt}ms\n`);
  } finally {
    jobsRunning--;
    pump();
  }
}

// ── OpenAI-compatible API helpers ────────────────────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface StreamingResult {
  content: string;
  /** Raw content before think-block stripping (for quality assessment) */
  rawContent: string;
  /**
   * Reasoning the model produced, when any. Prefers the separate-channel
   * reasoning (OpenAI vendor extension delta.reasoning_content / Ollama's
   * delta.reasoning); falls back to <think>...</think> blocks captured while
   * stripping them from the content channel, for backends that only emit
   * reasoning inline (LM Studio, vLLM, local Ollama tags).
   */
  reasoningContent?: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** OpenAI: how many of the completion tokens were reasoning (hidden) */
    completion_tokens_details?: { reasoning_tokens?: number };
    /** OpenAI: how many prompt tokens were served from the prefix cache (KV reuse) */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  finishReason: string;
  truncated: boolean;
  /** Time to first token in milliseconds */
  ttftMs?: number;
  /** Total generation time in milliseconds */
  generationMs: number;
  /** True when think-block stripping left nothing and we fell back to raw content */
  thinkStripFallback?: boolean;
  /** True when no visible content arrived and we fell back to reasoning_content */
  reasoningFallback?: boolean;
  /** Truncation caused by prefill stall (no chunks received) vs mid-stream stall */
  prefillStall?: boolean;
  /** Error payload received mid-stream from the backend (OpenRouter/vLLM/llama.cpp emit these) */
  streamError?: string;
  /**
   * The thinking-suppress/force/leave decision made for this call (see
   * thinking-mode.ts). Internal-only — formatFooter() does not read this
   * field, so it has no effect on the response text on the default path.
   * Left undefined on the OpenRouter branch (reasoningStyle ===
   * 'openrouter-field' never calls getThinkingSupport(), so no decision is
   * computed there) and when modelId is empty, so a later phase's
   * decision-aware hint line can tell "no decision was made" apart from an
   * actual 'leave' result.
   */
  thinkingDecision?: ThinkingDecision;
}

/** OpenAI-compatible response_format for structured output */
interface ResponseFormat {
  type: 'json_schema' | 'json_object' | 'text';
  json_schema?: {
    name: string;
    strict?: boolean | string;
    schema: Record<string, unknown>;
  };
}

interface ModelInfo {
  id: string;
  object?: string;
  type?: string;              // "llm" | "vlm" | "embeddings"
  publisher?: string;          // e.g. "nvidia", "qwen", "ibm"
  arch?: string;               // e.g. "nemotron_h_moe", "qwen3moe", "llama"
  compatibility_type?: string; // "gguf" | "mlx"
  quantization?: string;       // e.g. "Q4_K_M", "BF16", "MXFP4"
  state?: string;              // "loaded" | "not-loaded"
  max_context_length?: number; // model's maximum context (v0 API)
  loaded_context_length?: number; // actual context configured when loaded
  capabilities?: string[];     // e.g. ["tool_use"]
  context_length?: number;     // v1 API fallback
  max_model_len?: number;      // vLLM fallback
  owned_by?: string;
  [key: string]: unknown;
}

// ── Model knowledge base ─────────────────────────────────────────────
// Maps known model families (matched by ID or architecture) to human-readable
// descriptions and capability profiles. This lets houtini-lm tell Claude what
// each model is good at, so it can make informed delegation decisions.

interface ModelProfile {
  family: string;
  description: string;
  strengths: string[];
  weaknesses: string[];
  bestFor: string[];
  size?: string; // e.g. "3B", "70B" — only if consistently one size
}

const MODEL_PROFILES: { pattern: RegExp; profile: ModelProfile }[] = [
  {
    pattern: /nemotron|nemotron_h_moe/i,
    profile: {
      family: 'NVIDIA Nemotron',
      description: 'NVIDIA\'s compact reasoning model optimised for accurate, structured responses. Strong at step-by-step logic and instruction following.',
      strengths: ['logical reasoning', 'math', 'step-by-step problem solving', 'code review', 'structured output'],
      weaknesses: ['creative writing', 'constrained generation', 'factual knowledge on niche topics'],
      bestFor: ['analysis tasks', 'code bug-finding', 'math/science questions', 'data transformation'],
    },
  },
  {
    pattern: /granite|granitehybrid/i,
    profile: {
      family: 'IBM Granite',
      description: 'IBM\'s enterprise-focused model family. Compact and efficient, designed for business and code tasks with strong instruction following.',
      strengths: ['code generation', 'instruction following', 'enterprise tasks', 'efficiency'],
      weaknesses: ['creative tasks', 'long-form generation'],
      bestFor: ['boilerplate generation', 'code explanation', 'structured Q&A'],
    },
  },
  {
    pattern: /qwen3-coder|qwen3.*coder/i,
    profile: {
      family: 'Qwen3 Coder',
      description: 'Alibaba\'s code-specialised model with agentic capabilities. Excellent at code generation, review, and multi-step coding tasks.',
      strengths: ['code generation', 'code review', 'debugging', 'test writing', 'refactoring', 'multi-step reasoning'],
      weaknesses: ['non-code creative tasks'],
      bestFor: ['code generation', 'code review', 'test stubs', 'type definitions', 'refactoring'],
    },
  },
  {
    pattern: /qwen3-vl|qwen.*vl/i,
    profile: {
      family: 'Qwen3 Vision-Language',
      description: 'Alibaba\'s multimodal model handling both text and image inputs. Can analyse screenshots, diagrams, and visual content.',
      strengths: ['image understanding', 'visual Q&A', 'diagram analysis', 'OCR'],
      weaknesses: ['pure text tasks (use a text-only model instead)'],
      bestFor: ['screenshot analysis', 'UI review', 'diagram interpretation'],
    },
  },
  {
    pattern: /qwen3(?!.*coder)(?!.*vl)/i,
    profile: {
      family: 'Qwen3',
      description: 'Alibaba\'s general-purpose model with strong multilingual and reasoning capabilities. Good all-rounder.',
      strengths: ['general reasoning', 'multilingual', 'code', 'instruction following'],
      weaknesses: ['specialised code tasks (use Qwen3 Coder instead)'],
      bestFor: ['general Q&A', 'translation', 'summarisation', 'brainstorming'],
    },
  },
  {
    pattern: /llama[- ]?3/i,
    profile: {
      family: 'Meta LLaMA 3',
      description: 'Meta\'s open-weight general-purpose model. Strong baseline across tasks with large community fine-tune ecosystem.',
      strengths: ['general reasoning', 'code', 'instruction following', 'broad knowledge'],
      weaknesses: ['specialised tasks where fine-tuned models excel'],
      bestFor: ['general delegation', 'drafting', 'code review', 'Q&A'],
    },
  },
  {
    pattern: /minimax[- ]?m2/i,
    profile: {
      family: 'MiniMax M2',
      description: 'MiniMax\'s large MoE model with strong long-context and reasoning capabilities.',
      strengths: ['long context', 'reasoning', 'creative writing', 'multilingual'],
      weaknesses: ['may be slower due to model size'],
      bestFor: ['long document analysis', 'creative tasks', 'complex reasoning'],
    },
  },
  {
    pattern: /kimi[- ]?k2/i,
    profile: {
      family: 'Kimi K2',
      description: 'Moonshot AI\'s large MoE model with strong agentic and tool-use capabilities.',
      strengths: ['agentic tasks', 'tool use', 'code', 'reasoning', 'long context'],
      weaknesses: ['may be slower due to model size'],
      bestFor: ['complex multi-step tasks', 'code generation', 'reasoning chains'],
    },
  },
  {
    pattern: /gpt-oss/i,
    profile: {
      family: 'OpenAI GPT-OSS',
      description: 'OpenAI\'s open-source model release. General-purpose with strong instruction following.',
      strengths: ['instruction following', 'general reasoning', 'code'],
      weaknesses: ['less tested in open ecosystem than LLaMA/Qwen'],
      bestFor: ['general delegation', 'code tasks', 'Q&A'],
    },
  },
  {
    pattern: /glm[- ]?4/i,
    profile: {
      family: 'GLM-4',
      description: 'Zhipu AI\'s open-weight MoE model. Fast inference with strong general reasoning, multilingual support, and tool-use capabilities. Uses chain-of-thought reasoning internally. MIT licensed.',
      strengths: ['fast inference', 'general reasoning', 'tool use', 'multilingual', 'code', 'instruction following', 'chain-of-thought'],
      weaknesses: ['always emits internal reasoning (stripped automatically)', 'less tested in English-only benchmarks than LLaMA/Qwen'],
      bestFor: ['general delegation', 'fast drafting', 'code tasks', 'structured output', 'Q&A'],
    },
  },
  {
    pattern: /nomic.*embed|embed.*nomic/i,
    profile: {
      family: 'Nomic Embed',
      description: 'Text embedding model for semantic search and similarity. Not a chat model — produces vector embeddings.',
      strengths: ['text embeddings', 'semantic search', 'clustering'],
      weaknesses: ['cannot chat or generate text'],
      bestFor: ['RAG pipelines', 'semantic similarity', 'document search'],
    },
  },
  {
    pattern: /abliterated/i,
    profile: {
      family: 'Abliterated (uncensored)',
      description: 'Community fine-tune with safety guardrails removed. More permissive but may produce lower-quality or unreliable output.',
      strengths: ['fewer refusals', 'unconstrained generation'],
      weaknesses: ['may hallucinate more', 'no safety filtering', 'less tested'],
      bestFor: ['tasks where the base model refuses unnecessarily'],
    },
  },
];

/**
 * Match a model to its known profile.
 * Priority: 1) static MODEL_PROFILES (curated), 2) SQLite cache (auto-generated from HF)
 */
function getModelProfile(model: ModelInfo): ModelProfile | undefined {
  // Try static profiles first (curated, most reliable)
  for (const { pattern, profile } of MODEL_PROFILES) {
    if (pattern.test(model.id)) return profile;
  }
  if (model.arch) {
    for (const { pattern, profile } of MODEL_PROFILES) {
      if (pattern.test(model.arch)) return profile;
    }
  }
  return undefined;
}

/**
 * Async version that also checks SQLite cache for auto-generated profiles.
 * Use this when you need the most complete profile available.
 */
async function getModelProfileAsync(model: ModelInfo): Promise<ModelProfile | undefined> {
  // Static profiles take priority
  const staticProfile = getModelProfile(model);
  if (staticProfile) return staticProfile;

  // Check SQLite cache for auto-generated profile
  try {
    const cached = await getCachedProfile(model.id);
    if (cached) {
      const profile = cachedToProfile(cached);
      if (profile) return profile;
    }
  } catch {
    // Cache lookup failed — fall through
  }

  return undefined;
}

/**
 * Format a single model's full metadata for display.
 * Async because it may fetch HuggingFace enrichment data.
 */
async function formatModelDetail(model: ModelInfo, enrichWithHF: boolean = false): Promise<string> {
  const ctx = getContextLength(model);
  const maxCtx = getMaxContextLength(model);
  // Use async profile lookup (checks static + SQLite cache)
  const profile = await getModelProfileAsync(model);
  const parts: string[] = [];

  // Header line
  parts.push(`  ${model.state === 'loaded' ? '●' : '○'} ${model.id}`);

  // Metadata line
  const meta: string[] = [];
  if (model.type) meta.push(`type: ${model.type}`);
  if (model.arch) meta.push(`arch: ${model.arch}`);
  if (model.quantization) meta.push(`quant: ${model.quantization}`);
  if (model.compatibility_type) meta.push(`format: ${model.compatibility_type}`);
  // Show loaded context vs max context when both are available and different
  if (model.loaded_context_length && maxCtx && model.loaded_context_length !== maxCtx) {
    meta.push(`context: ${model.loaded_context_length.toLocaleString()} (max ${maxCtx.toLocaleString()})`);
  } else if (ctx) {
    meta.push(`context: ${ctx.toLocaleString()}`);
  }
  if (model.publisher) meta.push(`by: ${model.publisher}`);
  if (meta.length > 0) parts.push(`    ${meta.join(' · ')}`);

  // Capabilities
  if (model.capabilities && model.capabilities.length > 0) {
    parts.push(`    Capabilities: ${model.capabilities.join(', ')}`);
  }

  // Profile info (static or auto-generated from SQLite cache)
  if (profile) {
    parts.push(`    ${profile.family}: ${profile.description}`);
    parts.push(`    Best for: ${profile.bestFor.join(', ')}`);
  }

  // HuggingFace enrichment line from SQLite cache
  if (enrichWithHF) {
    try {
      const hfLine = await getHFEnrichmentLine(model.id);
      if (hfLine) parts.push(hfLine);
    } catch {
      // HF enrichment is best-effort — never block on failure
    }
  }

  return parts.join('\n');
}

/**
 * Fetch with a connect timeout so Claude doesn't hang when the host is offline.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse Retry-After (seconds or HTTP-date) into ms. Null for unparseable.
 */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const asInt = parseInt(headerValue, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Retry a fetch on 429/5xx with jittered backoff. Only used when the
 * current provider profile opts in (`retryOnRateLimit: true`). Each attempt
 * gets its own fresh timeout so retries don't starve.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        try { await res.body?.cancel(); } catch { /* ignore */ }
        // Exponential base capped at 10s, but honour an explicit server
        // Retry-After (up to 60s) even when larger. Jitter UPWARD only
        // (target..1.5×) so we never retry before the server-mandated delay.
        const base = Math.min(400 * (attempt + 1), 10_000);
        const target = Math.max(base, Math.min(retryAfter ?? 0, 60_000));
        const delay = Math.round(target * (1 + Math.random() * 0.5));
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      // A timeout abort can mean the server already received the POST and began
      // a (billed) generation — re-POSTing /v1/chat/completions would duplicate
      // it. Only retry errors that indicate the request never reached the
      // server (connection refused/reset); never on our own abort.
      const isAbort = e instanceof Error && e.name === 'AbortError';
      if (isAbort || attempt >= retries) break;
      const delay = Math.round(400 * (attempt + 1) * (1 + Math.random() * 0.5));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Read from a stream with a per-chunk timeout.
 * Prevents hanging forever if the LLM stalls mid-generation.
 */
async function timedRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | 'timeout'> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Streaming chat completion with soft timeout.
 *
 * Uses SSE streaming (`stream: true`) so tokens arrive incrementally.
 * If we approach the MCP SDK's ~60s timeout (soft limit at 55s), we
 * return whatever content we have so far with `truncated: true`.
 * This means large code reviews return partial results instead of nothing.
 */
/** Optional per-request sampling controls, passed through to the backend when set. */
interface SamplingParams {
  seed?: number;
  stop?: string | string[];
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

/**
 * Shape of the SDK's per-request notification sender (extra.sendNotification),
 * narrowed to the one notification type houtini-lm actually emits. Declared
 * locally instead of importing the SDK type so this file's dependency surface
 * stays untouched — the structural shape is all a caller needs to satisfy it.
 */
type ProgressNotifier = (notification: {
  method: 'notifications/progress';
  params: { progressToken: string | number; progress: number; message?: string };
}) => Promise<void>;

interface InferenceOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  responseFormat?: ResponseFormat;
  progressToken?: string | number;
  sampling?: SamplingParams;
  /**
   * Per-call opt-in to force thinking on for this request only. Does not
   * override HOUTINI_LM_THINKING=off — the env var is an operator-level
   * safety net (e.g. vLLM-behind-an-alias deployments) that a single caller
   * must not be able to defeat. See resolveThinkingDecision() in
   * thinking-mode.ts for the full precedence.
   */
  forceThinking?: boolean;
  /**
   * Request-scoped notification sender, supplied by the MCP request handler
   * from extra.sendNotification. A future HTTP transport routes notifications
   * by the originating request's stream, so the module-level server.notification()
   * has no addressee there. Falls back to the module-level server when omitted
   * (e.g. any future non-request caller) — over stdio the two are byte-identical,
   * since StdioServerTransport.send() ignores the routing options entirely.
   */
  sendNotification?: ProgressNotifier;
  /**
   * Overrides for SOFT_TIMEOUT_MS / PREFILL_TIMEOUT_MS / acquireInferenceLock's
   * maxWaitMs, all undefined by default — omitting them reproduces today's
   * behaviour exactly. Added for async job execution (phase 13): a job has no
   * MCP client watching a request timeout and no progressToken to keep one
   * alive, so it needs longer budgets than an interactive call. See the
   * "Async job execution" section for the values jobs actually pass.
   */
  softTimeoutMs?: number;
  prefillTimeoutMs?: number;
  lockMaxWaitMs?: number;
}

/**
 * Extract and RANGE-VALIDATE optional sampling params from tool args. Out-of-range,
 * NaN, or wrong-type values are dropped (undefined) rather than forwarded — the
 * backend then applies its own default. This also closes the earlier gap where an
 * unvalidated max_tokens/temperature could reach the upstream request.
 */
function extractSamplingParams(args: Record<string, unknown>): SamplingParams {
  const range = (v: unknown, min: number, max: number): number | undefined => {
    const n = typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };
  const stopRaw = args.stop;
  const stop = typeof stopRaw === 'string'
    ? stopRaw
    : Array.isArray(stopRaw)
      ? (stopRaw.filter((s) => typeof s === 'string').slice(0, 4) as string[])
      : undefined;
  return {
    seed: Number.isInteger(args.seed) ? (args.seed as number) : undefined,
    stop: stop && stop.length ? stop : undefined,
    topP: range(args.top_p, 0, 1),
    topK: range(args.top_k, 1, 100_000),
    repeatPenalty: range(args.repeat_penalty, 0, 2),
    frequencyPenalty: range(args.frequency_penalty, -2, 2),
    presencePenalty: range(args.presence_penalty, -2, 2),
  };
}

/** Clamp a caller-supplied temperature to a sane range, or undefined if unusable. */
function validTemperature(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : undefined;
}

/**
 * Minimum caller-supplied max_tokens the server will honour. Values below this
 * are discarded so the dynamic context-based budget (25% of the model's context
 * window) applies instead — MCP clients habitually pass tiny caps like 256 that
 * strangle reasoning models. Set HOUTINI_LM_MIN_TOKENS=0 to honour any value
 * (e.g. deliberate micro-chunking on slow hardware), or a different floor.
 */
const MIN_MAX_TOKENS = (() => {
  const v = Number(process.env.HOUTINI_LM_MIN_TOKENS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 4096;
})();

/** Clamp a caller-supplied max_tokens to a positive sane range, or undefined. */
function validMaxTokens(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000) return undefined;
  if (n < MIN_MAX_TOKENS) {
    process.stderr.write(
      `[houtini-lm] max_tokens=${n} is below the ${MIN_MAX_TOKENS} floor — ignoring it and using the dynamic context-based budget (HOUTINI_LM_MIN_TOKENS=0 to allow)\n`,
    );
    return undefined;
  }
  return n;
}

/**
 * Build an OpenAI response_format from the tool's json_schema input. Accepts
 * BOTH the documented wrapper `{ name, schema, strict }` and a bare JSON Schema
 * (which the description invites) — the latter previously produced undefined
 * name/schema and silently unconstrained output.
 */
function toResponseFormat(js: unknown): ResponseFormat | undefined {
  if (!js || typeof js !== 'object') return undefined;
  const obj = js as Record<string, unknown>;
  const hasWrapper = !!obj.schema && typeof obj.schema === 'object';
  const schema = (hasWrapper ? obj.schema : obj) as Record<string, unknown>;
  const name = hasWrapper && typeof obj.name === 'string' ? obj.name : 'response';
  const strict = hasWrapper && typeof obj.strict === 'boolean' ? obj.strict : true;
  return { type: 'json_schema', json_schema: { name, strict, schema } };
}

async function chatCompletionStreaming(
  messages: ChatMessage[],
  options: InferenceOptions = {},
): Promise<StreamingResult> {
  return withInferenceLock(() => chatCompletionStreamingInner(messages, options));
}

/**
 * Pull a human-readable message out of an OpenAI-style mid-stream error
 * payload (`data: {"error":{...}}`). Returns undefined when the chunk carries
 * no error, so callers can treat a truthy result as "the backend failed".
 */
function extractStreamError(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const err = (json as { error?: unknown }).error;
  if (!err) return undefined;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return JSON.stringify(err);
}

/** Get the first loaded model's info for context-aware defaults. */
async function getActiveModel(): Promise<ModelInfo | null> {
  try {
    const models = await listModelsRaw();
    return models.find((m: ModelInfo) => m.state === 'loaded') ?? models[0] ?? null;
  } catch { return null; }
}

async function chatCompletionStreamingInner(
  messages: ChatMessage[],
  options: InferenceOptions = {},
): Promise<StreamingResult> {
  // Resolve active model once — we use it for both context-aware max_tokens
  // and for auto-injecting the model field when the caller didn't specify one.
  // Ollama returns HTTP 400 ("model is required") if the field is absent;
  // LM Studio accepts an empty field and picks the loaded default. Resolving
  // eagerly makes the two backends behave identically from the caller's POV.
  let resolvedModel: string | undefined = options.model || LM_MODEL || undefined;
  let activeModelCached: ModelInfo | null = null;
  const resolveActive = async () => {
    if (activeModelCached === null) activeModelCached = await getActiveModel();
    return activeModelCached;
  };
  if (!resolvedModel) {
    const active = await resolveActive();
    if (active) resolvedModel = active.id;
  }

  // Derive max_tokens from the model's actual context window when not explicitly set.
  // Uses 25% of context as a generous output budget (e.g. 262K context → 65K output).
  let contextLen: number | undefined;
  {
    const activeModel = await resolveActive();
    if (activeModel) contextLen = getContextLength(activeModel);
  }
  let effectiveMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!options.maxTokens && contextLen) {
    effectiveMaxTokens = Math.floor(contextLen * 0.25);
  }

  // Never request more output than the context window can hold alongside the
  // prompt — vLLM (and strict OpenAI backends) reject prompt+max_tokens >
  // context with a 400 instead of clamping. Conservative prompt estimate:
  // 1 token ≈ 3 chars, plus per-message overhead.
  const promptChars = messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length),
    0,
  );
  const capToContext = (requested: number): number => {
    if (!contextLen) return requested;
    const cap = contextLen - (Math.ceil(promptChars / 3) + 64 * messages.length + 512);
    // If the prompt alone (over)fills the context, don't mangle the request —
    // let the backend report the real overflow.
    return cap > 0 ? Math.min(requested, cap) : requested;
  };
  effectiveMaxTokens = capToContext(effectiveMaxTokens);

  const body: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: effectiveMaxTokens,
    // Send max_completion_tokens alongside max_tokens for OpenAI reasoning-model
    // compatibility (OpenAI spec distinguishes total generation cap from visible
    // output cap). Backends that don't understand it ignore unknown fields.
    max_completion_tokens: effectiveMaxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (resolvedModel) {
    body.model = resolvedModel;
  }
  if (options.responseFormat) {
    body.response_format = options.responseFormat;
  }

  // Optional sampling controls — forwarded only when the caller set them (already
  // range-validated in extractSamplingParams). Backends ignore unknown fields, so
  // sending e.g. top_k to one that doesn't support it is harmless.
  const s = options.sampling;
  if (s) {
    if (s.seed !== undefined) body.seed = s.seed;
    if (s.stop !== undefined) body.stop = s.stop;
    if (s.topP !== undefined) body.top_p = s.topP;
    if (s.topK !== undefined) body.top_k = s.topK;
    if (s.repeatPenalty !== undefined) body.repeat_penalty = s.repeatPenalty;
    if (s.frequencyPenalty !== undefined) body.frequency_penalty = s.frequencyPenalty;
    if (s.presencePenalty !== undefined) body.presence_penalty = s.presencePenalty;
  }

  // Handle thinking/reasoning models.
  // Some models (Gemma 4, Qwen3, DeepSeek R1, Nemotron, gpt-oss) have extended
  // thinking that consumes part of the max_tokens budget for invisible reasoning
  // before producing content. Strategy:
  //   1. reasoning_effort=<family-specific value> to minimise reasoning
  //   2. enable_thinking:false — Qwen3 vendor param (ignored elsewhere)
  //   3. inflate max_tokens 4× — safety net when both flags are ignored
  //      (e.g. Gemma 4 hardcodes enable_thinking=true in its Jinja template)
  //
  // IMPORTANT: reasoning_effort values are NOT standard. OpenAI/gpt-oss use
  // 'low'|'medium'|'high'; Ollama adds 'none'; LM Studio's Nemotron adapter
  // only accepts 'on'|'off'. Sending 'low' to Nemotron causes LM Studio to
  // silently fall back to 'on' — maximising reasoning, the OPPOSITE of intent.
  // Hence the family-specific mapping below. When uncertain, we omit the
  // field entirely rather than risk a bad-value fallback.
  const modelId = (resolvedModel || '').toString();
  const profile = getProviderProfile();
  // Populated on the modelId branch below; stays undefined on the OpenRouter
  // branch and when modelId is empty (see the JSDoc on StreamingResult).
  let thinkingDecision: ThinkingDecision | undefined;

  if (profile.reasoningStyle === 'openrouter-field') {
    // OpenRouter exposes reasoning as a separate response field and takes a
    // per-request `reasoning: { exclude: true }` param to suppress it at the
    // source. We don't expose a thinking channel to MCP clients, so exclude
    // is the cleanest option. We still inflate max_tokens because some
    // providers bill/count reasoning tokens against the cap before exclude
    // filtering — and because `exclude` only hides reasoning, it doesn't
    // guarantee the model generates less of it.
    body.reasoning = { exclude: true };
    const beforeInflation = effectiveMaxTokens;
    const inflated = capToContext(Math.max(beforeInflation * 4, beforeInflation + 2000));
    body.max_tokens = inflated;
    body.max_completion_tokens = inflated;
    process.stderr.write(`[houtini-lm] OpenRouter model ${modelId || '(unspecified)'}: reasoning.exclude=true, max_tokens inflated ${beforeInflation} → ${inflated}\n`);
  } else if (modelId) {
    const thinking = await getThinkingSupport(modelId);
    // HF-metadata detection can't see vLLM's arbitrary served-names (e.g. an
    // endpoint that serves "coder-next" instead of the real Qwen3-Coder-Next id),
    // so a genuine thinking model looks non-thinking and the no-think toggle
    // never fires — the answer then lands in reasoning_content with empty content.
    // HOUTINI_LM_THINKING=off forces no-think for every call regardless of
    // detection (correct when an orchestrator does the reasoning and the local
    // model only executes) and always wins over 'on' or a per-call force —
    // see thinking-mode.ts. HOUTINI_LM_THINKING=on forces thinking ON for
    // toggle-capable models. unset/'auto' keeps automatic detection: suppress
    // when the model is known to support a toggle, leave alone otherwise.
    const thinkingMode = (process.env.HOUTINI_LM_THINKING || 'auto').toLowerCase();
    thinkingDecision = resolveThinkingDecision({
      envMode: thinkingMode,
      forceThinking: options.forceThinking,
      supportsThinkingToggle: thinking?.supportsThinkingToggle,
    });
    if (thinkingDecision === 'suppress-env' || thinkingDecision === 'suppress-auto') {
      body.enable_thinking = false;
      // vLLM's OpenAI server ONLY honours the toggle when it is nested inside
      // chat_template_kwargs; a top-level enable_thinking is silently dropped
      // (LM Studio / Ollama accept the top-level form). Without this, vLLM
      // thinking models (Qwen3.6, Qwen3-Coder-Next) return the answer in
      // reasoning_content with empty content. Send both shapes for portability.
      body.chat_template_kwargs = { ...(body.chat_template_kwargs as Record<string, unknown> | undefined), enable_thinking: false };
      const reasoningValue = getReasoningEffortValue(modelId);
      if (reasoningValue !== null) {
        body.reasoning_effort = reasoningValue;
      }
      // Inflation uses effectiveMaxTokens (the context-aware value), not
      // DEFAULT_MAX_TOKENS — otherwise big-context models get sized down.
      const beforeInflation = effectiveMaxTokens;
      const inflated = capToContext(Math.max(beforeInflation * 4, beforeInflation + 2000));
      body.max_tokens = inflated;
      body.max_completion_tokens = inflated;
      process.stderr.write(`[houtini-lm] Thinking model ${modelId}: reasoning_effort=${reasoningValue ?? '(omitted)'}, enable_thinking=false, max_tokens inflated ${beforeInflation} → ${inflated}\n`);
    } else if (thinkingDecision === 'force') {
      // Only send a positive toggle when the model is actually known to
      // accept one — gated the same way suppression is above.
      const toggleSent = thinking?.supportsThinkingToggle === true;
      if (toggleSent) {
        body.enable_thinking = true;
        body.chat_template_kwargs = { ...(body.chat_template_kwargs as Record<string, unknown> | undefined), enable_thinking: true };
      }
      // No reasoning_effort here: getReasoningEffortValue() only returns
      // suppression-oriented values ('none'/'low'), which would fight a
      // force. Still inflate the budget — forced reasoning consumes part of
      // it before any visible content, the same risk the suppression path
      // guards against, just for the opposite reason (deliberate here, not
      // a vendor quirk ignoring the toggle).
      const beforeInflation = effectiveMaxTokens;
      const inflated = capToContext(Math.max(beforeInflation * 4, beforeInflation + 2000));
      body.max_tokens = inflated;
      body.max_completion_tokens = inflated;
      const forceTrigger = thinkingMode === 'on' ? 'env HOUTINI_LM_THINKING=on' : 'per-call force_thinking=true';
      process.stderr.write(`[houtini-lm] Thinking model ${modelId}: thinking FORCED ON (${forceTrigger}), enable_thinking=${toggleSent ? 'true' : '(omitted — model has no known toggle)'}, reasoning_effort=(omitted), max_tokens inflated ${beforeInflation} → ${inflated}\n`);
    }
  }

  const startTime = Date.now();

  // Progress-notification plumbing lifted ABOVE the fetch so we can keep the
  // MCP client's request timeout alive during the HTTP handshake with the
  // upstream LLM. On slow backends (big prompt, heavy prefill, cold model)
  // the POST to /v1/chat/completions can sit for 30-60+ seconds before the
  // response headers flush — that window used to be silent and would trip
  // the client's 60s default timeout before any SSE chunk reached us.
  let progressSeq = 0;
  const notify: ProgressNotifier = options.sendNotification ?? ((n) => server.notification(n));
  const sendProgress = (message: string) => {
    if (options.progressToken === undefined) return;
    progressSeq++;
    notify({
      method: 'notifications/progress',
      params: {
        progressToken: options.progressToken,
        progress: progressSeq,
        message,
      },
    }).catch(() => { /* best-effort — don't break streaming */ });
  };

  // Throttled variant for the per-delta streaming updates. Streaming fires a
  // progress event on every content/reasoning chunk; on a fast model (e.g.
  // 145 tok/s) that would be ~145 JSON-RPC notifications/sec over stdio,
  // flooding the transport and the client's notification handler. Gate those
  // on a time interval so the notification rate is decoupled from the token
  // rate — slow models still update often, fast models emit at most one ping
  // per interval. The immediate connect ping and the interval keepalives below
  // bypass this deliberately.
  let lastStreamProgressMs = 0;
  const sendStreamProgress = (message: string) => {
    const now = Date.now();
    if (now - lastStreamProgressMs < STREAM_PROGRESS_THROTTLE_MS) return;
    lastStreamProgressMs = now;
    sendProgress(message);
  };

  // Ping once immediately — resets the client's timeout clock as soon as the
  // tool call is acknowledged server-side, regardless of how long prefill or
  // the upstream handshake takes.
  sendProgress('Connecting to model...');

  // Cross-process inference serialisation (local single-model backends only).
  // Acquire BEFORE the request so only one process at a time drives the model;
  // the in-process semaphore already gates same-process calls, so this only ever
  // contends across processes. Keepalive via sendProgress during the wait so a
  // queued call doesn't sit silent past the client's request timeout. Fail-open:
  // the lock module returns a no-op release on error or after the wait cap.
  const canKeepalive = options.progressToken !== undefined;
  const releaseInferenceLock = shouldSerialiseInference()
    ? await acquireInferenceLock({
        onWait: canKeepalive
          ? (waitedMs) => sendProgress(`Waiting for the local model — another request is running (${(waitedMs / 1000).toFixed(0)}s)`)
          : undefined,
        // Without a progressToken we can't keep the client alive during a long
        // wait, so fail open well before the typical ~60s client request timeout
        // rather than sit silent in the queue and get aborted. options.lockMaxWaitMs
        // overrides this — async jobs (phase 13) have no progressToken either but
        // also no client timeout to protect, so they pass a much longer budget
        // instead of falling into this 45s default.
        maxWaitMs: options.lockMaxWaitMs ?? (canKeepalive ? undefined : 45_000),
      })
    : () => { /* parallel-friendly backend (e.g. OpenRouter) */ };

  try {

  // Pre-fetch heartbeat — keep the client alive while we wait for the
  // upstream LLM to return response headers. Cleared once fetch resolves.
  const preFetchTimer: ReturnType<typeof setInterval> = setInterval(() => {
    const waitedMs = Date.now() - startTime;
    sendProgress(`Connecting to model... (${(waitedMs / 1000).toFixed(0)}s)`);
  }, PREFILL_KEEPALIVE_MS);

  const issueRequest = (): Promise<Response> =>
    profile.retryOnRateLimit
      ? fetchWithRetry(
          `${LM_BASE_URL}/v1/chat/completions`,
          { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) },
          INFERENCE_CONNECT_TIMEOUT_MS,
          2,
        )
      : fetchWithTimeout(
          `${LM_BASE_URL}/v1/chat/completions`,
          { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) },
          INFERENCE_CONNECT_TIMEOUT_MS,
        );

  let res: Response;
  try {
    res = await issueRequest();

    // Context-overflow self-heal. A strict backend (vLLM) rejects
    // prompt+max_tokens > context with a 400 instead of clamping. This fires
    // when the context we detected via /v1/models is larger than the model
    // actually loaded — classically a proxy (LiteLLM router) advertising a
    // generic window (e.g. 100k) in front of a 64k model. The server states
    // its real limit in the error; parse it, resize the budget, and retry ONCE.
    if (!res.ok && res.status === 400) {
      const errText = await res.text().catch(() => '');
      const realLimit = parseContextOverflow(errText);
      const currentMax = Number(body.max_tokens) || 0;
      const corrected = realLimit
        ? correctedMaxTokens(realLimit, promptChars, messages.length)
        : 0;
      if (realLimit && corrected > 0 && corrected < currentMax) {
        process.stderr.write(
          `[houtini-lm] Backend context is ${realLimit} tokens (smaller than the ${contextLen ?? 'unknown'} we detected — likely a proxy advertising a generic window). max_tokens ${currentMax} → ${corrected}; retrying once.\n`,
        );
        body.max_tokens = corrected;
        body.max_completion_tokens = corrected;
        res = await issueRequest();
      } else {
        // Not a recoverable context overflow — surface the original error.
        throw new Error(`LM Studio API error ${res.status}: ${errText}`);
      }
    }
  } finally {
    clearInterval(preFetchTimer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LM Studio API error ${res.status}: ${text}`);
  }

  if (!res.body) {
    throw new Error('Response body is null — streaming not supported by endpoint');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let reasoning = '';
  let model = '';
  let usage: StreamingResult['usage'];
  let finishReason = '';
  let truncated = false;
  let prefillStall = false;
  let buffer = '';
  let ttftMs: number | undefined;
  let firstChunkReceived = false;
  // Backends (OpenRouter, vLLM, llama.cpp) can emit an error object mid-stream
  // — `data: {"error":{...}}` — then close the connection normally. Without
  // capturing it, the loop parses the payload, matches no field, and returns
  // the partial/empty content as a clean success. Track it so we can surface
  // the real cause instead of silently corrupting the result.
  let streamError: string | undefined;

  // Prefill keep-alive — even after HTTP headers flush, the first SSE chunk
  // can still lag while the model finishes prompt processing. Fire a progress
  // notification every 10s until the first chunk arrives.
  const keepAliveTimer: ReturnType<typeof setInterval> = setInterval(() => {
    if (firstChunkReceived) return;
    const waitedMs = Date.now() - startTime;
    sendProgress(`Waiting for model... (${(waitedMs / 1000).toFixed(0)}s, still in prefill)`);
  }, PREFILL_KEEPALIVE_MS);

  // options.softTimeoutMs/prefillTimeoutMs override the interactive defaults
  // (see InferenceOptions) — undefined by default, reproducing today's
  // behaviour exactly. Async jobs (phase 13) pass job-scoped values instead.
  const effectiveSoftTimeoutMs = options.softTimeoutMs ?? SOFT_TIMEOUT_MS;
  const effectivePrefillTimeoutMs = options.prefillTimeoutMs ?? PREFILL_TIMEOUT_MS;

  try {
    while (true) {
      // Check soft timeout before each read
      const elapsed = Date.now() - startTime;
      if (elapsed > effectiveSoftTimeoutMs) {
        truncated = true;
        process.stderr.write(`[houtini-lm] Soft timeout at ${elapsed}ms, returning ${content.length} chars of partial content\n`);
        break;
      }

      // Split prefill vs mid-stream timeouts. Prefill on slow hardware with
      // a 7k-token input can legitimately take 1-2 min; mid-stream stalls
      // should surface much faster. Track firstChunkReceived to switch.
      const remaining = effectiveSoftTimeoutMs - elapsed;
      const perChunkCeiling = firstChunkReceived ? READ_CHUNK_TIMEOUT_MS : effectivePrefillTimeoutMs;
      const chunkTimeout = Math.min(perChunkCeiling, remaining);
      const result = await timedRead(reader, chunkTimeout);

      if (result === 'timeout') {
        truncated = true;
        prefillStall = !firstChunkReceived;
        process.stderr.write(`[houtini-lm] ${prefillStall ? 'Prefill' : 'Mid-stream'} timeout, returning ${content.length} chars of partial content\n`);
        break;
      }

      if (result.done) break;

      if (!firstChunkReceived) {
        firstChunkReceived = true;
      }

      buffer += decoder.decode(result.value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6));

          // Mid-stream error from the backend — capture the cause and stop.
          // The connection usually closes normally right after, so without
          // this the partial result would be returned as a success.
          const errMsg = extractStreamError(json);
          if (errMsg) {
            streamError = errMsg;
            truncated = true;
            break;
          }

          if (json.model) model = json.model;

          const delta = json.choices?.[0]?.delta;

          // Reasoning channel. Two field names exist in the wild:
          //   - LM Studio (dev toggle "Separate reasoning_content"), DeepSeek R1,
          //     Nemotron       → delta.reasoning_content
          //   - Ollama OpenAI-compat (all thinking models)       → delta.reasoning
          // We capture both so runtime detection and safety-net fallback fire
          // regardless of backend. An Ollama qwen3:4b at low max_tokens
          // previously looked like a broken model — silent empty content —
          // because this channel was dropped.
          const reasoningChunk = (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0)
            ? delta.reasoning_content
            : (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0)
              ? delta.reasoning
              : '';
          if (reasoningChunk) {
            // TTFT = time to first token of ANY channel (true prefill end). For
            // thinking models the first token is reasoning, not content; setting
            // TTFT here keeps the prefill estimator from mistaking the whole
            // reasoning phase for prefill (which caused spurious code_task_files
            // refusals) and keeps the decode-window tok/s denominator consistent.
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            reasoning += reasoningChunk;
            sendStreamProgress(`Thinking... (${reasoning.length} chars of reasoning)`);
          }

          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            content += delta.content;
            sendStreamProgress(`Streaming... ${content.length} chars`);
          }

          const reason = json.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;

          // Some endpoints include usage in the final streaming chunk
          if (json.usage) usage = json.usage;
        } catch {
          // Skip unparseable chunks (partial JSON, comments, etc.)
        }
      }

      // A mid-stream error breaks the inner line loop; also stop reading here
      // rather than waiting out the per-chunk timeout on a connection the
      // backend is about to close.
      if (streamError) break;
    }

    // Flush remaining buffer — the usage chunk often arrives in the final SSE
    // message and may not have a trailing newline, leaving it stranded in buffer.
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
        try {
          const json = JSON.parse(trimmed.slice(6));
          const errMsg = extractStreamError(json);
          if (errMsg) {
            streamError = errMsg;
            truncated = true;
          }
          if (json.model) model = json.model;
          const delta = json.choices?.[0]?.delta;
          const finalReasoningChunk = (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0)
            ? delta.reasoning_content
            : (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0)
              ? delta.reasoning
              : '';
          if (finalReasoningChunk) {
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            reasoning += finalReasoningChunk;
          }
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            if (ttftMs === undefined) ttftMs = Date.now() - startTime;
            content += delta.content;
          }
          const reason = json.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;
          if (json.usage) usage = json.usage;
        } catch (e) {
          // Incomplete JSON in final buffer — log for diagnostics
          process.stderr.write(`[houtini-lm] Unflushed buffer parse failed (${buffer.length} bytes): ${e}\n`);
        }
      }
    }
  } finally {
    clearInterval(keepAliveTimer);
    // Best-effort cancel with a short timeout — cancel() can hang if the upstream
    // connection is wedged, so we race it against a 500ms timer. This frees the
    // underlying socket sooner on abrupt client disconnects without blocking the
    // tool response path.
    try {
      await Promise.race([
        reader.cancel().catch(() => { /* ignore */ }),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    } catch { /* never propagate cleanup errors */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const generationMs = Date.now() - startTime;

  // Backend failed mid-stream and produced nothing usable — surface the real
  // cause as an error rather than returning an empty "success" the orchestrator
  // would treat as a valid (empty) answer. When partial content did arrive we
  // keep it but carry streamError through so the footer flags it.
  if (streamError && !content.trim() && !reasoning.trim()) {
    throw new Error(`Upstream model error mid-stream: ${streamError}`);
  }

  // Strip <think>...</think> reasoning blocks from models that always emit them
  // inline on the content channel (e.g. GLM Flash, Ollama Qwen3) — including a
  // model whose thinking was force_thinking'd on for this call but that has no
  // separate reasoning channel, so it thinks inline instead. Stripped from the
  // visible answer by default — but captured into capturedThinkBlocks so
  // include_reasoning can surface it on request (see reasoningContent below).
  // Handle three shapes:
  //   1. Balanced  <think>...</think>  — GLM Flash, Nemotron normal case
  //   2. Orphan opener <think>... (truncated)
  //   3. Orphan closer ...</think>  — Ollama Qwen3 streams reasoning directly
  //      on the content channel and terminates with a bare </think> before the
  //      real answer. Strip everything up to and including the first closer.
  const thinkProfile = await getThinkingSupport(modelId).catch(() => null);
  const capturedThinkBlocks: string[] = [];
  let cleanContent = content.replace(/<think>([\s\S]*?)<\/think>\s*/g, (_m, inner: string) => {
    capturedThinkBlocks.push(inner);
    return '';
  });   // closed blocks
  cleanContent = cleanContent.replace(/^<think>\s*/, '');                    // orphaned opening tag — body stays in content, not captured
  // Orphaned closing tag: reasoning streamed on the content channel then a bare
  // </think> before the answer (Ollama Qwen3). Strip up to the first closer ONLY
  // for models KNOWN to emit think blocks (per the cached profile). For any other
  // model, leave it: a real answer that merely quotes "</think>" would otherwise
  // be truncated — and a leaked reasoning prefix (visible, recoverable) is a far
  // safer failure than deleting answer text (silent, unrecoverable). The earlier
  // backtick heuristic was lose-lose (leaked reasoning containing code, still
  // deleted answers with an unquoted literal); the profile flag is the right signal.
  if (thinkProfile?.emitsThinkBlocks && cleanContent.includes('</think>')) {
    cleanContent = cleanContent.replace(/^([\s\S]*?)<\/think>\s*/, (_m, inner: string) => {
      capturedThinkBlocks.push(inner);
      return '';
    });
  }
  cleanContent = cleanContent.trim();

  // Safety nets for empty visible output. Try in order:
  //   1. thinkStripFallback: stripping <think> left nothing, but raw content had text
  //   2. reasoningFallback: no visible content AT ALL, but reasoning_content was streamed
  //      (this is the Nemotron/DeepSeek-R1/LM-Studio-dev-toggle case — previously
  //      produced silent empty bodies because reasoning was discarded)
  let thinkStripFallback = false;
  let reasoningFallback = false;
  if (!cleanContent) {
    if (content.trim()) {
      thinkStripFallback = true;
      cleanContent = content.trim();
    } else if (reasoning.trim()) {
      reasoningFallback = true;
      cleanContent =
        '[No visible output — the model spent its entire output budget on reasoning_content before emitting any content. ' +
        'Raw reasoning below so you can see what it was doing:]\n\n' +
        reasoning.trim();
    }
  }

  return {
    content: cleanContent,
    rawContent: content,
    // Separate-channel reasoning (delta.reasoning_content / delta.reasoning) wins
    // when present; otherwise fall back to captured <think> blocks. Never both —
    // a model that somehow emits both is treated as if only the channel fired.
    reasoningContent: reasoning || (capturedThinkBlocks.length > 0 ? capturedThinkBlocks.join('\n\n') : undefined),
    model,
    usage,
    finishReason,
    truncated,
    ttftMs,
    generationMs,
    thinkStripFallback,
    reasoningFallback,
    prefillStall,
    streamError,
    thinkingDecision,
  };

  } finally {
    releaseInferenceLock();
  }
}

// Backend detection. Probed once on first listModelsRaw() call, cached for
// the session. We keep inference on the portable /v1/chat/completions path
// regardless of backend — this flag is for enrichment (richer model metadata,
// accurate "it's LM Studio, so the dev-toggle for reasoning_content matters"
// hints in diagnostics, etc.).
type Backend = 'lmstudio' | 'ollama' | 'openai-compat' | 'openrouter';
let detectedBackend: Backend | null = null;

function getBackend(): Backend {
  return detectedBackend ?? 'openai-compat';
}

/**
 * Provider profile — per-backend flags that gate behavioural differences
 * (serialisation, retry, attribution headers, reasoning handling).
 *
 * Keep this minimal. Add flags only when a concrete divergence forces it,
 * not speculatively — today's registry has 2 providers' worth of divergence.
 */
interface ProviderProfile {
  /** Send OpenRouter-style attribution headers (HTTP-Referer, X-Title). */
  extraHeaders: Record<string, string>;
  /** True for local servers that run a single model and should not be
   *  hammered with parallel requests. False for remote providers that
   *  benefit from parallelism. */
  serialiseInference: boolean;
  /** Retry with backoff on 429/5xx for remote providers. */
  retryOnRateLimit: boolean;
  /** How reasoning-model output is returned.
   *   - 'think-blocks': inline `<think>…</think>` in content (local models)
   *   - 'openrouter-field': separate `message.reasoning` field
   *   - 'none': no reasoning handling needed */
  reasoningStyle: 'think-blocks' | 'openrouter-field' | 'none';
}

function getProviderProfile(): ProviderProfile {
  const backend = getBackend();
  const isOpenRouter =
    backend === 'openrouter' ||
    HOUTINI_LM_PROVIDER === 'openrouter' ||
    /openrouter\.ai/i.test(LM_BASE_URL);

  if (isOpenRouter) {
    return {
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/houtini-ai/lm',
        'X-Title': 'houtini-lm',
      },
      serialiseInference: false,
      retryOnRateLimit: true,
      reasoningStyle: 'openrouter-field',
    };
  }

  // Local / OpenAI-compatible defaults.
  return {
    extraHeaders: {},
    serialiseInference: true,
    retryOnRateLimit: false,
    reasoningStyle: 'think-blocks',
  };
}

/**
 * Fetch models with backend-aware probing.
 *   1. LM Studio /api/v0/models — richest metadata, sets backend='lmstudio'
 *   2. Ollama /api/tags           — native list, sets backend='ollama', maps to ModelInfo
 *   3. OpenAI-compatible /v1/models — generic fallback (DeepSeek, vLLM, llama.cpp, OpenRouter)
 */
async function listModelsRaw(): Promise<ModelInfo[]> {
  // OpenRouter short-circuit — no point probing LM Studio/Ollama-specific
  // endpoints. /v1/models returns richer metadata than our fallback path
  // normally exposes: context_length, architecture.input_modalities, pricing.
  const isOpenRouter =
    HOUTINI_LM_PROVIDER === 'openrouter' || /openrouter\.ai/i.test(LM_BASE_URL);
  if (isOpenRouter) {
    const res = await fetchWithTimeout(
      `${LM_BASE_URL}/v1/models`,
      { headers: apiHeaders() },
    );
    if (!res.ok) throw new Error(`Failed to list OpenRouter models: ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{
        id: string;
        name?: string;
        context_length?: number;
        architecture?: { input_modalities?: string[]; output_modalities?: string[] };
      }>;
    };
    detectedBackend = 'openrouter';
    return data.data.map((m) => ({
      id: m.id,
      object: 'model',
      type: 'llm',
      state: 'loaded', // OpenRouter models are always routable
      context_length: m.context_length,
      max_context_length: m.context_length,
      publisher: m.id.includes('/') ? m.id.split('/')[0] : undefined,
    }));
  }

  // Try LM Studio's v0 API first — returns type, arch, publisher, quantization, state
  try {
    const v0 = await fetchWithTimeout(
      `${LM_BASE_URL}/api/v0/models`,
      { headers: apiHeaders() },
    );
    if (v0.ok) {
      const data = (await v0.json()) as { data: ModelInfo[] };
      detectedBackend = 'lmstudio';
      return data.data;
    }
  } catch {
    // v0 not available — fall through
  }

  // Try Ollama's /api/tags next. Shape differs from OpenAI: returns
  // { models: [{ name, model, size, details: { family, parameter_size, ... } }] }
  try {
    const tags = await fetchWithTimeout(
      `${LM_BASE_URL}/api/tags`,
      { headers: apiHeaders() },
    );
    if (tags.ok) {
      const data = (await tags.json()) as {
        models?: Array<{
          name: string;
          model?: string;
          size?: number;
          details?: { family?: string; parameter_size?: string; quantization_level?: string };
        }>;
      };
      if (Array.isArray(data.models)) {
        detectedBackend = 'ollama';
        return data.models.map((m) => ({
          id: m.name,
          object: 'model',
          type: 'llm',
          arch: m.details?.family,
          quantization: m.details?.quantization_level,
          state: 'loaded', // Ollama loads on-demand; treat all listed as available
          publisher: m.name.includes('/') ? m.name.split('/')[0] : undefined,
        }));
      }
    }
  } catch {
    // Not Ollama — fall through
  }

  // Fallback: OpenAI-compatible v1 endpoint (DeepSeek, vLLM, llama.cpp, OpenRouter)
  const res = await fetchWithTimeout(
    `${LM_BASE_URL}/v1/models`,
    { headers: apiHeaders() },
  );
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
  const data = (await res.json()) as { data: ModelInfo[] };
  detectedBackend = 'openai-compat';
  return data.data;
}

function getContextLength(model: ModelInfo): number {
  // Prefer loaded_context_length (actual configured context) over max_context_length (theoretical max)
  // v0 API: loaded_context_length / max_context_length, v1: context_length, vLLM: max_model_len
  return model.loaded_context_length ?? model.max_context_length ?? model.context_length ?? model.max_model_len ?? FALLBACK_CONTEXT_LENGTH;
}

function getMaxContextLength(model: ModelInfo): number | undefined {
  return model.max_context_length;
}

/**
 * Map model family / backend → reasoning_effort value that minimises reasoning.
 *
 * The `reasoning_effort` field exists across OpenAI, Ollama, LM Studio and
 * DeepSeek, but the accepted values differ per vendor. Verified empirically
 * from the LM Studio error response: "Supported values: none, minimal, low,
 * medium, high, xhigh" (that's the set the LM Studio adapter accepts).
 *
 *   OpenAI (gpt-5, o-series)        : 'low' | 'medium' | 'high' (spec)
 *   Ollama                          : 'low' | 'medium' | 'high' | 'none'
 *   LM Studio (all models)          : 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
 *
 * We want the HARDEST off-switch we can portably send:
 *   - LM Studio / Ollama: 'none'  (no reasoning budget at all)
 *   - Generic OpenAI-compat: 'low' (OpenAI's minimum, safe to send)
 *
 * An unsupported value is a hard 400 error on LM Studio (not a silent
 * fallback), so this function is conservative — it returns null for
 * unknown backends and we omit the field rather than risk a 400.
 */
function getReasoningEffortValue(_modelId: string): string | null {
  const backend = getBackend();
  // LM Studio accepts 'none' as an explicit reasoning-off switch for
  // every thinking model (Nemotron, DeepSeek R1, Gemma 4, gpt-oss, ...).
  if (backend === 'lmstudio') return 'none';
  // Ollama likewise documents 'none' as valid.
  if (backend === 'ollama') return 'none';
  // Generic OpenAI-compatible — 'low' is the minimum OpenAI accepts per spec.
  // DeepSeek's own API treats 'low' as minimum too.
  return 'low';
}

/** Rough chars→tokens ratio used for pre-flight estimates. Matches the ratio
 * we already use to estimate completion_tokens when usage is missing. */
const CHARS_PER_TOKEN = 4;

/** Conservative default prefill rate when no per-model measurement exists.
 * Slower than real hardware so we err toward letting the call run — a false
 * refusal is much worse than a false-ok that eventually times out. */
const DEFAULT_PREFILL_TOK_PER_SEC = 300;

/** Hard ceiling for when we refuse to send the call. Leaves ~15s of
 * generation headroom inside the ~60s MCP-client request-timeout budget. */
const PREFILL_REFUSE_THRESHOLD_SEC = 45;

/** Soft warning threshold — we proceed but log a stderr warning. */
const PREFILL_WARN_THRESHOLD_SEC = 25;

interface PrefillEstimate {
  inputTokens: number;
  estimatedSeconds: number;
  /** Description of which method produced the estimate. */
  basis: 'linear-fit' | 'ratio' | 'default';
  /** Linear fit stats when basis === 'linear-fit'. */
  fit?: { alphaMs: number; betaMsPerToken: number; r2: number; n: number };
  /** Ratio rate when basis === 'ratio' (fallback). */
  prefillTokPerSec?: number;
}

/**
 * Estimate prompt prefill time. Preferred method is a linear regression
 * `TTFT ≈ α + β·prompt_tokens` over recent per-model samples — this separates
 * fixed per-request overhead (α) from genuine per-token prefill cost (β) and
 * avoids the under-prediction that a ratio-of-averages estimator produces
 * when the current input is much larger than the historical mean.
 *
 * Falls back to the ratio estimator when we have fewer than
 * PREFILL_FIT_MIN_SAMPLES points, and to a conservative default
 * (DEFAULT_PREFILL_TOK_PER_SEC) when no measured data exists at all.
 */
async function estimatePrefill(inputChars: number, modelId: string): Promise<PrefillEstimate> {
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);

  // 1. Linear fit over recent samples (preferred); 2. ratio fallback from the
  // SAME samples when there aren't enough for a fit. Both use the per-call
  // (promptTokens, ttft) pairs, so the ratio can't mix populations the way the
  // old aggregate did (avg prompt tokens over all calls vs avg TTFT over only
  // TTFT-bearing calls), which skewed the rate and mis-fired the refusal guard.
  try {
    const samples = await getPrefillSamples(modelId);
    const fit = fitPrefillLinear(samples);
    if (fit) {
      const estimatedMs = Math.max(0, fit.alphaMs + fit.betaMsPerToken * inputTokens);
      return {
        inputTokens,
        estimatedSeconds: estimatedMs / 1000,
        basis: 'linear-fit',
        fit,
      };
    }
    if (samples.length >= 2) {
      const sumPrompt = samples.reduce((a, s) => a + s.promptTokens, 0);
      const sumTtftMs = samples.reduce((a, s) => a + s.ttftMs, 0);
      if (sumPrompt > 0 && sumTtftMs > 0) {
        const prefillTokPerSec = sumPrompt / (sumTtftMs / 1000);
        return {
          inputTokens,
          estimatedSeconds: inputTokens / prefillTokPerSec,
          basis: 'ratio',
          prefillTokPerSec,
        };
      }
    }
  } catch {
    // Sample fetch failed — fall through to the conservative default.
  }

  // 3. Conservative default for unknown model/hardware.
  return {
    inputTokens,
    estimatedSeconds: inputTokens / DEFAULT_PREFILL_TOK_PER_SEC,
    basis: 'default',
    prefillTokPerSec: DEFAULT_PREFILL_TOK_PER_SEC,
  };
}

// ── Model routing ─────────────────────────────────────────────────────
// Picks the best loaded model for a given task type.
// If only one model is loaded, uses it but may suggest a better one.
// If multiple are loaded, routes to the best match.

type TaskType = 'code' | 'chat' | 'analysis' | 'embedding';

interface RoutingDecision {
  modelId: string;
  hints: PromptHints;
  suggestion?: string;  // info about routing decision
}

async function routeToModel(taskType: TaskType, override?: string): Promise<RoutingDecision> {
  // Explicit override wins over routing. Honoured regardless of whether we
  // can even list models — useful for remote providers (OpenRouter) where
  // the user knows the model id and doesn't want routing to second-guess.
  const pinned = override || LM_MODEL;
  if (pinned) {
    const hints = getPromptHints(pinned);
    return { modelId: pinned, hints };
  }

  let models: ModelInfo[];
  try {
    models = await listModelsRaw();
  } catch {
    // Can't reach server — fall back to default (empty string; caller handles)
    const hints = getPromptHints(LM_MODEL);
    return { modelId: LM_MODEL || '', hints };
  }

  const loaded = models.filter((m) => m.state === 'loaded' || !m.state);
  const available = models.filter((m) => m.state === 'not-loaded');

  if (loaded.length === 0) {
    const hints = getPromptHints(LM_MODEL);
    return { modelId: LM_MODEL || '', hints };
  }

  // Score each loaded model for the requested task type
  let bestModel = loaded[0];
  let bestScore = -1;

  for (const model of loaded) {
    const hints = getPromptHints(model.id, model.arch);
    // Primary: is this task type in the model's best types?
    let score = (hints.bestTaskTypes ?? []).includes(taskType) ? 10 : 0;
    // Bonus: code-specialised models get extra points for code tasks
    const profile = getModelProfile(model);
    if (taskType === 'code' && profile?.family.toLowerCase().includes('coder')) score += 5;
    // Bonus: larger context for analysis tasks
    if (taskType === 'analysis') {
      const ctx = getContextLength(model);
      if (ctx && ctx > 100000) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestModel = model;
    }
  }

  const hints = getPromptHints(bestModel.id, bestModel.arch);
  const result: RoutingDecision = { modelId: bestModel.id, hints };

  // If the best loaded model isn't ideal for this task, suggest a better available one.
  // We don't JIT-load because model loading takes minutes and the MCP SDK has a ~60s
  // hard timeout. Instead, suggest the user loads the better model in LM Studio.
  if (!(hints.bestTaskTypes ?? []).includes(taskType)) {
    const better = available.find((m) => {
      const mHints = getPromptHints(m.id, m.arch);
      return (mHints.bestTaskTypes ?? []).includes(taskType);
    });
    if (better) {
      const label = taskType === 'code' ? 'code tasks'
        : taskType === 'analysis' ? 'analysis'
        : taskType === 'embedding' ? 'embeddings'
        : 'this kind of task';
      result.suggestion = `💡 ${better.id} is downloaded and better suited for ${label} — ask the user to load it in LM Studio.`;
    }
  }

  return result;
}

// ── Quality metadata ─────────────────────────────────────────────────
// Provides structured quality signals in every response so Claude (or any
// orchestrator) can make informed trust decisions about the local LLM output.
// Addresses: GitHub issue #3 (automated quality checks), dev.to feedback
// on leaked think-blocks and token offload metrics as routing feedback.

interface QualitySignal {
  truncated: boolean;
  prefillStall: boolean;       // truncation occurred before any chunk arrived
  finishReason: string;
  thinkBlocksStripped: boolean;
  thinkStripFallback: boolean;  // strip emptied content; returning raw as fallback
  reasoningFallback: boolean;   // no visible content; returning raw reasoning_content
  estimatedTokens: boolean;   // true when usage was missing and we estimated
  contentLength: number;
  generationMs: number;
  tokPerSec: number | null;
}

function assessQuality(resp: StreamingResult, rawContent: string): QualitySignal {
  const hadThinkBlocks = /<think>/.test(rawContent);
  const estimated = !resp.usage && resp.content.length > 0;
  const tokPerSec = computeTokPerSec(resp);

  return {
    truncated: resp.truncated,
    prefillStall: resp.prefillStall ?? false,
    finishReason: resp.finishReason || 'unknown',
    thinkBlocksStripped: hadThinkBlocks,
    thinkStripFallback: resp.thinkStripFallback ?? false,
    reasoningFallback: resp.reasoningFallback ?? false,
    estimatedTokens: estimated,
    contentLength: resp.content.length,
    generationMs: resp.generationMs,
    tokPerSec,
  };
}

function formatQualityLine(quality: QualitySignal): string {
  const flags: string[] = [];
  if (quality.prefillStall) flags.push('PREFILL-STALL (no tokens received — input may be too large for this model/hardware)');
  else if (quality.truncated) flags.push('TRUNCATED');
  if (quality.reasoningFallback) flags.push('reasoning-only (model exhausted output budget before emitting visible content — showing raw reasoning)');
  else if (quality.thinkStripFallback) flags.push('think-strip-empty (showing raw reasoning — model ignored enable_thinking:false)');
  else if (quality.thinkBlocksStripped) flags.push('think-blocks-stripped');
  if (quality.estimatedTokens) flags.push('tokens-estimated');
  if (quality.finishReason === 'length') flags.push('hit-max-tokens');
  // content_filter is a REFUSAL, not a truncation — the orchestrator should
  // handle it differently (don't retry with a bigger budget). Surface distinctly.
  if (quality.finishReason === 'content_filter') flags.push('CONTENT-FILTERED (model refused/blocked — not a length cut)');
  if (flags.length === 0) return '';
  return `Quality: ${flags.join(', ')}`;
}

/**
 * Format a footer line for streaming results showing model, usage, and truncation status.
 *
 * Layout:
 *   ---
 *   Model: ... | prompt→completion tokens | perf | extra | quality
 *   📊 [first-call benchmark line, only on the first measured call per model]
 *   💰 Claude quota saved this session: ...
 */
function formatFooter(resp: StreamingResult, extra?: string): string {
  // Record usage for session tracking before formatting
  recordUsage(resp);

  const parts: string[] = [];
  if (resp.model) parts.push(`Model: ${resp.model}`);
  if (resp.usage) {
    // OpenAI-spec reasoning-tokens split — when present, show it so the user
    // sees how much of the completion budget went to hidden reasoning vs
    // visible output. Diagnoses "empty body + hit-max-tokens" immediately.
    const reasoningTokens = resp.usage.completion_tokens_details?.reasoning_tokens;
    if (typeof reasoningTokens === 'number' && reasoningTokens > 0) {
      const visible = resp.usage.completion_tokens - reasoningTokens;
      parts.push(`${resp.usage.prompt_tokens}→${resp.usage.completion_tokens} tokens (${reasoningTokens} reasoning / ${visible} visible)`);
    } else {
      parts.push(`${resp.usage.prompt_tokens}→${resp.usage.completion_tokens} tokens`);
    }
    // Prefix-cache (KV reuse) hits — a strong "this delegation was nearly free"
    // signal for the orchestrator when it re-sends shared context.
    const cached = resp.usage.prompt_tokens_details?.cached_tokens;
    if (typeof cached === 'number' && cached > 0) {
      parts.push(`${cached} prompt tokens cached`);
    }
  } else if (resp.content.length > 0) {
    // Estimate when usage is missing (truncated responses where final SSE chunk was lost)
    const estTokens = Math.ceil(resp.content.length / 4);
    parts.push(`~${estTokens} tokens (estimated)`);
  }

  // Perf stats — computed from streaming, no proprietary API needed
  const perfParts: string[] = [];
  if (resp.ttftMs !== undefined) perfParts.push(`TTFT: ${resp.ttftMs}ms`);
  let tokPerSec = 0;
  const measuredTokPerSec = computeTokPerSec(resp);
  if (measuredTokPerSec !== null) {
    tokPerSec = measuredTokPerSec;
    perfParts.push(`${tokPerSec.toFixed(1)} tok/s`);
  }
  if (resp.generationMs) perfParts.push(`${(resp.generationMs / 1000).toFixed(1)}s`);
  if (perfParts.length > 0) parts.push(perfParts.join(', '));

  if (extra) parts.push(extra);

  // Quality signals — structured metadata for orchestrator trust decisions
  const quality = assessQuality(resp, resp.rawContent);
  const qualityLine = formatQualityLine(quality);
  if (qualityLine) parts.push(qualityLine);
  if (resp.streamError) parts.push(`⚠ UPSTREAM ERROR (partial result — backend reported: ${resp.streamError})`);
  else if (resp.truncated) parts.push('⚠ TRUNCATED (soft timeout — partial result)');

  const benchmarkLine = isFirstBenchmarkedCall(resp.model, tokPerSec)
    ? `📊 First measured call on ${resp.model}: ${tokPerSec.toFixed(1)} tok/s${resp.ttftMs !== undefined ? `, ${resp.ttftMs}ms to first token` : ''} — use this to gauge whether to delegate longer tasks.`
    : '';
  const sessionLine = sessionSummary();

  if (parts.length === 0 && !benchmarkLine && !sessionLine) return '';

  const lines: string[] = [`\n\n---${parts.length > 0 ? `\n${parts.join(' | ')}` : ''}`];
  // First-call speed benchmark — surfaced once per model per session, based on
  // the real task just completed (not a synthetic warmup). Gives Claude honest
  // speed data to calibrate future delegation decisions.
  if (benchmarkLine) lines.push(benchmarkLine);
  // Session savings — on its own line so it reads as value, not as accounting.
  if (sessionLine) lines.push(sessionLine);

  return lines.join('\n');
}

// ── MCP Tool definitions ─────────────────────────────────────────────

// Optional sampling controls shared by the inference tools. Out-of-range values
// are dropped server-side (extractSamplingParams), so the backend default applies.
const SAMPLING_PROPS = {
  seed: { type: 'integer', description: 'Deterministic sampling seed — same seed + same prompt → reproducible output. Useful for testing.' },
  stop: { type: ['string', 'array'], items: { type: 'string' }, description: 'Stop sequence(s) — generation halts when one is produced (up to 4).' },
  top_p: { type: 'number', description: 'Nucleus sampling 0–1 (e.g. 0.9). Lower = more focused. Alternative to temperature.' },
  top_k: { type: 'integer', description: 'Sample only from the top-K tokens (e.g. 40). 0/omitted = disabled.' },
  repeat_penalty: { type: 'number', description: 'Penalise repetition, 0–2 (1 = off, ~1.1 typical).' },
  frequency_penalty: { type: 'number', description: 'OpenAI-style frequency penalty, -2 to 2.' },
  presence_penalty: { type: 'number', description: 'OpenAI-style presence penalty, -2 to 2.' },
} as const;

// Shared across the four inference tools so the flags' wording and behaviour
// stay identical everywhere (see formatReasoningBlock in reasoning-block.ts
// and resolveThinkingDecision in thinking-mode.ts).
const REASONING_PROPS = {
  include_reasoning: {
    type: 'boolean',
    description:
      'When true and the model actually produced reasoning, append it after the answer, ' +
      'delimited from the final response, so the conclusion can be verified. ' +
      'Default false — omitted or false keeps the response compact, unchanged from current behaviour. ' +
      'Reasoning can run to thousands or tens of thousands of tokens, so only set this when checking ' +
      'how a conclusion was reached matters. Does not make the model reason on its own — most routed models ' +
      'have their thinking suppressed automatically, so pair this with force_thinking: true to actually get any.',
  },
  force_thinking: {
    type: 'boolean',
    description:
      'Default false. When true, disables the server\'s automatic thinking suppression for this one call so ' +
      'the model actually thinks — increasing latency and generated tokens. Pair with include_reasoning: true ' +
      'to see the result; force_thinking alone still returns only the final answer. Ignored (no-op) when the ' +
      'server is run with HOUTINI_LM_THINKING=off — that is an operator-level setting a single call cannot ' +
      'override. Currently has no effect on OpenRouter-routed calls.',
  },
} as const;

// Result of folding a tool call's start_conversation/conversation_id args
// through resolveConversation() below. 'none' covers both "the caller opted
// out entirely" and "the caller passed start_conversation: false with no
// conversation_id" — in both cases there is no active conversation and the
// caller proceeds exactly as it would with the params omitted.
type ConversationContext =
  | { kind: 'none' }
  | { kind: 'error'; result: CallToolResult }
  | { kind: 'active'; owner: string; id: string; history: ConversationTurn[]; startIgnoredNote: string };

// Shared verbatim between resolveConversation() below and every other call
// site that needs to know whether server-side conversations are turned on
// at all — one literal, so the wording can never drift between them.
const CONVERSATIONS_DISABLED_MESSAGE = 'Error: server-side conversations are disabled on this houtini-lm instance.';

// Result of resolveConversationOwner()/resolveJobOwner() below: either the
// owner key this caller is scoped to, or the isError result to return
// unchanged because no owner could be resolved (HTTP with no MCP session —
// see resolveOwnerKey() for why this never falls back to a shared key).
type ConversationOwner = { kind: 'owner'; owner: string } | { kind: 'error'; result: CallToolResult };

// Result of resolveOwnerKey() below — the reason-code-only core that
// resolveConversationOwner() and resolveJobOwner() each turn into their own
// feature-appropriate CallToolResult error text.
type OwnerKeyResult = { kind: 'owner'; owner: string } | { kind: 'error'; reason: 'header-unusable' | 'no-session' };

// resolveOwnerKey()'s header-mode branch logs "not usable" to stderr at most
// once per process (see that branch below) — this flag is the suppression
// latch. Best-effort only: it's read and written by synchronous code with no
// `await` between the check and the set, so under Node's single-threaded
// event loop it cannot race within one call; a duplicate line across calls
// would be harmless anyway, so no lock is used.
let ownerHeaderWarned = false;

/**
 * Resolve the caller's owner key — the multi-tenant safety boundary shared
 * by server-side conversations (conversation-store.ts) AND async jobs
 * (job-store.ts, phase 13). resolveConversationOwner() (chat/custom_prompt/
 * conversations) and resolveJobOwner() (custom_prompt/code_task_files/jobs,
 * phase 13) both fold through this single function rather than each
 * deriving the owner key independently. Two copies of this logic drifting
 * apart (e.g. one forgetting the "never fall back to a fixed key over HTTP"
 * rule) would be a cross-tenant leak in whichever feature copied it wrong,
 * not a cosmetic bug.
 *
 * Two resolution modes, selected once at startup by whether
 * HOUTINI_LM_CONVERSATION_OWNER_HEADER is set (the env var name predates
 * jobs — phase 13 reuses it rather than introducing a second, since both
 * features need the exact same identity boundary):
 *  - Unset (default): the owner key is the MCP session ID (stdio → the
 *    fixed key "stdio-local"; HTTP → extra.sessionId). This scopes
 *    conversations/jobs to one MCP connection.
 *  - Set: the owner key is the value of the named HTTP request header — a
 *    caller identity a front-end proxy is expected to attach after its own
 *    authentication. This scopes conversations/jobs to that identity across
 *    MCP sessions/connections instead. Neither mode ever falls back to the
 *    other's key on failure — see the header branch below for why that
 *    would defeat the point.
 */
function resolveOwnerKey(extra: HoutiniExtra): OwnerKeyResult {
  // HOUTINI_LM_TRANSPORT is fixed for the whole process, so it's a reliable
  // way to know which resolution applies; never fall back to a fixed key
  // over HTTP, or two different callers could share history.
  if (HOUTINI_LM_TRANSPORT === 'stdio') {
    return { kind: 'owner', owner: 'stdio-local' };
  }

  if (CONVERSATION_OWNER_HEADER !== '') {
    // Header mode. This branch must never fall back to extra.sessionId: a
    // caller that couldn't produce the identity header would then be
    // scoped by MCP session instead, i.e. treated as its own anonymous
    // owner — indistinguishable from a caller that *did* authenticate.
    // That's a spoofing-equivalent hole, so any failure here is terminal
    // (fail closed) rather than falling through to the session-ID branch
    // below. extra.sessionId being unset is not itself an error in this
    // mode — session establishment and owner resolution are independent.
    const raw = extra.requestInfo?.headers[CONVERSATION_OWNER_HEADER];
    // typeof raw !== 'string' also catches the array case (a duplicated
    // header the SDK didn't collapse into one comma-joined string) and the
    // absent-header case — both are "not usable", same as the checks below.
    if (typeof raw !== 'string' || raw.includes(',') || raw.trim() === '' || raw.trim().length > 512) {
      // At most once per process: log the expected header name and every
      // header name that *did* arrive (names only, never values —
      // authorization/cookie values must never reach stderr) so a
      // misconfigured front-end proxy shows up in `docker service logs`
      // instead of a silent wall of "server requires an authenticated user
      // header" errors.
      if (!ownerHeaderWarned) {
        ownerHeaderWarned = true;
        const seen = Object.keys(extra.requestInfo?.headers ?? {}).join(', ');
        process.stderr.write(
          `[houtini-lm] owner header "${CONVERSATION_OWNER_HEADER}" not usable; headers seen: ${seen}\n`,
        );
      }
      return { kind: 'error', reason: 'header-unusable' };
    }
    // "hdr:" separates this mode's key space from the session-ID mode's key
    // space (owner strings are opaque to ConversationStore/JobStore either
    // way, so this is purely a namespacing convention, not a security
    // boundary).
    return { kind: 'owner', owner: `hdr:${raw.trim()}` };
  }

  if (extra.sessionId === undefined) {
    return { kind: 'error', reason: 'no-session' };
  }
  return { kind: 'owner', owner: extra.sessionId };
}

/** resolveOwnerKey() wrapper for server-side conversations — see that function for the shared resolution logic. */
function resolveConversationOwner(extra: HoutiniExtra): ConversationOwner {
  const r = resolveOwnerKey(extra);
  if (r.kind === 'owner') return r;
  const text = r.reason === 'header-unusable'
    ? 'Error: server-side conversations require an authenticated user header on this server.'
    : 'Error: server-side conversations require an MCP session.';
  return { kind: 'error', result: { content: [{ type: 'text', text }], isError: true } };
}

/** resolveOwnerKey() wrapper for async jobs (phase 13) — see that function for the shared resolution logic. */
function resolveJobOwner(extra: HoutiniExtra): ConversationOwner {
  const r = resolveOwnerKey(extra);
  if (r.kind === 'owner') return r;
  const text = r.reason === 'header-unusable'
    ? 'Error: async jobs require an authenticated user header on this server.'
    : 'Error: async jobs require an MCP session.';
  return { kind: 'error', result: { content: [{ type: 'text', text }], isError: true } };
}

/**
 * Resolve a tool call's start_conversation/conversation_id args to a
 * ConversationContext. This is the multi-tenant safety boundary for
 * server-side conversations — see conversation-store.ts's header comment
 * for why owner scoping exists at all — so chat and custom_prompt both
 * fold their args through this single function rather than each deriving
 * the owner key and validating the id independently. Two copies of this
 * logic drifting apart (e.g. one forgetting the "never fall back to a
 * fixed key over HTTP" rule) would be a cross-tenant history leak, not a
 * cosmetic bug.
 */
function resolveConversation(
  start_conversation: boolean | undefined,
  conversation_id: string | undefined,
  extra: HoutiniExtra,
): ConversationContext {
  // Both unspecified → skip every conversation branch below and take the
  // exact code path these tools already had (default behaviour untouched).
  const wantsConversation = start_conversation !== undefined || conversation_id !== undefined;
  if (!wantsConversation) {
    return { kind: 'none' };
  }

  if (!CONVERSATIONS_ENABLED) {
    return {
      kind: 'error',
      result: {
        content: [{ type: 'text', text: CONVERSATIONS_DISABLED_MESSAGE }],
        isError: true,
      },
    };
  }

  const ownerResult = resolveConversationOwner(extra);
  if (ownerResult.kind === 'error') {
    return { kind: 'error', result: ownerResult.result };
  }
  const conversationOwner = ownerResult.owner;

  // conversation_id wins when both are given — start_conversation is
  // simply ignored, noted on the trailing conversation line by the caller.
  let history: ConversationTurn[] = [];
  let activeConversationId: string | undefined;
  let startIgnoredNote = '';
  if (conversation_id !== undefined) {
    const found = conversations.get(conversationOwner, conversation_id);
    if (found === undefined) {
      return {
        kind: 'error',
        result: {
          content: [{
            type: 'text',
            text:
              'Error: this conversation has expired or is not available to you. ' +
              'Start a new one with start_conversation: true.',
          }],
          isError: true,
        },
      };
    }
    history = found;
    activeConversationId = conversation_id;
    if (start_conversation === true) {
      startIgnoredNote = ' start_conversation was ignored — conversation_id was also given.';
    }
  } else if (start_conversation === true) {
    activeConversationId = conversations.create(conversationOwner);
  }

  // wantsConversation was true but neither branch above produced an id —
  // e.g. start_conversation: false with no conversation_id. There's no
  // active conversation to resolve to; proceed as if nothing was passed.
  if (activeConversationId === undefined) {
    return { kind: 'none' };
  }

  return { kind: 'active', owner: conversationOwner, id: activeConversationId, history, startIgnoredNote };
}

/**
 * Append this turn pair (or, for custom_prompt, up to two pairs) to the
 * active conversation and format the trailing line the response gets
 * appended with. Returns '' when there's no active conversation — callers
 * can unconditionally concatenate the result onto their response text.
 *
 * Only the turns passed in are retained — never the reasoning block,
 * footer, or this conversation line itself.
 */
function recordConversationTurns(conv: ConversationContext, turns: ConversationTurn[], extraNote?: string): string {
  if (conv.kind !== 'active') {
    return '';
  }
  conversations.append(conv.owner, conv.id, turns);
  const updated = conversations.get(conv.owner, conv.id) ?? [];
  const chars = updated.reduce((sum, t) => sum + t.content.length, 0);
  return `\n${formatConversationLine(conv.id, updated.length, chars, CONVERSATION_TTL_MIN)}${conv.startIgnoredNote}${extraNote ?? ''}`;
}

// Added to chat's and custom_prompt's inputSchema.properties when
// CONVERSATIONS_ENABLED (see the conditional spreads in TOOLS below). By
// default this server remembers nothing between calls — these two params
// opt a single MCP connection into server-side history so the caller stops
// resending the full transcript. The wording below is tool-neutral ("new
// input") rather than naming chat's `message` param specifically, since
// custom_prompt shares this object and calls its equivalent `instruction`.
const CONVERSATION_PROPS = {
  start_conversation: {
    type: 'boolean',
    description:
      'By default this server remembers nothing between calls — every call is stateless unless you opt in here. ' +
      'Set true to start a new server-side conversation — the id is returned on the last line of the response. ' +
      'On every following call in this conversation, pass that id as conversation_id and send ONLY the new ' +
      'input (the new message for chat, the new instruction for custom_prompt); do not resend prior turns, the ' +
      'server already has them. If the id expires (idle timeout) or stops working, start a new conversation ' +
      'rather than retrying the old id. Use the conversations tool to list or discard conversations you\'ve started.',
  },
  conversation_id: {
    type: 'string',
    description:
      'Continue a conversation previously started with start_conversation: true. Send ONLY the new input (the ' +
      'new message for chat, the new instruction for custom_prompt) — the server prepends the stored history ' +
      'automatically. If both start_conversation and conversation_id are given, conversation_id wins and ' +
      "start_conversation is ignored. For custom_prompt, context is recorded in this history only the first " +
      'time it is sent for a given conversation — resending the identical context on a later call does not ' +
      'duplicate it.',
  },
} as const;

// custom_prompt's context/ack exchange (see the multi-turn comment at its
// call site below) as shared constants, so the string that gets recorded
// into conversation history and the string checked for "was this context
// already recorded" are guaranteed to be the exact same literal.
const CUSTOM_PROMPT_CONTEXT_PREFIX = 'Here is the context for analysis:\n\n';
const CUSTOM_PROMPT_CONTEXT_ACK =
  'Understood. I have read the full context. What would you like me to do with it?';

// Added to custom_prompt's and code_task_files' inputSchema.properties when
// JOBS_ENABLED (see the conditional spreads in TOOLS below) — mirrors the
// CONVERSATION_PROPS conditional spread pattern above. Phase 13: submit the
// call as a background job instead of waiting for the result inline.
const ASYNC_PROPS = {
  async: {
    type: 'boolean',
    description:
      'Submit this call as a background job instead of waiting for the result inline. Returns a job id ' +
      'immediately — poll it with the jobs tool (action: "get", job_id: "..."). Submission itself still takes ' +
      'roughly a second (it resolves model routing first) — "immediately" means no wait for inference, not zero ' +
      'latency. Not currently supported together with start_conversation/conversation_id — this is a scope limit ' +
      'for the initial release, not a technical incompatibility, and may be lifted later; submit without those ' +
      'params when using async: true. Each caller may have only a few jobs pending/running at once ' +
      '(HOUTINI_LM_JOB_ACTIVE_MAX_PER_OWNER on the server) — finish or check on one before submitting another.',
  },
} as const;

// Shared verbatim across custom_prompt's and code_task_files' async: true
// branches (see resolveConversation()'s CONVERSATIONS_DISABLED_MESSAGE for
// the same pattern) — one literal, so the wording can never drift between them.
const JOBS_DISABLED_MESSAGE = 'Error: async jobs are disabled on this houtini-lm instance (HOUTINI_LM_JOBS=0).';
const ASYNC_WITH_CONVERSATION_MESSAGE =
  'Error: async: true does not currently support start_conversation/conversation_id together — this is a scope ' +
  'limit for the initial release, not a technical incompatibility, and may be lifted later. Submit without the ' +
  'conversation params when using async: true, or drop async: true to use a conversation.';

/** Shared "not found or not yours" response for the jobs tool — never distinguishes a nonexistent job_id from one owned by someone else, so a caller can't probe for other owners' jobs. */
const JOB_NOT_FOUND_RESULT: CallToolResult = {
  content: [{ type: 'text', text: 'Error: this job was not found or is not available to you.' }],
  isError: true,
};

/** `jobs.countActive(owner) >= JOB_ACTIVE_MAX_PER_OWNER` guard shared by custom_prompt's and code_task_files' async: true branches. Returns undefined when the caller is under the limit (proceed), else the CallToolResult to return unchanged. */
function jobActiveLimitError(owner: string): CallToolResult | undefined {
  if (jobs.countActive(owner) < JOB_ACTIVE_MAX_PER_OWNER) return undefined;
  return {
    content: [{
      type: 'text',
      text:
        `Error: you already have ${JOB_ACTIVE_MAX_PER_OWNER} active job(s) (pending + running) — the limit for ` +
        `this server (HOUTINI_LM_JOB_ACTIVE_MAX_PER_OWNER). Wait for one to finish, or check on it with the jobs ` +
        `tool, before submitting another.`,
    }],
    isError: true,
  };
}

/**
 * Shared tail of custom_prompt's and code_task_files' synchronous and async
 * (job) paths: call the model and format the response text (content +
 * reasoning block + optional footer suffix). Message construction differs
 * per caller and per sync/async (the sync path threads conversation history
 * through; async never does — see the async: true branches for why) so it
 * stays at each call site; only the inference call + formatting is factored
 * out here — which is also the part that MUST stay byte-identical between a
 * synchronous call and a completed job's result (see the jobs tool's `get`
 * action).
 */
async function runInference(
  messages: ChatMessage[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    model: string;
    responseFormat?: ResponseFormat;
    sampling: SamplingParams;
    forceThinking: boolean;
    includeReasoning: boolean | undefined;
    footerExtra?: string;
    progressToken?: string | number;
    sendNotification?: ProgressNotifier;
    softTimeoutMs?: number;
    prefillTimeoutMs?: number;
    lockMaxWaitMs?: number;
  },
): Promise<{ text: string; resp: StreamingResult }> {
  const resp = await chatCompletionStreaming(messages, {
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    model: opts.model,
    responseFormat: opts.responseFormat,
    progressToken: opts.progressToken,
    sendNotification: opts.sendNotification,
    sampling: opts.sampling,
    forceThinking: opts.forceThinking,
    softTimeoutMs: opts.softTimeoutMs,
    prefillTimeoutMs: opts.prefillTimeoutMs,
    lockMaxWaitMs: opts.lockMaxWaitMs,
  });
  const reasoningBlock = formatReasoningBlock(opts.includeReasoning, resp);
  const footer = formatFooter(resp, opts.footerExtra);
  return { text: resp.content + reasoningBlock + footer, resp };
}

const TOOLS: Tool[] = [
  {
    name: 'chat',
    description:
      'Send a task to a local LLM — a sidekick running on the user\'s hardware or a configured OpenAI-compatible endpoint. ' +
      'It does not consume the user\'s Claude quota. Trades latency for tokens: local inference is typically 3-30× slower than frontier models, so delegation wins when the task is bounded and self-contained.\n\n' +
      'Good fit:\n' +
      '• Explain or summarise code/docs you already have in context\n' +
      '• Generate boilerplate, test stubs, type definitions, mock data\n' +
      '• Answer factual questions about languages, frameworks, APIs\n' +
      '• Draft commit messages, PR descriptions, comments\n' +
      '• Translate or reformat content (JSON↔YAML, snake_case↔camelCase)\n' +
      '• Brainstorm approaches before committing to one\n\n' +
      'Less good when: the task needs tool access, depends on multi-file context you have not captured, or is quick enough for you to answer directly before the round-trip completes.\n\n' +
      'Prompt tips (local models take instructions literally):\n' +
      '(1) Send COMPLETE context — the local LLM cannot read files.\n' +
      '(2) Be explicit about output format ("respond as a JSON array", "return only the function").\n' +
      '(3) Specific system persona beats generic — "Senior TypeScript dev" not "helpful assistant".\n' +
      '(4) State constraints — "no preamble", "reference line numbers", "max 5 bullets".\n' +
      '(5) Leave max_tokens UNSET — the server sizes the budget from the model\'s real context window. Tiny caps like 256 waste the model: reasoning burns the budget before any visible output.\n\n' +
      'Routing picks the best loaded model automatically. Call `discover` to see what is loaded and, after the first real call, its measured speed. The footer shows cumulative tokens kept in the user\'s quota.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The task. Be specific about expected output format. Include COMPLETE code/context — never truncate.',
        },
        system: {
          type: 'string',
          description: 'Persona for the local LLM. Be specific: "Senior TypeScript dev" not "helpful assistant".',
        },
        temperature: {
          type: 'number',
          description: '0.1 for factual/code, 0.3 for analysis (default), 0.7 for creative. Stay under 0.5 for code.',
        },
        max_tokens: {
          type: 'number',
          description: 'Response token budget. OMIT THIS — when omitted the server checks the live model\'s context window and allocates 25% of it (e.g. ~32,000 tokens on a 128k-context model), which is right for almost every call. Small caps like 256/512/1024 strangle reasoning models (hidden thinking burns the budget before visible output), so values below 4,096 are IGNORED and the dynamic budget applies. Only set this to raise the ceiling for very long outputs.',
        },
        json_schema: {
          type: 'object',
          description: 'Force structured JSON output. Provide a JSON Schema object and the response will be guaranteed valid JSON conforming to it. Example: {"name":"result","schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id (e.g. "nvidia/nemotron-3-nano-30b-a3b:free" on OpenRouter, "qwen.qwen3-coder-30b-a3b-instruct" on LM Studio). When set, overrides automatic routing. Useful on providers with many models where auto-routing picks poorly.',
        },
        ...(CONVERSATIONS_ENABLED ? CONVERSATION_PROPS : {}),
        ...REASONING_PROPS,
        ...SAMPLING_PROPS,
      },
      required: ['message'],
    },
  },
  {
    name: 'custom_prompt',
    description:
      'Structured analysis via the local LLM with explicit system/context/instruction separation. ' +
      'The 3-part format prevents context bleed in smaller models — the local LLM acknowledges the context in a fake assistant turn before receiving the instruction.\n\n' +
      'Good fit when prompt structure matters:\n' +
      '• Code review — paste full source, ask for bugs/improvements\n' +
      '• Comparison — paste two implementations, ask which is better and why\n' +
      '• Refactoring suggestions — paste code, ask for a cleaner version\n' +
      '• Content analysis — paste text, ask for structure/tone/issues\n' +
      '• Any task where separating context from instruction improves clarity\n\n' +
      'Field guidance (each has a job — keep them focused):\n' +
      '• system: persona + constraints, under 30 words. "Expert Python developer focused on performance and correctness."\n' +
      '• context: COMPLETE data — full source, full logs, full text. Never truncate.\n' +
      '• instruction: exactly what to produce, under 50 words. Specify format: "Return a JSON array of {line, issue, fix}."\n\n' +
      'When continuing a server-side conversation (conversation_id set), it is safe to resend the same context on ' +
      'every call — the server recognises it and will not duplicate it in the stored history. Omitting it after ' +
      'the first call also works as long as it is still within the retained history, but resending is the more ' +
      'robust habit: long conversations trim their oldest turns, and a dropped context is automatically re-added ' +
      'the next time you send it.\n\n' +
      'Review the output before acting on it — local model capability varies.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        system: {
          type: 'string',
          description: 'Persona. Be specific: "Expert Node.js developer focused on error handling and edge cases."',
        },
        context: {
          type: 'string',
          description: 'The COMPLETE data to analyse. Full source code, full logs, full text. NEVER truncate.',
        },
        instruction: {
          type: 'string',
          description: 'What to produce. Specify format: "List 3 bugs as bullet points" or "Return a JSON array of {line, issue, fix}".',
        },
        temperature: {
          type: 'number',
          description: '0.1 for bugs/review, 0.3 for analysis (default), 0.5 for suggestions.',
        },
        max_tokens: {
          type: 'number',
          description: 'Response token budget. OMIT THIS — the server sizes it from the live model\'s context window (25%, e.g. ~32,000 on a 128k-context model). Values below 4,096 are IGNORED (tiny caps strangle reasoning models) and the dynamic budget applies. Only set to raise the ceiling.',
        },
        json_schema: {
          type: 'object',
          description: 'Force structured JSON output. Provide a JSON Schema object and the response will be guaranteed valid JSON conforming to it.',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id. When set, overrides automatic routing.',
        },
        ...(CONVERSATIONS_ENABLED ? CONVERSATION_PROPS : {}),
        ...(JOBS_ENABLED ? ASYNC_PROPS : {}),
        ...REASONING_PROPS,
        ...SAMPLING_PROPS,
      },
      required: ['instruction'],
    },
  },
  {
    name: 'code_task',
    description:
      'Send a code-specific task to the local LLM, wrapped with an optimised code-review system prompt. Temperature is locked low (0.2 or the routed model\'s hint) for deterministic output.\n\n' +
      'Good fit:\n' +
      '• Explain what a function/class does\n' +
      '• Find bugs or suggest improvements\n' +
      '• Generate unit tests or type definitions for existing code\n' +
      '• Add error handling, logging, or validation\n' +
      '• Convert between languages or patterns\n\n' +
      'For best results:\n' +
      '• Provide COMPLETE source — the local LLM cannot read files.\n' +
      '• Include imports and type definitions so the model has full context.\n' +
      '• Be specific: "Write 3 Jest tests for the error paths in fetchUser" beats "Write tests".\n' +
      '• Set the language field — it shapes the system prompt and improves accuracy.\n\n' +
      'Verify generated code compiles, handles edge cases, and follows project conventions before committing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string',
          description: 'COMPLETE source code. Never truncate. Include imports and full function bodies.',
        },
        task: {
          type: 'string',
          description: 'What to do: "Find bugs", "Explain this", "Add error handling to fetchData", "Write tests".',
        },
        language: {
          type: 'string',
          description: 'Programming language: "typescript", "python", "rust", etc.',
        },
        max_tokens: {
          type: 'number',
          description: 'Response token budget. OMIT THIS — the server sizes it from the live model\'s context window (25%, e.g. ~32,000 on a 128k-context model). Values below 4,096 are IGNORED (tiny caps strangle reasoning models) and the dynamic budget applies. Only set to raise the ceiling.',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id. When set, overrides automatic routing.',
        },
        ...REASONING_PROPS,
        ...SAMPLING_PROPS,
      },
      required: ['code', 'task'],
    },
  },
  {
    name: 'code_task_files',
    description:
      'Like code_task, but the local LLM reads files directly from disk — source never passes through the MCP client\'s context window. Use when reviewing multiple files or a single large file.\n\n' +
      'How it works:\n' +
      '• Provide absolute paths. Relative paths are rejected.\n' +
      '• Files are read in parallel (Promise.allSettled) — one unreadable file does not sink the call.\n' +
      '• Files are concatenated with `=== filename ===` headers and sent to the same code-review pipeline as code_task.\n' +
      '• Read failures are surfaced inline with the reason so the LLM can still reason about the rest.\n' +
      '• Pre-flight prefill estimate: if measured per-model data shows the input would exceed the MCP client\'s ~60s request timeout during prompt processing, the call is refused early with a diagnostic instead of hanging. Split or trim when this fires.\n\n' +
      'Good fit:\n' +
      '• Reviewing related files together (module + its tests, client + server pair)\n' +
      '• Auditing a single large file too big to paste comfortably\n' +
      '• Any code_task where keeping source out of the Claude context window matters\n\n' +
      'Size guidance: on slow hardware (< 25 tok/s generation), keep total input under ~8,000 tokens (~32,000 chars) to stay safely under the client timeout. Faster hardware handles much more — the pre-flight estimator adapts once you\'ve done a few calls and real per-model timings are in the SQLite cache.\n\n' +
      'Same review discipline as code_task — verify the output before acting on it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths to analyse. Relative paths are rejected — always pass absolute.',
        },
        task: {
          type: 'string',
          description: 'What to do: "Find bugs", "Explain this module", "Suggest a cleaner API", etc.',
        },
        language: {
          type: 'string',
          description: 'Optional language hint: "typescript", "python", etc. Shapes the system prompt.',
        },
        max_tokens: {
          type: 'number',
          description: 'Response token budget. OMIT THIS — the server sizes it from the live model\'s context window (25%). Values below 4,096 are IGNORED and the dynamic budget applies. Only set to raise the ceiling.',
        },
        model: {
          type: 'string',
          description: 'Optional: pin to a specific model id. When set, overrides automatic routing.',
        },
        ...(JOBS_ENABLED ? ASYNC_PROPS : {}),
        ...REASONING_PROPS,
        ...SAMPLING_PROPS,
      },
      required: ['paths', 'task'],
    },
  },
  {
    name: 'discover',
    description:
      'Check whether the local LLM is online and what model is loaded. Returns model name, context window size, ' +
      'response latency, and cumulative session stats (tokens offloaded so far). ' +
      'Call this if you are unsure whether the local LLM is available before delegating work. ' +
      'Fast — typically responds in under 1 second, or returns an offline status within 5 seconds if the host is unreachable.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'list_models',
    description:
      'List all models on the local LLM server — both loaded (ready) and available (downloaded but not active). ' +
      'Shows rich metadata for each model: type (llm/vlm/embeddings), architecture, quantization, context window, ' +
      'and a capability profile describing what the model is best at. ' +
      'Use this to understand which models are available and suggest switching when a different model would suit the task better.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'embed',
    description:
      'Generate text embeddings via the local LLM server. Requires an embedding model to be loaded ' +
      '(e.g. Nomic Embed). Returns a vector representation of the input text for semantic search, ' +
      'similarity comparison, or RAG pipelines. Uses the OpenAI-compatible /v1/embeddings endpoint.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        input: {
          type: 'string',
          description: 'The text to embed. Can be a single string.',
        },
        model: {
          type: 'string',
          description: 'Embedding model ID. If omitted, uses whatever embedding model is loaded.',
        },
      },
      required: ['input'],
    },
  },
  {
    name: 'stats',
    description:
      'Show user stats: tokens offloaded, calls made, per-model performance — for the current session AND ' +
      'lifetime (persisted in SQLite at ~/.houtini-lm/model-cache.db). Unlike `discover` which includes the ' +
      'model catalog, `stats` returns just the numbers in a compact markdown table — cheap to call repeatedly ' +
      'to see the 💰 Claude-quota savings counter climb. Useful for quantifying how much work the local model ' +
      'is genuinely doing, and for noticing when a model\'s reasoning-token ratio is drifting.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        model: {
          type: 'string',
          description: 'Optional: filter output to a single model ID. Omit to see all models this workstation has used.',
        },
      },
    },
  },
  // Only shown when CONVERSATIONS_ENABLED — mirrors the conditional spread
  // used for chat's and custom_prompt's CONVERSATION_PROPS above, so a
  // sealed instance hides this tool entirely rather than exposing it and
  // erroring on every call.
  ...(CONVERSATIONS_ENABLED ? [{
    name: 'conversations',
    description:
      'Manage server-side conversations started with chat or custom_prompt\'s start_conversation. Scoped to ' +
      'conversations you own — you can never see or touch another owner\'s conversations, and this ' +
      'tool never reveals whether one exists. `list` returns metadata only (id, turn count, char count, idle ' +
      'time, expiry) — never message content. `delete` removes one conversation by conversation_id. `clear` ' +
      'is destructive: it removes every conversation you own at once. There is no confirmation step ' +
      'for clear — call list first if you need to check what would be lost.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'delete', 'clear'],
          description:
            '"list": show your conversations (metadata only, no message content). ' +
            '"delete": remove one conversation — requires conversation_id. ' +
            '"clear": remove every conversation you own.',
        },
        conversation_id: {
          type: 'string',
          description: 'Required for action: "delete". Ignored for "list" and "clear".',
        },
      },
      required: ['action'],
    },
  }] : []),
  // Only shown when JOBS_ENABLED — mirrors the conditional spread used for
  // the conversations tool above (phase 13). A sealed instance hides this
  // tool entirely rather than exposing it and erroring on every call.
  ...(JOBS_ENABLED ? [{
    name: 'jobs',
    description:
      'Check on or manage async jobs submitted via custom_prompt or code_task_files with async: true. Scoped to ' +
      'jobs you own — you can never see or touch another owner\'s jobs, and this tool never reveals whether one ' +
      'exists. `list` returns metadata only (id, tool, state, age, result size in chars) — never result content. ' +
      '`get` returns a job\'s current status, or its result once completed — requires job_id. A completed result ' +
      'over the server\'s inline size ceiling is automatically split into chunks; the response ends with a footer ' +
      'telling you the next `offset`/`limit` to request — copy that `Next` object verbatim into your following ' +
      '`get` call rather than computing the next offset yourself (chunk boundaries can shift by a character to ' +
      'avoid splitting a multi-byte character). `delete` removes one job\'s record; it does NOT cancel in-flight ' +
      'inference for a pending/running job — requires job_id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'delete'],
          description:
            '"list": show your jobs (metadata only, no result content). ' +
            '"get": fetch one job\'s status, or its result once completed — requires job_id. ' +
            '"delete": remove one job\'s record — requires job_id. Does not cancel in-flight inference.',
        },
        job_id: {
          type: 'string',
          description: 'Required for "get" and "delete". The id returned when the job was submitted (async: true).',
        },
        wait_ms: {
          type: 'number',
          description:
            '"get" only: if the job has not finished yet, wait up to this many milliseconds (short-polling ' +
            'internally) before returning its current status, instead of returning immediately. 0 (default) ' +
            'returns immediately regardless of state. Max 30000 (30s) — values outside 0-30000 are clamped.',
        },
        offset: {
          type: 'number',
          description:
            '"get" on a completed job only, ignored otherwise. 0-based character offset into the result to start ' +
            'returning from. Omit for the beginning of the result. Do not compute this yourself when paging ' +
            'through a chunked result — use the `offset` from the previous response\'s `Next` footer verbatim.',
        },
        limit: {
          type: 'number',
          description:
            '"get" on a completed job only, ignored otherwise. Maximum characters to return starting at `offset`. ' +
            'Omitting both `offset` and `limit` returns the full result inline if it is under the server\'s size ' +
            'ceiling, or the first chunk (with a `Next` footer) if it is over.',
        },
      },
      required: ['action'],
    },
  }] : []),
];

// ── MCP Server ───────────────────────────────────────────────────────

// Session-level sidekick framing. MCP clients surface this to the model
// at initialisation, so it sets the baseline expectation for when to delegate
// rather than relying on per-tool descriptions being re-read on every call.
const SIDEKICK_INSTRUCTIONS =
  `Houtini-lm is a local LLM sidekick. It runs on the user's hardware (or a configured OpenAI-compatible endpoint) and handles bounded work without consuming the user's Claude quota.\n\n` +
  `When to reach for it: bounded, self-contained tasks you can describe in one message — explanations, boilerplate, test stubs, code review of pasted or file-loaded source, translations, commit messages, format conversion, brainstorming. Trades wall-clock time for tokens (typically 3-30× slower than frontier models).\n\n` +
  `When not to: tasks that need tool access, cross-file reasoning you haven't captured, or work fast enough to answer directly before the delegation round-trip completes.\n\n` +
  `Call \`discover\` in delegation-heavy sessions to see what model is loaded, its capability profile, and — after the first real call — its measured speed. The response footer reports cumulative tokens kept in the user's quota.`;

const server = new Server(
  { name: 'houtini-lm', version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {} }, instructions: SIDEKICK_INSTRUCTIONS },
);

// ── MCP Resources ─────────────────────────────────────────────────────
// Exposes session performance metrics as a readable resource so Claude can
// proactively check offload efficiency and make smarter delegation decisions.

const handleListResources = async (): Promise<ListResourcesResult> => ({
  resources: [
    {
      uri: 'houtini://metrics/session',
      name: 'Session Offload Metrics',
      description: 'Cumulative token offload stats, per-model performance, and quality signals for the current session.',
      mimeType: 'application/json',
    },
  ],
});

const handleReadResource = async (request: ReadResourceRequest): Promise<ReadResourceResult> => {
  const { uri } = request.params;

  if (uri === 'houtini://metrics/session') {
    const modelStats: Record<string, { calls: number; avgTtftMs: number; avgTokPerSec: number | null }> = {};
    for (const [modelId, stats] of session.modelStats) {
      modelStats[modelId] = {
        calls: stats.calls,
        avgTtftMs: stats.ttftCalls > 0 ? Math.round(stats.totalTtftMs / stats.ttftCalls) : 0,
        avgTokPerSec: stats.perfCalls > 0 ? parseFloat((stats.totalTokPerSec / stats.perfCalls).toFixed(1)) : null,
      };
    }

    const metrics = {
      session: {
        totalCalls: session.calls,
        promptTokens: session.promptTokens,
        completionTokens: session.completionTokens,
        totalTokensOffloaded: session.promptTokens + session.completionTokens,
      },
      perModel: modelStats,
      endpoint: redactUrl(LM_BASE_URL),
    };

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(metrics, null, 2),
      }],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
};

const handleListTools = async (): Promise<ListToolsResult> => ({ tools: TOOLS });

type HoutiniExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const handleCallTool = async (request: CallToolRequest, extra: HoutiniExtra): Promise<CallToolResult> => {
  const { name } = request.params;
  // `arguments` is optional in the MCP CallTool schema — a client may omit it
  // entirely for a param-less tool (e.g. `stats` with no filter). Default to an
  // empty object so handlers that destructure args never throw on `undefined`.
  const args = request.params.arguments ?? {};
  const progressToken = request.params._meta?.progressToken;
  const sendNotification = extra.sendNotification;

  try {
    switch (name) {
      case 'chat': {
        const { message, system, temperature, max_tokens, json_schema, model, include_reasoning, force_thinking, start_conversation, conversation_id } = args as {
          message: string;
          system?: string;
          temperature?: number;
          max_tokens?: number;
          json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
          model?: string;
          include_reasoning?: boolean;
          force_thinking?: boolean;
          start_conversation?: boolean;
          conversation_id?: string;
        };

        const conv = resolveConversation(start_conversation, conversation_id, extra);
        if (conv.kind === 'error') return conv.result;
        const history: ConversationTurn[] = conv.kind === 'active' ? conv.history : [];

        const route = await routeToModel('chat', model);

        const responseFormat: ResponseFormat | undefined = toResponseFormat(json_schema);

        const messages: ChatMessage[] = [];
        messages.push({
          role: 'system',
          content: buildSystemPrompt({
            base: system && system.trim() ? system.trim() : 'You are a precise technical assistant.',
            formatLine: 'Be direct — no preamble, no restating the question. Use markdown formatting where it helps.',
            modelConstraint: route.hints.outputConstraint,
            structuredOutput: !!responseFormat,
          }),
        });
        messages.push(...history);
        messages.push({ role: 'user', content: message });

        const resp = await chatCompletionStreaming(messages, {
          temperature: validTemperature(temperature) ?? route.hints.chatTemp,
          maxTokens: validMaxTokens(max_tokens),
          model: route.modelId,
          responseFormat,
          progressToken,
          sendNotification,
          sampling: extractSamplingParams(args as Record<string, unknown>),
          forceThinking: force_thinking === true,
        });

        const reasoningBlock = formatReasoningBlock(include_reasoning, resp);
        const footer = formatFooter(resp);

        const conversationLine = recordConversationTurns(conv, [
          { role: 'user', content: message },
          { role: 'assistant', content: resp.content },
        ]);

        return { content: [{ type: 'text', text: resp.content + reasoningBlock + footer + conversationLine }] };
      }

      case 'custom_prompt': {
        const { system, context, instruction, temperature, max_tokens, json_schema, model, include_reasoning, force_thinking, start_conversation, conversation_id, async: asyncFlag } = args as {
          system?: string;
          context?: string;
          instruction: string;
          temperature?: number;
          max_tokens?: number;
          json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
          model?: string;
          include_reasoning?: boolean;
          force_thinking?: boolean;
          start_conversation?: boolean;
          conversation_id?: string;
          async?: boolean;
        };

        // async: true (phase 13) — submit as a background job instead of
        // running inline. Checked FIRST, before touching conversation state
        // at all, so a non-async call's behaviour below is completely
        // unaffected by this branch existing. See ASYNC_PROPS's schema text
        // for why start_conversation/conversation_id are rejected here
        // rather than silently ignored.
        if (asyncFlag === true) {
          if (!JOBS_ENABLED) {
            return { content: [{ type: 'text', text: JOBS_DISABLED_MESSAGE }], isError: true };
          }
          if (start_conversation !== undefined || conversation_id !== undefined) {
            return { content: [{ type: 'text', text: ASYNC_WITH_CONVERSATION_MESSAGE }], isError: true };
          }
          // Owner resolution has no `await` in it (see resolveOwnerKey()),
          // so this is safe to do early — it's the active-limit CHECK that
          // must be deferred (see below).
          const ownerResult = resolveJobOwner(extra);
          if (ownerResult.kind === 'error') return ownerResult.result;
          const owner = ownerResult.owner;

          // routeToModel() calls out to list models, so submission itself
          // takes ~1s here — see ASYNC_PROPS's schema text, which says so
          // rather than overselling "immediate".
          const route = await routeToModel('analysis', model);
          const responseFormat: ResponseFormat | undefined = toResponseFormat(json_schema);

          // No conversation history is possible here (rejected above), so
          // this is exactly the sync path's "no history" branch: system
          // prompt, optional context/ack pair, instruction. No dedup check
          // is needed either — there is no history to dedup against.
          const messages: ChatMessage[] = [{
            role: 'system',
            content: buildSystemPrompt({
              base: system && system.trim() ? system.trim() : 'You are a precise technical assistant.',
              formatLine: 'Be direct — no preamble, no restating the question. Use markdown formatting where it helps.',
              modelConstraint: route.hints.outputConstraint,
              structuredOutput: !!responseFormat,
            }),
          }];
          if (context) {
            messages.push({ role: 'user', content: `${CUSTOM_PROMPT_CONTEXT_PREFIX}${context}` });
            messages.push({ role: 'assistant', content: CUSTOM_PROMPT_CONTEXT_ACK });
          }
          messages.push({ role: 'user', content: instruction });

          const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
          const estimate = await estimatePrefill(promptChars, route.modelId);

          // Checked here — AFTER the routeToModel()/estimatePrefill() awaits
          // above, immediately before submitJob() — rather than earlier
          // alongside the JOBS_ENABLED/conversation-param checks. Those two
          // awaits yield the event loop, so checking the active-job count
          // before them would leave a window where two concurrent async
          // calls from the same owner could both read the same
          // under-the-limit count and both proceed, bypassing
          // HOUTINI_LM_JOB_ACTIVE_MAX_PER_OWNER. No further await happens
          // between this check and submitJob() below (fn is only defined
          // here, not invoked), so this placement is race-free. Matches
          // code_task_files' async branch, which places the same check
          // immediately before its own submitJob() call for the same reason.
          const limitError = jobActiveLimitError(owner);
          if (limitError) return limitError;

          const sampling = extractSamplingParams(args as Record<string, unknown>);
          const fn = async (): Promise<string> => {
            const { text } = await runInference(messages, {
              temperature: validTemperature(temperature) ?? route.hints.chatTemp,
              maxTokens: validMaxTokens(max_tokens),
              model: route.modelId,
              responseFormat,
              sampling,
              forceThinking: force_thinking === true,
              includeReasoning: include_reasoning,
              softTimeoutMs: JOB_SOFT_TIMEOUT_MS,
              prefillTimeoutMs: JOB_PREFILL_TIMEOUT_MS,
              lockMaxWaitMs: JOB_LOCK_MAX_WAIT_MS,
              // No MCP progress channel is threaded through here — a job
              // outlives the request that submitted it, whose response (and
              // SSE stream, over HTTP) is already closed by the time this runs.
            });
            return text;
          };

          const jobId = submitJob(owner, 'custom_prompt', fn);
          return {
            content: [{ type: 'text', text: formatJobSubmitted(jobId, 'custom_prompt', estimate.inputTokens, Math.round(estimate.estimatedSeconds), JOB_TTL_MIN) }],
          };
        }

        const conv = resolveConversation(start_conversation, conversation_id, extra);
        if (conv.kind === 'error') return conv.result;
        const history: ConversationTurn[] = conv.kind === 'active' ? conv.history : [];

        const route = await routeToModel('analysis', model);

        const responseFormat: ResponseFormat | undefined = toResponseFormat(json_schema);

        const messages: ChatMessage[] = [];
        messages.push({
          role: 'system',
          content: buildSystemPrompt({
            base: system && system.trim() ? system.trim() : 'You are a precise technical assistant.',
            formatLine: 'Be direct — no preamble, no restating the question. Use markdown formatting where it helps.',
            modelConstraint: route.hints.outputConstraint,
            structuredOutput: !!responseFormat,
          }),
        });
        messages.push(...history);

        // Multi-turn format prevents context bleed in smaller models.
        // Context goes in a separate user→assistant exchange so the model
        // "acknowledges" it before receiving the actual instruction. When a
        // conversation is active, this pair is recorded into history (see
        // below) the first time it is sent; on later calls in the same
        // conversation, resending the identical context is matched by
        // exact string equality against CUSTOM_PROMPT_CONTEXT_PREFIX +
        // context (whitespace differences are NOT normalised — a
        // byte-for-byte match is required) and skipped rather than
        // duplicated into the prompt or the stored history. If the pair
        // later falls out of history (ConversationStore.trim() evicts the
        // oldest turns first), this check goes false again and the pair is
        // transparently re-added — no action needed from the caller.
        const contextTurn = context ? `${CUSTOM_PROMPT_CONTEXT_PREFIX}${context}` : undefined;
        const contextAlreadyInHistory =
          contextTurn !== undefined && history.some((t) => t.role === 'user' && t.content === contextTurn);
        if (contextTurn !== undefined && !contextAlreadyInHistory) {
          messages.push({ role: 'user', content: contextTurn });
          messages.push({ role: 'assistant', content: CUSTOM_PROMPT_CONTEXT_ACK });
        }
        messages.push({ role: 'user', content: instruction });

        const { text, resp } = await runInference(messages, {
          temperature: validTemperature(temperature) ?? route.hints.chatTemp,
          maxTokens: validMaxTokens(max_tokens),
          model: route.modelId,
          responseFormat,
          progressToken,
          sendNotification,
          sampling: extractSamplingParams(args as Record<string, unknown>),
          forceThinking: force_thinking === true,
          includeReasoning: include_reasoning,
        });

        // Mirror what was actually sent to the model: the context/ack pair
        // is only stored when it was newly injected above, so a
        // conversation's history never accumulates duplicate copies of the
        // same context. The instruction/response pair is always stored.
        const turnsToStore: ConversationTurn[] =
          contextTurn !== undefined && !contextAlreadyInHistory
            ? [
                { role: 'user', content: contextTurn },
                { role: 'assistant', content: CUSTOM_PROMPT_CONTEXT_ACK },
                { role: 'user', content: instruction },
                { role: 'assistant', content: resp.content },
              ]
            : [
                { role: 'user', content: instruction },
                { role: 'assistant', content: resp.content },
              ];
        const contextNote = contextAlreadyInHistory
          ? ' context was already recorded for this conversation and was not resent to the model.'
          : undefined;
        const conversationLine = recordConversationTurns(conv, turnsToStore, contextNote);

        return {
          content: [{ type: 'text', text: text + conversationLine }],
        };
      }

      case 'code_task': {
        const { code, task, language, max_tokens: codeMaxTokens, model, include_reasoning, force_thinking } = args as {
          code: string;
          task: string;
          language?: string;
          max_tokens?: number;
          model?: string;
          include_reasoning?: boolean;
          force_thinking?: boolean;
        };

        const lang = language || 'unknown';
        const route = await routeToModel('code', model);

        // Task goes in system message so smaller models don't lose it once
        // the code block fills the attention window. Code is sole user content.
        const codeMessages: ChatMessage[] = [
          {
            role: 'system',
            content: buildSystemPrompt({
              base: `You are a senior ${lang} developer. Your task: ${task}`,
              formatLine: 'Be specific — reference line numbers, function names, and concrete fixes. Output your analysis as a markdown list.',
              modelConstraint: route.hints.outputConstraint,
            }),
          },
          {
            role: 'user',
            content: `\`\`\`${lang}\n${code}\n\`\`\``,
          },
        ];

        const codeResp = await chatCompletionStreaming(codeMessages, {
          temperature: route.hints.codeTemp,
          // Pass the (validated) value, undefined when omitted, so the
          // 25%-of-context auto-derivation in chatCompletionStreamingInner fires
          // — matching code_task_files. Forcing DEFAULT_MAX_TOKENS here made
          // options.maxTokens always truthy, capping long generations at 16K.
          maxTokens: validMaxTokens(codeMaxTokens),
          model: route.modelId,
          progressToken,
          sendNotification,
          sampling: extractSamplingParams(args as Record<string, unknown>),
          forceThinking: force_thinking === true,
        });

        const reasoningBlock = formatReasoningBlock(include_reasoning, codeResp);
        const codeFooter = formatFooter(codeResp, lang);
        const suggestionLine = route.suggestion ? `\n${route.suggestion}` : '';
        return { content: [{ type: 'text', text: codeResp.content + reasoningBlock + codeFooter + suggestionLine }] };
      }

      case 'code_task_files': {
        const { paths, task, language, max_tokens: codeMaxTokens, model, include_reasoning, force_thinking, async: asyncFlag } = args as {
          paths: string[];
          task: string;
          language?: string;
          max_tokens?: number;
          model?: string;
          include_reasoning?: boolean;
          force_thinking?: boolean;
          async?: boolean;
        };

        if (!Array.isArray(paths) || paths.length === 0) {
          return {
            content: [{ type: 'text', text: 'Error: paths must be a non-empty array of absolute file paths.' }],
            isError: true,
          };
        }

        // Reject relative paths early — silent resolution against cwd is surprising.
        const relative = paths.filter((p) => typeof p !== 'string' || !isAbsolute(p));
        if (relative.length > 0) {
          return {
            content: [{ type: 'text', text: `Error: all paths must be absolute. Relative paths: ${JSON.stringify(relative)}` }],
            isError: true,
          };
        }

        // Read all files in parallel. One unreadable file doesn't sink the call —
        // failures become inline error sections so the model can still reason about
        // the rest of the bundle.
        const reads = await Promise.allSettled(
          paths.map(async (p) => ({ path: p, content: await readGuardedFile(p) })),
        );

        const sections: string[] = [];
        let successCount = 0;
        reads.forEach((r, i) => {
          const p = paths[i];
          if (r.status === 'fulfilled') {
            successCount++;
            sections.push(`=== ${basename(p)} (${p}) ===\n${r.value.content}`);
          } else {
            const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
            sections.push(`=== ${basename(p)} (${p}) — READ FAILED ===\n[Could not read: ${reason}]`);
          }
        });

        if (successCount === 0) {
          return {
            content: [{ type: 'text', text: `Error: none of the ${paths.length} file(s) could be read. Check the paths and permissions.\n\n${sections.join('\n\n')}` }],
            isError: true,
          };
        }

        const lang = language || 'unknown';
        const route = await routeToModel('code', model);

        const combined = sections.join('\n\n');

        // Pre-flight prefill estimate. Huge inputs can legitimately exceed
        // the MCP client's ~60s request timeout during prompt processing, and
        // progress notifications don't reset that timeout on Claude Desktop.
        // If measured per-model data in the SQLite cache shows this input
        // would obviously overrun, refuse with a concrete diagnostic so the
        // caller knows to split or trim instead of waiting for a silent hang.
        //
        // Preferred method: linear fit `TTFT ≈ α + β·prompt_tokens` over the
        // most recent PREFILL_SAMPLES_PER_MODEL (prompt_tokens, TTFT_ms) pairs.
        // Separates fixed per-request overhead from per-token prefill cost and
        // avoids the under-prediction a ratio-of-averages produces on inputs
        // much larger than the historical mean.
        const estimate = await estimatePrefill(combined.length, route.modelId);
        // A poor fit (low R² — e.g. bimodal samples straddling a backend
        // restart with different perf settings) must not refuse the call: a
        // false refusal is worse than a false-ok that the prefill keepalive
        // and timeout machinery already handle.
        const isConfidentEstimate =
          (estimate.basis === 'linear-fit' && estimate.fit!.r2 >= 0.5) ||
          estimate.basis === 'ratio';
        // The refusal below exists to protect the MCP client's ~60s request
        // timeout during prefill — an async job (phase 13) has no such
        // client watching, so it never applies here. The estimate itself is
        // still computed above (and reused for formatJobSubmitted's
        // prefillSecEstimate on the async path below); only the refuse
        // branch is skipped.
        if (asyncFlag !== true && isConfidentEstimate && estimate.estimatedSeconds > PREFILL_REFUSE_THRESHOLD_SEC) {
          const estSec = Math.round(estimate.estimatedSeconds);
          const basisLine = estimate.basis === 'linear-fit'
            ? `• Estimator: linear fit — TTFT ≈ ${Math.round(estimate.fit!.alphaMs)}ms + ${estimate.fit!.betaMsPerToken.toFixed(2)}ms/token (n=${estimate.fit!.n}, R²=${estimate.fit!.r2.toFixed(2)})`
            : `• Estimator: ratio fallback — ~${Math.round(estimate.prefillTokPerSec!)} tok/s (from ${lifetime.modelStats.get(route.modelId)?.ttftCalls ?? 0} prior calls; less accurate for inputs far from the historical mean)`;
          return {
            content: [{
              type: 'text',
              text:
                `Error: estimated prefill time exceeds the ~60s MCP client timeout.\n\n` +
                `• Input size: ~${estimate.inputTokens.toLocaleString()} tokens across ${successCount} file(s)\n` +
                `${basisLine}\n` +
                `• Estimated prefill: ~${estSec}s (threshold: ${PREFILL_REFUSE_THRESHOLD_SEC}s)\n\n` +
                `Options: split the files into smaller groups, trim the largest file, or use \`code_task\` with a focused excerpt. ` +
                `If you know this workstation can handle it, pass fewer files or run the task again when the measured rate improves.`,
            }],
            isError: true,
          };
        }
        if (estimate.estimatedSeconds > PREFILL_WARN_THRESHOLD_SEC) {
          const basisDetail = estimate.basis === 'linear-fit'
            ? `linear-fit n=${estimate.fit!.n} R²=${estimate.fit!.r2.toFixed(2)}`
            : estimate.basis;
          process.stderr.write(
            `[houtini-lm] Large input warning: ~${estimate.inputTokens} tokens, est prefill ~${Math.round(estimate.estimatedSeconds)}s (${basisDetail}). Proceeding.\n`,
          );
        }

        const codeMessages: ChatMessage[] = [
          {
            role: 'system',
            content: buildSystemPrompt({
              base: `You are a senior ${lang} developer. Your task: ${task}\n\nThe user has provided ${paths.length} file(s), concatenated below with \`=== filename ===\` headers. Reference files by name in your output.`,
              formatLine: 'Be specific — line numbers, function names, concrete fixes. Output your analysis as a markdown list.',
              modelConstraint: route.hints.outputConstraint,
            }),
          },
          {
            role: 'user',
            content: `\`\`\`${lang}\n${combined}\n\`\`\``,
          },
        ];

        // Computed before the sync/async branch below — it depends only on
        // the already-completed file reads, not on the model response.
        const readSummary = successCount === paths.length
          ? `${paths.length} file(s) read`
          : `${successCount}/${paths.length} file(s) read`;
        const suggestionLine = route.suggestion ? `\n${route.suggestion}` : '';
        const codeSampling = extractSamplingParams(args as Record<string, unknown>);

        // async: true (phase 13) — submit as a background job instead of
        // running inline. Files are already read and validated above (at
        // this point in the handler, unconditionally) — an invalid path
        // fails synchronously at submit time, before any job is queued.
        // Checked here, after the shared read/route/estimate work above (so
        // the same estimate feeds formatJobSubmitted's prefillSecEstimate)
        // but before touching the model.
        if (asyncFlag === true) {
          if (!JOBS_ENABLED) {
            return { content: [{ type: 'text', text: JOBS_DISABLED_MESSAGE }], isError: true };
          }
          // code_task_files has no start_conversation/conversation_id in its
          // own schema (only chat/custom_prompt do), but guard defensively
          // against a caller sending them anyway — same rejection as
          // custom_prompt's async branch, for the same reason.
          const rawArgs = args as Record<string, unknown>;
          if (rawArgs.start_conversation !== undefined || rawArgs.conversation_id !== undefined) {
            return { content: [{ type: 'text', text: ASYNC_WITH_CONVERSATION_MESSAGE }], isError: true };
          }
          const ownerResult = resolveJobOwner(extra);
          if (ownerResult.kind === 'error') return ownerResult.result;
          const owner = ownerResult.owner;
          const limitError = jobActiveLimitError(owner);
          if (limitError) return limitError;

          const fn = async (): Promise<string> => {
            // Pass codeMaxTokens raw (not `?? DEFAULT_MAX_TOKENS`) so the
            // 25%-of-context auto-derivation in chatCompletionStreamingInner
            // fires when the caller omits it — matches the sync path.
            const { text } = await runInference(codeMessages, {
              temperature: route.hints.codeTemp,
              maxTokens: validMaxTokens(codeMaxTokens),
              model: route.modelId,
              sampling: codeSampling,
              forceThinking: force_thinking === true,
              includeReasoning: include_reasoning,
              footerExtra: `${lang} · ${readSummary}`,
              softTimeoutMs: JOB_SOFT_TIMEOUT_MS,
              prefillTimeoutMs: JOB_PREFILL_TIMEOUT_MS,
              lockMaxWaitMs: JOB_LOCK_MAX_WAIT_MS,
              // No MCP progress channel threaded through here — see
              // custom_prompt's async branch for why.
            });
            return text + suggestionLine;
          };

          const jobId = submitJob(owner, 'code_task_files', fn);
          return {
            content: [{ type: 'text', text: formatJobSubmitted(jobId, 'code_task_files', estimate.inputTokens, Math.round(estimate.estimatedSeconds), JOB_TTL_MIN) }],
          };
        }

        // Pass codeMaxTokens raw (not `?? DEFAULT_MAX_TOKENS`) so the 25%-of-context
        // auto-derivation in chatCompletionStreamingInner fires when the caller omits it.
        const { text } = await runInference(codeMessages, {
          temperature: route.hints.codeTemp,
          maxTokens: validMaxTokens(codeMaxTokens),
          model: route.modelId,
          progressToken,
          sendNotification,
          sampling: codeSampling,
          forceThinking: force_thinking === true,
          includeReasoning: include_reasoning,
          footerExtra: `${lang} · ${readSummary}`,
        });
        return { content: [{ type: 'text', text: text + suggestionLine }] };
      }

      case 'discover': {
        const start = Date.now();
        let models: ModelInfo[];
        try {
          models = await listModelsRaw();
        } catch (err) {
          const ms = Date.now() - start;
          const reason = err instanceof Error && err.name === 'AbortError'
            ? `Host unreachable (timed out after ${ms}ms)`
            : `Connection failed: ${err instanceof Error ? err.message : String(err)}`;
          return {
            content: [{
              type: 'text',
              text: `Status: OFFLINE\nEndpoint: ${redactUrl(LM_BASE_URL)}\n${reason}\n\nThe local LLM is not available right now. Do not attempt to delegate tasks to it.`,
            }],
          };
        }
        const ms = Date.now() - start;

        if (models.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `Status: ONLINE (no model loaded)\nEndpoint: ${redactUrl(LM_BASE_URL)}\nLatency: ${ms}ms\n\nThe server is running but no model is loaded. Ask the user to load a model in LM Studio.`,
            }],
          };
        }

        const loaded = models.filter((m) => m.state === 'loaded' || !m.state);
        const available = models.filter((m) => m.state === 'not-loaded');

        // Models are downloaded but none is loaded (LM Studio with nothing
        // active). `loaded` still includes state-less models from backends that
        // don't report load state, so this fires only when every model is
        // genuinely not-loaded. Report it distinctly instead of presenting an
        // unloaded model as active — delegating to it would trigger an on-demand
        // load on the first call and likely blow the client's request timeout.
        if (loaded.length === 0) {
          const names = (available.length > 0 ? available : models).map((m) => m.id).join(', ');
          return {
            content: [{
              type: 'text',
              text: `Status: ONLINE (no model loaded)\nEndpoint: ${redactUrl(LM_BASE_URL)}\nLatency: ${ms}ms\n\nThe server is running but no model is currently loaded. Downloaded models the user can load: ${names}\n\nDo not delegate tasks until a model is loaded.`,
            }],
          };
        }

        const primary = loaded[0] || models[0];
        const ctx = getContextLength(primary);
        const primaryProfile = await getModelProfileAsync(primary);

        // Use sessionSummary() so discover matches the footer format and
        // automatically picks up the lifetime line when the SQLite cache has
        // cross-session data.
        const summary = sessionSummary();
        const sessionStats = session.calls > 0 || lifetime.totalCalls > 0
          ? `\n${summary}`
          : `\n💰 Claude quota saved this session: 0 tokens — no calls yet. Measured speed for each model will appear here after the first real call.`;

        // Measured speed line for the active model. Discover intentionally does
        // not run a synthetic warmup — speed is captured from real tasks, so the
        // numbers reflect actual workload rather than a contrived benchmark.
        // Shows session stats when this session has measured calls; otherwise
        // falls back to workstation lifetime stats so Claude sees historical
        // perf from call 1 instead of "not yet benchmarked".
        const primaryStats = session.modelStats.get(primary.id);
        const primaryLifetime = lifetime.modelStats.get(primary.id);
        let speedLine = '';
        if (primaryStats && primaryStats.perfCalls > 0) {
          const avgTtft = primaryStats.ttftCalls > 0 ? Math.round(primaryStats.totalTtftMs / primaryStats.ttftCalls) : 0;
          const avgTokSec = (primaryStats.totalTokPerSec / primaryStats.perfCalls).toFixed(1);
          speedLine = `Measured speed (session): ${avgTokSec} tok/s · TTFT ${avgTtft}ms (${primaryStats.perfCalls} call${primaryStats.perfCalls === 1 ? '' : 's'})\n`;
          if (primaryLifetime && primaryLifetime.perfCalls > primaryStats.perfCalls) {
            const lAvgTtft = primaryLifetime.ttftCalls > 0 ? Math.round(primaryLifetime.totalTtftMs / primaryLifetime.ttftCalls) : 0;
            const lAvgTokSec = (primaryLifetime.totalTokPerSec / primaryLifetime.perfCalls).toFixed(1);
            speedLine += `Measured speed (lifetime on this workstation): ${lAvgTokSec} tok/s · TTFT ${lAvgTtft}ms (${primaryLifetime.perfCalls} calls)\n`;
          }
        } else if (primaryLifetime && primaryLifetime.perfCalls > 0) {
          const lAvgTtft = primaryLifetime.ttftCalls > 0 ? Math.round(primaryLifetime.totalTtftMs / primaryLifetime.ttftCalls) : 0;
          const lAvgTokSec = (primaryLifetime.totalTokPerSec / primaryLifetime.perfCalls).toFixed(1);
          speedLine = `Measured speed (lifetime on this workstation): ${lAvgTokSec} tok/s · TTFT ${lAvgTtft}ms (${primaryLifetime.perfCalls} calls, last used ${new Date(primaryLifetime.lastUsedAt).toISOString().slice(0, 10)})\n`;
        } else {
          speedLine = `Measured speed: not yet benchmarked — will be captured on the first real call.\n`;
        }

        const backendLabel = getBackend() === 'lmstudio' ? 'LM Studio'
          : getBackend() === 'ollama' ? 'Ollama'
          : 'OpenAI-compatible';

        let text =
          `Status: ONLINE\n` +
          `Endpoint: ${redactUrl(LM_BASE_URL)} (${backendLabel})\n` +
          `Connection latency: ${ms}ms (does not reflect inference speed)\n` +
          `Active model: ${primary.id}\n` +
          `Context window: ${ctx.toLocaleString()} tokens\n` +
          speedLine;

        if (primaryProfile) {
          text += `Family: ${primaryProfile.family}\n`;
          text += `Description: ${primaryProfile.description}\n`;
          text += `Best for: ${primaryProfile.bestFor.join(', ')}\n`;
          text += `Strengths: ${primaryProfile.strengths.join(', ')}\n`;
          if (primaryProfile.weaknesses.length > 0) {
            text += `Weaknesses: ${primaryProfile.weaknesses.join(', ')}\n`;
          }
        }

        if (loaded.length > 0) {
          text += `\nLoaded models (● ready to use):\n`;
          text += (await Promise.all(loaded.map((m) => formatModelDetail(m)))).join('\n\n');
        }

        if (available.length > 0) {
          text += `\n\nAvailable models (○ downloaded, not loaded — can be activated in LM Studio):\n`;
          text += (await Promise.all(available.map((m) => formatModelDetail(m)))).join('\n\n');
        }

        // Per-model performance stats from this session
        if (session.modelStats.size > 0) {
          text += `\n\nPerformance (this session):\n`;
          for (const [modelId, stats] of session.modelStats) {
            const avgTtft = stats.ttftCalls > 0 ? Math.round(stats.totalTtftMs / stats.ttftCalls) : 0;
            const avgTokSec = stats.perfCalls > 0 ? (stats.totalTokPerSec / stats.perfCalls).toFixed(1) : '?';
            text += `  ${modelId}: ${stats.calls} calls, avg TTFT ${avgTtft}ms, avg ${avgTokSec} tok/s\n`;
          }
        }

        // Workstation lifetime stats — built from SQLite, persists across restarts.
        // Only shown when there's lifetime data beyond this session, so a first-run
        // user doesn't see a duplicate of the session block above.
        const hasLifetimeBeyondSession = Array.from(lifetime.modelStats.entries())
          .some(([id, l]) => l.calls > (session.modelStats.get(id)?.calls ?? 0));
        if (hasLifetimeBeyondSession) {
          text += `\nPerformance (lifetime on this workstation):\n`;
          for (const [modelId, stats] of lifetime.modelStats) {
            const avgTtft = stats.ttftCalls > 0 ? Math.round(stats.totalTtftMs / stats.ttftCalls) : 0;
            const avgTokSec = stats.perfCalls > 0 ? (stats.totalTokPerSec / stats.perfCalls).toFixed(1) : '?';
            const lastUsed = new Date(stats.lastUsedAt).toISOString().slice(0, 10);
            text += `  ${modelId}: ${stats.calls} calls, avg TTFT ${avgTtft}ms, avg ${avgTokSec} tok/s (last used ${lastUsed})\n`;
          }
        }

        text += `${sessionStats}\n\n`;
        text += `The local LLM is available. You can delegate tasks using chat, custom_prompt, code_task, code_task_files, or embed.`;

        return { content: [{ type: 'text', text }] };
      }

      case 'list_models': {
        const models = await listModelsRaw();
        if (!models.length) {
          return { content: [{ type: 'text', text: 'No models currently loaded or available.' }] };
        }

        const loaded = models.filter((m) => m.state === 'loaded' || !m.state);
        const available = models.filter((m) => m.state === 'not-loaded');

        let text = '';

        // list_models enriches with HuggingFace data (cached after first call)
        if (loaded.length > 0) {
          text += `Loaded models (● ready to use):\n\n`;
          text += (await Promise.all(loaded.map((m) => formatModelDetail(m, true)))).join('\n\n');
        }

        if (available.length > 0) {
          if (text) text += '\n\n';
          text += `Available models (○ downloaded, not loaded):\n\n`;
          text += (await Promise.all(available.map((m) => formatModelDetail(m, true)))).join('\n\n');
        }

        return { content: [{ type: 'text', text }] };
      }

      case 'embed': {
        const { input, model: embedModel } = args as { input: string; model?: string };

        return await withInferenceLock(async () => {
          const embedBody: Record<string, unknown> = { input };
          if (embedModel) {
            embedBody.model = embedModel;
          }

          const res = await fetchWithTimeout(
            `${LM_BASE_URL}/v1/embeddings`,
            { method: 'POST', headers: apiHeaders(), body: JSON.stringify(embedBody) },
            INFERENCE_CONNECT_TIMEOUT_MS,
          );

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Embeddings API error ${res.status}: ${errText}`);
          }

          const data = (await res.json()) as {
            data: { embedding: number[]; index: number }[];
            model: string;
            usage?: { prompt_tokens: number; total_tokens: number };
          };

          const embedding = data.data[0]?.embedding;
          if (!embedding) throw new Error('No embedding returned');

          const usageInfo = data.usage
            ? `${data.usage.prompt_tokens} tokens embedded`
            : '';

          // Round to 7 significant figures for transport. Embedding components
          // are ~[-1, 1], so this is lossless for any similarity use but roughly
          // halves the serialised size — which for high-dimension models
          // (4k–8k dims) keeps the tool result from bloating the client context
          // or exceeding its result-size limit. Dimensions are preserved.
          const compact = (embedding as number[]).map((x) => Number(x.toPrecision(7)));

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                model: data.model,
                dimensions: embedding.length,
                embedding: compact,
                usage: usageInfo,
              }),
            }],
          };
        });
      }

      case 'stats': {
        const { model: filterModel } = args as { model?: string };

        const backendLabel = getBackend() === 'lmstudio' ? 'LM Studio'
          : getBackend() === 'ollama' ? 'Ollama'
          : 'OpenAI-compatible';

        const lines: string[] = [];
        lines.push(`## Houtini LM stats`);
        lines.push('');
        lines.push(`**Endpoint**: ${redactUrl(LM_BASE_URL)} (${backendLabel})`);
        if (lifetime.firstSeenAt) {
          lines.push(`**First call on this workstation**: ${new Date(lifetime.firstSeenAt).toISOString().slice(0, 10)}`);
        }
        lines.push('');

        // Totals block
        lines.push(`### Totals`);
        lines.push('');
        lines.push(`| Scope    | Calls | Prompt tokens | Completion tokens | Total tokens |`);
        lines.push(`|----------|------:|--------------:|------------------:|-------------:|`);
        lines.push(`| Session  | ${session.calls} | ${session.promptTokens.toLocaleString()} | ${session.completionTokens.toLocaleString()} | ${(session.promptTokens + session.completionTokens).toLocaleString()} |`);
        lines.push(`| Lifetime | ${lifetime.totalCalls} | — | — | ${lifetime.totalTokens.toLocaleString()} |`);
        lines.push('');

        // Per-model block (union of session + lifetime model ids)
        const modelIds = new Set<string>([
          ...session.modelStats.keys(),
          ...lifetime.modelStats.keys(),
        ]);
        const filtered = filterModel ? [...modelIds].filter((m) => m === filterModel) : [...modelIds];

        if (filtered.length > 0) {
          lines.push(`### Per-model performance`);
          lines.push('');
          lines.push(`| Model | Scope | Calls | Avg TTFT (ms) | Avg tok/s | Prompt tokens | Last used |`);
          lines.push(`|-------|-------|------:|--------------:|----------:|--------------:|-----------|`);
          for (const modelId of filtered.sort()) {
            const s = session.modelStats.get(modelId);
            const l = lifetime.modelStats.get(modelId);
            if (s) {
              const avgTtft = s.ttftCalls > 0 ? Math.round(s.totalTtftMs / s.ttftCalls) : '—';
              const avgTokSec = s.perfCalls > 0 ? (s.totalTokPerSec / s.perfCalls).toFixed(1) : '—';
              lines.push(`| ${modelId} | session | ${s.calls} | ${avgTtft} | ${avgTokSec} | — | — |`);
            }
            if (l) {
              const avgTtft = l.ttftCalls > 0 ? Math.round(l.totalTtftMs / l.ttftCalls) : '—';
              const avgTokSec = l.perfCalls > 0 ? (l.totalTokPerSec / l.perfCalls).toFixed(1) : '—';
              const lastUsed = new Date(l.lastUsedAt).toISOString().slice(0, 10);
              lines.push(`| ${modelId} | lifetime | ${l.calls} | ${avgTtft} | ${avgTokSec} | ${l.totalPromptTokens.toLocaleString()} | ${lastUsed} |`);
            }
          }
          lines.push('');
        } else if (filterModel) {
          lines.push(`No history for model: \`${filterModel}\`. Try \`list_models\` to see what's been used.`);
          lines.push('');
        } else {
          lines.push(`No calls yet — delegate a task via \`chat\`, \`custom_prompt\`, \`code_task\`, or \`code_task_files\` to start building stats.`);
          lines.push('');
        }

        // Reasoning-token diagnostic (lifetime only — needs persistence to be meaningful)
        if (!filterModel) {
          // Sum reasoning tokens across all models. We store this per-model
          // in SQLite but not in the in-memory mirror, so fetch on demand.
          try {
            const rows = await getAllPerformance();
            const totalReasoning = rows.reduce((sum, r) => sum + (r.totalReasoningTokens || 0), 0);
            const totalCompletion = rows.reduce((sum, r) => sum + r.totalCompletionTokens, 0);
            if (totalCompletion > 0) {
              const pct = ((totalReasoning / totalCompletion) * 100).toFixed(1);
              lines.push(`### Reasoning-token overhead (lifetime)`);
              lines.push('');
              lines.push(`${totalReasoning.toLocaleString()} / ${totalCompletion.toLocaleString()} completion tokens spent on hidden reasoning (${pct}% of generation budget). ` +
                (parseFloat(pct) > 30
                  ? `**High** — consider loading a non-thinking model, or check that \`reasoning_effort\` is being honoured (see stderr logs).`
                  : parseFloat(pct) > 10
                    ? `Moderate — normal for thinking-model families.`
                    : `Low — reasoning is effectively suppressed.`));
              lines.push('');
            }
          } catch { /* best-effort — don't fail the tool call */ }
        }

        lines.push(`*Stats persist across restarts in \`~/.houtini-lm/model-cache.db\`.*`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'conversations': {
        if (!CONVERSATIONS_ENABLED) {
          return {
            content: [{ type: 'text', text: CONVERSATIONS_DISABLED_MESSAGE }],
            isError: true,
          };
        }

        const { action, conversation_id } = args as { action?: string; conversation_id?: string };
        if (action !== 'list' && action !== 'delete' && action !== 'clear') {
          return {
            content: [{ type: 'text', text: 'Error: action must be one of "list", "delete", "clear".' }],
            isError: true,
          };
        }

        const ownerResult = resolveConversationOwner(extra);
        if (ownerResult.kind === 'error') return ownerResult.result;
        const owner = ownerResult.owner;

        // list() runs the store's lazy TTL sweep as a side effect, so calling
        // it first — for every action, not just "list" — means delete/clear
        // below always act on conversations that are actually still alive
        // rather than reporting success for an id the sweep just expired.
        const summaries = conversations.list(owner);

        if (action === 'list') {
          return { content: [{ type: 'text', text: formatConversationList(summaries, CONVERSATION_TTL_MIN, Date.now()) }] };
        }

        if (action === 'delete') {
          if (conversation_id === undefined) {
            return {
              content: [{ type: 'text', text: 'Error: conversation_id is required for action: "delete".' }],
              isError: true,
            };
          }
          // Same message and isError regardless of whether conversation_id
          // never existed or belongs to a different owner — distinguishing
          // the two would let a caller probe for other owners' ids.
          if (!summaries.some((s) => s.id === conversation_id)) {
            return {
              content: [{ type: 'text', text: 'Error: this conversation has expired or is not available to you.' }],
              isError: true,
            };
          }
          conversations.delete(owner, conversation_id);
          return { content: [{ type: 'text', text: `Deleted conversation ${conversation_id}.` }] };
        }

        const cleared = conversations.clear(owner);
        return { content: [{ type: 'text', text: `Cleared ${cleared} conversation${cleared === 1 ? '' : 's'}.` }] };
      }

      case 'jobs': {
        if (!JOBS_ENABLED) {
          return { content: [{ type: 'text', text: JOBS_DISABLED_MESSAGE }], isError: true };
        }

        const { action, job_id, wait_ms, offset, limit } = args as {
          action?: string;
          job_id?: string;
          wait_ms?: number;
          offset?: number;
          limit?: number;
        };
        if (action !== 'list' && action !== 'get' && action !== 'delete') {
          return {
            content: [{ type: 'text', text: 'Error: action must be one of "list", "get", "delete".' }],
            isError: true,
          };
        }

        const ownerResult = resolveJobOwner(extra);
        if (ownerResult.kind === 'error') return ownerResult.result;
        const owner = ownerResult.owner;

        if (action === 'list') {
          return { content: [{ type: 'text', text: formatJobList(jobs.list(owner), Date.now()) }] };
        }

        if (job_id === undefined) {
          return {
            content: [{ type: 'text', text: `Error: job_id is required for action: "${action}".` }],
            isError: true,
          };
        }

        if (action === 'delete') {
          // jobs.delete() itself already checks ownership (see job-store.ts)
          // and returns false for a missing id, a wrong owner, or an
          // already-gone job — collapsed to one response so a caller can't
          // probe for other owners' job ids by comparing error text.
          const existed = jobs.delete(owner, job_id);
          if (!existed) return JOB_NOT_FOUND_RESULT;
          return { content: [{ type: 'text', text: `Deleted job ${job_id}.` }] };
        }

        // action === 'get' — optionally short-poll up to wait_ms (clamped to
        // 0-30000) before returning the job's current status.
        const waitMs = (() => {
          const n = Number(wait_ms);
          return Number.isFinite(n) && n > 0 ? Math.min(30_000, n) : 0;
        })();
        const JOB_GET_POLL_MS = 500;
        const deadline = Date.now() + waitMs;

        let record = jobs.get(owner, job_id);
        if (!record) return JOB_NOT_FOUND_RESULT;
        while ((record.state === 'pending' || record.state === 'running') && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Math.min(JOB_GET_POLL_MS, Math.max(0, deadline - Date.now()))));
          const next = jobs.get(owner, job_id);
          // Vanished mid-wait (e.g. a concurrent delete by this same owner —
          // a different owner could never see this id at all): same
          // not-found response as any other missing id, no distinct message.
          if (!next) return JOB_NOT_FOUND_RESULT;
          record = next;
        }

        if (record.state === 'completed') {
          const full = record.result ?? '';
          // `offset`/`limit` only ever apply to a completed job's `result` —
          // a `failed` job's `error` (returned via formatJobStatus below)
          // is never chunked; it's operator-facing diagnostic text, not the
          // large model output this feature exists to page through.
          const paged = offset !== undefined || limit !== undefined;
          if (!paged && (JOB_RESULT_INLINE_MAX_CHARS === 0 || full.length <= JOB_RESULT_INLINE_MAX_CHARS)) {
            // Byte-identical to what a synchronous call — or phase 13, before
            // this feature existed — would have returned (modulo JobStore's
            // own maxResultChars truncation; see job-store.ts's
            // truncateResult). No status line, no footer.
            return { content: [{ type: 'text', text: full }] };
          }
          // Either the caller explicitly asked for a window, or the result
          // exceeds the inline ceiling and phase 14-1's auto-chunking kicks
          // in. sliceResult clamps/adjusts offset and limit itself (see its
          // doc comment) — pass them through unvalidated.
          const slice = sliceResult(full, offset, limit, JOB_RESULT_INLINE_MAX_CHARS);
          // touch() extends this job's lastUsedAt so a multi-call pagination
          // sequence doesn't get swept by TTL or evicted by maxJobs pressure
          // mid-sequence — see job-store.ts's header and JobStore.touch()
          // doc comments. A plain (non-paged) get within the inline ceiling
          // deliberately does NOT touch(): it's a status check, not a read
          // of a large result, so it shouldn't extend the job's lifetime.
          jobs.touch(owner, job_id);
          // Next.limit echoes the caller's nominal request width (not
          // necessarily slice.end - slice.start, which sliceResult's S5 can
          // grow by one — see formatJobChunkFooter's doc comment) so a
          // paging loop sees a consistent requested chunk size across calls.
          // When the caller omitted `limit`, JOB_RESULT_INLINE_MAX_CHARS is
          // what sliceResult actually used as the window (ceiling > 0 is the
          // only way `paged` chunking continues past one call — see above).
          const echoLimit = limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : JOB_RESULT_INLINE_MAX_CHARS;
          return { content: [{ type: 'text', text: slice.text + formatJobChunkFooter(job_id, slice, echoLimit) }] };
        }
        return { content: [{ type: 'text', text: formatJobStatus(record, Date.now()) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

// HTTP transports need a fresh Server instance per session: a single
// StreamableHTTPServerTransport keys its response streams by JSON-RPC
// request id, so two concurrent sessions that both open with id 1 would
// collide and cross their responses. Stdio has exactly one peer, so it
// keeps using the single module-level `server` instance registered below.
function createHoutiniServer(): Server {
  const s = new Server(
    { name: 'houtini-lm', version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: SIDEKICK_INSTRUCTIONS },
  );
  s.setRequestHandler(ListResourcesRequestSchema, handleListResources);
  s.setRequestHandler(ReadResourceRequestSchema, handleReadResource);
  s.setRequestHandler(ListToolsRequestSchema, handleListTools);
  s.setRequestHandler(CallToolRequestSchema, handleCallTool);
  return s;
}

server.setRequestHandler(ListResourcesRequestSchema, handleListResources);
server.setRequestHandler(ReadResourceRequestSchema, handleReadResource);
server.setRequestHandler(ListToolsRequestSchema, handleListTools);
server.setRequestHandler(CallToolRequestSchema, handleCallTool);

// ── Remote (HTTP) transport ─────────────────────────────────────────
// Opt-in: unset/'stdio' leaves the single-peer stdio path (above) completely
// unchanged. 'http' switches to Streamable HTTP for containerised/remote
// deployments — see README for the mcp-auth-proxy sidecar story. This server
// does not authenticate HTTP requests itself.
const HOUTINI_LM_TRANSPORT = (process.env.HOUTINI_LM_TRANSPORT || 'stdio').toLowerCase();
const HOUTINI_LM_HTTP_PORT = Math.max(1, parseInt(process.env.HOUTINI_LM_HTTP_PORT || '3000', 10) || 3000);
const HOUTINI_LM_HTTP_HOST = process.env.HOUTINI_LM_HTTP_HOST || '0.0.0.0';
const HOUTINI_LM_HTTP_PATH = process.env.HOUTINI_LM_HTTP_PATH || '/mcp';

if (HOUTINI_LM_TRANSPORT !== 'stdio' && HOUTINI_LM_TRANSPORT !== 'http') {
  process.stderr.write(`[houtini-lm] Invalid HOUTINI_LM_TRANSPORT="${HOUTINI_LM_TRANSPORT}" — expected "stdio" or "http".\n`);
  process.exit(1);
}

type HoutiniSession = { server: Server; transport: StreamableHTTPServerTransport };

/**
 * Streamable HTTP entry point. Each new session (a POST with no
 * mcp-session-id) gets its own Server + transport pair so that concurrent
 * clients never share a request-id space — see createHoutiniServer() above.
 * Sessions persist in `sessions` until the client sends DELETE or the
 * transport reports onclose.
 */
async function startHttpTransport(): Promise<void> {
  const sessions = new Map<string, HoutiniSession>();

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(req, res).catch((err) => {
      process.stderr.write(`[houtini-lm] HTTP request failed: ${err instanceof Error ? err.stack || err.message : err}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      } else {
        res.end();
      }
    });
  });

  async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname !== HOUTINI_LM_HTTP_PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    if (sessionId !== undefined) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing session ID' }, id: null }));
      return;
    }

    const newServer = createHoutiniServer();
    // enableJsonResponse is intentionally omitted (default false = SSE):
    // setting it true makes the SDK answer each request with a single JSON
    // body instead of an SSE stream, and notifications/progress is only
    // written to the SSE branch — turning this on would silently kill the
    // keepalive pings during long inference calls.
    // enableDnsRebindingProtection is intentionally omitted (default false):
    // this server sits behind mcp-auth-proxy, which terminates the public
    // Host header before proxying here, so protection belongs there.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server: newServer, transport });
      },
    });
    transport.onclose = () => {
      // The session id is only the conversation owner key when
      // CONVERSATION_OWNER_HEADER is unset — in that mode, discarding this
      // session's conversations along with the session itself is correct:
      // once the MCP session is gone there is no way left to reach them
      // anyway. onclose only fires on an explicit DELETE or close, never on
      // a transient SSE disconnect, so this can't wipe conversations out
      // from under a client that's still mid-stream.
      // In header mode the owner key is the authenticated user identity,
      // not the session id, so a conversation outlives the MCP session that
      // created it by design — it's discarded only via `delete`, `clear`,
      // or idle TTL expiry (see resolveConversationOwner()).
      //
      // Same reasoning applies to jobs (phase 13) — resolveJobOwner() uses
      // the identical session-id-vs-header split, so jobs.clear() is gated
      // on the same CONVERSATION_OWNER_HEADER === '' check.
      if (transport.sessionId) {
        if (CONVERSATION_OWNER_HEADER === '') {
          conversations.clear(transport.sessionId);
          jobs.clear(transport.sessionId);
        }
        sessions.delete(transport.sessionId);
      }
    };
    await newServer.connect(transport);
    // Do not pre-read `req` — handing it to handleRequest as a live stream
    // lets the transport parse the body itself. Reading it first would
    // consume the stream and hang the transport's own read.
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(HOUTINI_LM_HTTP_PORT, HOUTINI_LM_HTTP_HOST, () => resolve());
  });
  process.stderr.write(`Houtini LM server running (${redactUrl(LM_BASE_URL)}) — http transport on ${HOUTINI_LM_HTTP_HOST}:${HOUTINI_LM_HTTP_PORT}${HOUTINI_LM_HTTP_PATH}\n`);
  if (CONVERSATION_OWNER_HEADER !== '') {
    process.stderr.write(`[houtini-lm] conversation owner header: ${CONVERSATION_OWNER_HEADER}\n`);
  }

  const shutdown = () => {
    void (async () => {
      for (const { transport } of sessions.values()) {
        await transport.close().catch(() => {});
      }
      httpServer.close(() => process.exit(0));
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function main() {
  if (HOUTINI_LM_TRANSPORT === 'http') {
    await startHttpTransport();
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`Houtini LM server running (${redactUrl(LM_BASE_URL)})\n`);
  }

  // Background: profile all available models via HF → SQLite cache
  // Non-blocking — server is already accepting requests
  listModelsRaw()
    .then((models) => profileModelsAtStartup(models))
    .catch((err) => process.stderr.write(`[houtini-lm] Startup profiling skipped: ${err}\n`));

  // Hydrate the in-memory lifetime mirror from SQLite so the very first
  // tool call this session shows historical savings + per-model perf.
  // Non-blocking too; the footer degrades to session-only if this fails.
  hydrateLifetimeFromDb().catch((err) =>
    process.stderr.write(`[houtini-lm] Lifetime hydration skipped: ${err}\n`),
  );
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
