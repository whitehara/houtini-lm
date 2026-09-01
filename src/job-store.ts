/**
 * job-store.ts — in-memory, TTL-bounded store for asynchronous job execution
 * (phase 13: "async job execution"). Pure logic, no MCP/SDK/network imports —
 * index.ts wires this to the custom_prompt and code_task_files handlers plus
 * a new `jobs` tool.
 *
 * Why in-memory and not node:sqlite (like model-cache.ts): a job's result is
 * the caller's actual prompt output — the same kind of content
 * conversation-store.ts already refuses to persist, for the same reason.
 * Persisting it to disk on a shared remote instance (this server runs behind
 * mcp-auth-proxy for multiple OIDC-authenticated users) would leave that
 * content sitting on disk indefinitely. Losing pending/running/completed jobs
 * on process restart or redeploy is an accepted, documented tradeoff (see
 * README "Async jobs") — a restart kills any in-flight inference anyway, so
 * persisting only completed results would save little while still leaving
 * response bodies on disk. Not an oversight.
 *
 * Multi-tenant safety: every job is scoped to an *owner* key supplied by the
 * caller, resolved the same way conversation-store.ts's owner is (see that
 * module's header) — this store treats `owner` as an opaque string and does
 * no resolution of its own. Unlike conversation-store.ts, the map here is
 * keyed by job id alone (ids are `randomUUID()` output, never caller-chosen
 * at creation time), with `owner` carried as a field on the entry and checked
 * on every owner-scoped access (get/list/delete/clear) — so there is no
 * makeKey()-style string-concatenation collision to defend against the way
 * conversation-store.ts's owner+id key space has to. The internal
 * `markRunning`/`markCompleted`/`markFailed`/`takeNextPending` methods are
 * *not* owner-scoped: they're called only by the job runner in index.ts,
 * which already holds the correct id from the job it created — there is no
 * caller-supplied owner to check there.
 *
 * No timers: same reasoning as conversation-store.ts — `setInterval` would
 * pin a stdio server process's event loop open and block clean exit. Expiry
 * is a lazy sweep: every owner-scoped call (get/list) removes TTL-expired
 * entries before doing its own work. Only `completed`/`failed` jobs are
 * TTL-eligible; `pending`/`running` jobs are never swept — sweeping a running
 * job would orphan the job runner's in-flight `markCompleted`/`markFailed`
 * call (see the "state transition defence" note below). delete/clear/size/
 * countActive intentionally do *not* sweep first, matching
 * conversation-store.ts's rationale: operating on an already-expired entry a
 * moment before the next sweep would clear it anyway is not observably
 * different.
 *
 * State transition defence: markRunning/markCompleted/markFailed return
 * `false` and do nothing (no throw) when the target record is missing or not
 * in the expected prior state (e.g. the job was deleted mid-flight, or the
 * caller races a duplicate completion). The job runner (index.ts) is
 * expected to ignore this return value — a job that vanished out from under
 * it isn't a bug to surface, just a caller that no longer cares about the
 * result. Throwing here instead would turn a harmless race into an
 * unhandled rejection in the job runner's background execution, which is
 * exactly the failure mode phase 13 exists to avoid.
 */

import { randomUUID } from 'node:crypto';

export type JobState = 'pending' | 'running' | 'completed' | 'failed';

/** Which MCP tool a job was submitted through. Phase 13 covers only these two. */
export type JobTool = 'custom_prompt' | 'code_task_files';

export interface JobStoreOptions {
  /** Idle-expiry window in milliseconds for completed/failed jobs, measured from lastUsedAt. */
  ttlMs: number;
  /** Max jobs across *all* owners combined; oldest completed/failed job (by lastUsedAt) is evicted on overflow. Pending/running jobs are never evicted, so this is a soft target, not a hard cap. */
  maxJobs: number;
  /** Max chars retained in a job's result body; excess is truncated from the tail. */
  maxResultChars: number;
  /**
   * Clock, called fresh every time a timestamp is needed — never cached.
   * Tests inject a mutable clock here to advance time without real delays;
   * caching `now()` once in the constructor would make that impossible.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

interface JobEntry {
  owner: string;
  id: string;
  tool: JobTool;
  state: JobState;
  createdAt: number;
  lastUsedAt: number;
  result?: string;
  error?: string;
}

/** Full job detail, as returned by get(). No `owner` field — the caller already knows its own owner. */
export interface JobRecord {
  id: string;
  tool: JobTool;
  state: JobState;
  createdAt: number;
  lastUsedAt: number;
  result?: string;
  error?: string;
}

/** Lightweight job overview, as returned by list() — omits result/error bodies so listing many jobs stays cheap. */
export interface JobSummary {
  id: string;
  tool: JobTool;
  state: JobState;
  createdAt: number;
  lastUsedAt: number;
}

function toRecord(entry: JobEntry): JobRecord {
  return {
    id: entry.id,
    tool: entry.tool,
    state: entry.state,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    result: entry.result,
    error: entry.error,
  };
}

function toSummary(entry: JobEntry): JobSummary {
  return { id: entry.id, tool: entry.tool, state: entry.state, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt };
}

/**
 * Truncate `text` to at most `maxChars` Unicode code points (not UTF-16 code
 * units), appending a `[truncated]` marker when truncation occurs. Splitting
 * on `.length`/`.slice()` alone can bisect a surrogate pair (e.g. an emoji),
 * corrupting the tail character; `Array.from()` iterates by code point and
 * avoids that.
 */
function truncateResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text; // fast path: UTF-16 length is always >= code point count, so this can't false-negative
  const codepoints = Array.from(text);
  if (codepoints.length <= maxChars) return text;
  return `${codepoints.slice(0, maxChars).join('')} [truncated]`;
}

export class JobStore {
  private readonly entries = new Map<string, JobEntry>();
  private readonly options: Required<JobStoreOptions>;

  constructor(options: JobStoreOptions) {
    this.options = { now: Date.now, ...options };
  }

  /** Remove TTL-expired completed/failed jobs. Pending/running jobs are never swept — see module header. */
  private sweep(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.state !== 'completed' && entry.state !== 'failed') continue;
      if (now - entry.lastUsedAt > this.options.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  /** Oldest completed/failed job by lastUsedAt, or undefined if none is evictable (all pending/running). */
  private oldestEvictableId(): string | undefined {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.state !== 'completed' && entry.state !== 'failed') continue;
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestId = id;
      }
    }
    return oldestId;
  }

  /** Create a new job in `pending` state. Returns its id. */
  create(owner: string, tool: JobTool): string {
    const now = this.options.now();
    this.sweep(now);
    if (this.entries.size >= this.options.maxJobs) {
      const evictId = this.oldestEvictableId();
      // If nothing is evictable (every job is pending/running), proceed anyway —
      // maxJobs is a soft target here; the active-job ceiling is enforced
      // separately (HOUTINI_LM_JOB_ACTIVE_MAX_PER_OWNER / _CONCURRENCY in
      // index.ts, phase 13-2), not by refusing to create a record.
      if (evictId !== undefined) this.entries.delete(evictId);
    }
    const id = randomUUID();
    this.entries.set(id, { owner, id, tool, state: 'pending', createdAt: now, lastUsedAt: now });
    return id;
  }

  get(owner: string, id: string): JobRecord | undefined {
    const now = this.options.now();
    this.sweep(now);
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return undefined;
    return toRecord(entry);
  }

  list(owner: string): JobSummary[] {
    const now = this.options.now();
    this.sweep(now);
    const out: JobSummary[] = [];
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue;
      out.push(toSummary(entry));
    }
    return out;
  }

  /** True if a job existed for this owner and was removed. False for a missing id, wrong owner, or already-gone job — deleting a pending/running job here does not stop the in-flight inference; see module header. */
  delete(owner: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return false;
    return this.entries.delete(id);
  }

  /** Remove every job owned by `owner`, regardless of state. Returns the count removed. */
  clear(owner: string): number {
    let count = 0;
    for (const [id, entry] of this.entries) {
      if (entry.owner === owner) {
        this.entries.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Total job count across all owners, all states. No sweep — a diagnostic/test accessor, not a source of truth for TTL state. */
  size(): number {
    return this.entries.size;
  }

  /** Count of `owner`'s pending+running jobs — the figure HOUTINI_LM_JOB_ACTIVE_MAX_PER_OWNER (phase 13-2) is checked against. No sweep — pending/running jobs are never TTL-eligible anyway. */
  countActive(owner: string): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.owner === owner && (entry.state === 'pending' || entry.state === 'running')) n++;
    }
    return n;
  }

  /**
   * pending → running. Returns true on success, false (no-op, no throw) if
   * the record is missing or not currently `pending` — see the module
   * header's "state transition defence" note.
   */
  markRunning(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'pending') return false;
    entry.state = 'running';
    entry.lastUsedAt = this.options.now();
    return true;
  }

  /**
   * running → completed, storing `result` (truncated to maxResultChars).
   * Returns true on success, false (no-op, no throw) if the record is
   * missing or not currently `running`.
   */
  markCompleted(id: string, result: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'running') return false;
    entry.state = 'completed';
    entry.result = truncateResult(result, this.options.maxResultChars);
    entry.lastUsedAt = this.options.now();
    return true;
  }

  /**
   * running → failed, storing `error`. Returns true on success, false
   * (no-op, no throw) if the record is missing or not currently `running`.
   */
  markFailed(id: string, error: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'running') return false;
    entry.state = 'failed';
    entry.error = error;
    entry.lastUsedAt = this.options.now();
    return true;
  }

  /**
   * Claim the oldest `pending` job (insertion order — Map iteration order is
   * insertion order in JS, and pending jobs stay put until claimed, so the
   * first pending entry encountered is the oldest) and transition it to
   * `running` in the same call. Returns the claimed record, or undefined if
   * no pending job exists. The existence/state re-check on the freshly
   * fetched entry (rather than trusting the value seen during iteration) is
   * what makes this safe to call from a synchronous pump loop that might
   * otherwise race a concurrent delete of the same id within one call.
   */
  takeNextPending(): JobRecord | undefined {
    for (const candidate of this.entries.values()) {
      if (candidate.state !== 'pending') continue;
      const entry = this.entries.get(candidate.id);
      if (!entry || entry.state !== 'pending') continue;
      entry.state = 'running';
      entry.lastUsedAt = this.options.now();
      return toRecord(entry);
    }
    return undefined;
  }
}

/**
 * Build the one-line summary returned when a custom_prompt/code_task_files
 * call is submitted with `async: true`. Returns a line with no leading or
 * trailing newline — callers prepend `\n` themselves, matching the existing
 * `suggestionLine` convention in index.ts.
 */
export function formatJobSubmitted(id: string, tool: JobTool, inputTokensEstimate: number, prefillSecEstimate: number, ttlMin: number): string {
  return `🚀 Job ${id} submitted (${tool}, ~${inputTokensEstimate} input tokens, est. ~${prefillSecEstimate}s prefill). Poll with jobs get, job_id: "${id}". Result kept for ${ttlMin}min after completion.`;
}

/** Render a duration in minutes the way formatJobList's table does — floor to whole minutes, `<1m` below one. */
function formatMinutes(minutes: number): string {
  const floored = Math.floor(minutes);
  return floored < 1 ? '<1m' : `${floored}m`;
}

/**
 * Build the markdown output for the `jobs` tool's `get` action. When the job
 * is `completed`, the result body itself is returned as-is (the caller is
 * expected to present `record.result` directly, not this string) — this
 * function only renders the *status* line, used for `pending`/`running`/
 * `failed` states and prepended above the result for `completed`.
 */
export function formatJobStatus(record: JobRecord, now: number): string {
  const elapsedSec = Math.floor((now - record.createdAt) / 1000);
  switch (record.state) {
    case 'pending':
      return `⏳ Job ${record.id}: pending (queued ${elapsedSec}s ago). Not started yet — try a longer wait_ms, or poll again shortly.`;
    case 'running':
      return `⏳ Job ${record.id}: running (${elapsedSec}s elapsed). Poll again, optionally with a longer wait_ms.`;
    case 'failed':
      return `❌ Job ${record.id}: failed after ${elapsedSec}s. ${record.error ?? '(no error message recorded)'}`;
    case 'completed':
      return `✅ Job ${record.id}: completed in ${elapsedSec}s.`;
  }
}

/**
 * Build the markdown output for the `jobs` tool's `list` action. Takes only
 * `JobSummary` — which has no result/error field — so returning another
 * job's output here isn't a possible bug to introduce later, it's
 * structurally unavailable.
 */
export function formatJobList(summaries: JobSummary[], now: number): string {
  if (summaries.length === 0) {
    return 'No active or recent jobs. Submit one by calling custom_prompt or code_task_files with async: true.';
  }

  const sorted = [...summaries].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  const lines: string[] = [];
  lines.push('| job_id | tool | state | age |');
  lines.push('|---|---|---|---|');
  for (const s of sorted) {
    const ageMin = (now - s.createdAt) / 60_000;
    lines.push(`| ${s.id} | ${s.tool} | ${s.state} | ${formatMinutes(ageMin)} |`);
  }
  lines.push('*Only your own jobs are listed.*');

  return lines.join('\n');
}
