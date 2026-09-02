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
 *
 * Phase 14-1 ("output-side chunking"): `jobs get` returning a huge result
 * in one response just moves phase 13's original payload-limit problem
 * from the input side to the output side. `sliceResult`/
 * `formatJobChunkFooter` below let index.ts return a completed job's
 * result across several `jobs get` calls instead of one. They operate in
 * UTF-16 code units (`.length`/`.slice()`'s native unit) rather than
 * `truncateResult`'s code-point counting above — `sliceResult` runs on
 * every chunked `get`, so it needs to stay O(1)/O(chunk), not O(n) over
 * the whole result via `Array.from()` — and instead adjust the requested
 * window at its edges so it never bisects a UTF-16 surrogate pair (see
 * `sliceResult`'s doc comment for the exact steps). The extraction
 * contract this produces — "the first `end - start` characters of the
 * response are the chunk body, the rest is the footer" — exists because
 * that boundary adjustment means the actual `start`/`end` reached can
 * differ from the `offset`/`limit` the caller asked for; a caller that
 * tried to compute its own next `offset` by arithmetic could drift off by
 * one instead of following the footer's literal `Next` value.
 * `JobStore.touch()` (below) exists alongside this because a job being
 * paged through one chunk at a time can easily outlive the TTL window
 * that's measured from its *completion* time — see that method's doc
 * comment for why it's a separate method rather than folded into `get()`.
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
  /**
   * Length of the stored result body, in UTF-16 code units — 0 for
   * pending/running/failed jobs, which have no `result` (phase 14-1: lets
   * a caller decide, before calling `get`, whether a completed job's
   * result is large enough to arrive in multiple chunks). This is a
   * character count only, not the content itself, so it doesn't reopen
   * the "structurally unavailable" leak `formatJobList`'s doc comment
   * describes below. It also doesn't distinguish "not yet completed" from
   * "completed with an empty result" — both report 0 — callers needing
   * that distinction already have `state` for it.
   */
  resultChars: number;
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
  return {
    id: entry.id,
    tool: entry.tool,
    state: entry.state,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
    resultChars: entry.result?.length ?? 0,
  };
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

/** True if `code` is a UTF-16 high (leading) surrogate. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** True if `code` is a UTF-16 low (trailing) surrogate. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * A window into a job's result body, in UTF-16 code units — the same unit
 * `.length`/`.slice()` use, so `resultChars` (below) and `total` here stay
 * O(1) and consistent with each other. `end` is exclusive, matching
 * `text.slice(start, end)`.
 *
 * `start`/`end` are NOT guaranteed to equal the `offset`/`limit` the
 * caller requested — `sliceResult()` adjusts them to avoid bisecting a
 * UTF-16 surrogate pair (see that function's doc comment). This is why
 * `formatJobChunkFooter` hands the caller the *actual* `end` reached
 * rather than expecting it to compute `offset + limit` itself: the
 * extraction contract is "the first `end - start` characters of the
 * response text are the chunk body, the remainder is the footer" — the
 * caller never needs to know the adjusted `start` on its own.
 */
export interface JobResultSlice {
  text: string;
  start: number;
  end: number;
  total: number;
}

/**
 * Extract a window of `text` for chunked `jobs get` retrieval (phase 14-1),
 * clamping out-of-range `offset`/`limit` and adjusting the window so it
 * never bisects a UTF-16 surrogate pair (e.g. an emoji) — `text.slice()`
 * alone would happily split one, leaving an unpaired surrogate in the
 * returned chunk.
 *
 * Runs five fixed steps, in this order (S1–S5 in the phase 14-1 decision
 * record — `.claude/phases/phase14-mcp-payload-blobs.md`'s フェーズ14-1
 * section is authoritative; this comment is a restatement, not the source):
 *
 *   S1. Clamp `offset`/`limit` into a starting `start` and a window `span`.
 *       Never throws on bad input — `offset`/`limit` come straight from an
 *       MCP tool call's arguments, which is exactly the kind of
 *       caller-typo-prone input this function exists to absorb, not reject.
 *   S2. If `start` lands on the low half of a surrogate pair, step it back
 *       one code unit so the chunk begins at the pair's high half. This
 *       only fires when a caller supplies an `offset` mid-pair by hand
 *       (ignoring `formatJobChunkFooter`'s `Next.offset`, which always
 *       lands on a boundary S4 already cleared) — the resulting chunk then
 *       overlaps the previous one by one code unit. Overlap-over-corruption
 *       is the intended tradeoff: never emitting a half surrogate outranks
 *       never repeating one.
 *   S3. Compute `end = start + span`, clamped to `total`, from the `start`
 *       S2 may have moved.
 *   S4. If `end` lands on the low half of a pair, step it back one code
 *       unit so the pair goes to the *next* chunk instead of being split.
 *   S5. S4 can leave `end === start` when the window opened exactly on a
 *       pair's high half with a 1-unit `span` (`limit: 1`) — stepping `end`
 *       forward by 1 in that case would land back on the same low
 *       surrogate S4 just backed away from (still mid-pair, still no
 *       progress). Instead this step grants the *whole* pair
 *       (`end = min(start + 2, total)`), the only way to guarantee
 *       `end > start` (see the invariant below) without reintroducing the
 *       split S4 exists to prevent. A caller that repeatedly asks for
 *       `limit: 1` against surrogate-pair text will therefore see
 *       2-character chunks there, not 1 — an intentional, documented
 *       exception to "you get at most `limit` characters", chosen over the
 *       alternative of never making progress.
 *
 * Invariant, true for every return value (and load-bearing for a caller
 * paging in a loop off `Next.offset` until it sees a "final chunk"
 * footer): `0 <= start <= end <= total`, and whenever `start < total`,
 * `end > start` — every call that isn't already at the end of the text
 * makes forward progress. Isolated surrogates (a lone high or low
 * surrogate with no partner — already-malformed input, not something this
 * function creates) are left untouched by S2/S4/S5: the "is this code unit
 * part of a pair" check requires *both* halves to be present, so an
 * isolated surrogate never matches it.
 */
export function sliceResult(text: string, offset: number | undefined, limit: number | undefined, ceiling: number): JobResultSlice {
  const total = text.length;

  // S1: clamp offset -> start.
  let start: number;
  if (offset === undefined || !Number.isFinite(offset)) {
    start = 0;
  } else {
    start = Math.floor(offset);
    if (start < 0) start = 0;
  }
  if (start > total) start = total;

  // S1: clamp limit -> span, the window width to apply from `start`.
  let span: number;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    span = ceiling > 0 ? ceiling : total - start;
  } else {
    span = Math.floor(limit);
    if (ceiling > 0 && span > ceiling) span = ceiling;
  }

  // S2: don't start mid-pair.
  if (start > 0 && start < total && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start -= 1;
  }

  // S3: window from the (possibly S2-adjusted) start.
  let end = Math.min(start + span, total);

  // S4: don't end mid-pair — push the pair into the next chunk instead.
  if (start < end && end < total && isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }

  // S5: degenerate case — S4 left no progress. Grant the whole pair rather
  // than split it (see the doc comment above; `end += 1` here would still
  // land mid-pair and stall forward progress).
  if (end === start && start < total) {
    end = Math.min(start + 2, total);
  }

  return { text: text.slice(start, end), start, end, total };
}

/**
 * Render the footer appended after a chunked `jobs get` result (phase
 * 14-1). This is a machine-readable instruction line for the calling LLM,
 * not decorative text — its exact wording is a fixed contract asserted by
 * unit tests (scripts/test-job-store.mjs), so don't reword it casually.
 *
 * Extraction contract: the response text's first `slice.end - slice.start`
 * characters are the chunk body; everything from this footer's leading
 * `\n\n` onward is metadata. A caller must not compute the next `offset`
 * itself — `slice.start`/`slice.end` can differ from the `offset`/`limit`
 * it originally requested (see `sliceResult`'s doc comment) — it copies
 * `Next` verbatim into its following `jobs get` call instead.
 *
 * `limit` is the caller-visible request size to echo back in `Next.limit`
 * for the *next* chunk — not necessarily `slice.end - slice.start` (which
 * can be one character larger than requested, per `sliceResult`'s S5) or
 * `slice.total - slice.end` (the true remainder). Repeating the same
 * nominal size keeps successive chunks a consistent requested width
 * despite `sliceResult`'s ±1 boundary adjustments; index.ts (phase 14-1b)
 * is responsible for choosing the value passed here.
 */
export function formatJobChunkFooter(id: string, slice: JobResultSlice, limit: number): string {
  if (slice.start === slice.end) {
    return `\n\n--- job result chunk: chars ${slice.start}-${slice.end} of ${slice.total} (end-exclusive, empty: offset is at or beyond end of result) ---`;
  }
  if (slice.end >= slice.total) {
    return `\n\n--- job result chunk: chars ${slice.start}-${slice.end} of ${slice.total} (end-exclusive, end of result) ---`;
  }
  return `\n\n--- job result chunk: chars ${slice.start}-${slice.end} of ${slice.total} (end-exclusive) ---\nNext: ${JSON.stringify({ action: 'get', id, offset: slice.end, limit })}`;
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

  /**
   * Update `lastUsedAt` for a job without changing its state — used when a
   * caller pages through a large completed result via `jobs get`'s
   * offset/limit (phase 14-1), so a job still being read isn't swept by
   * TTL or evicted by `maxJobs` overflow mid-pagination. Deliberately not
   * folded into `get()`: a plain status poll (a `get()` with no
   * offset/limit) should not extend a job's lifetime — only an actual read
   * of the result body should.
   *
   * Returns true if a job existed for this owner and its timestamp was
   * updated; false (no-op, no throw) for a missing id or wrong owner,
   * matching `delete()`'s no-op contract. Does not sweep first — sweeping
   * here could delete the very entry being touched a moment before update.
   */
  touch(owner: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return false;
    entry.lastUsedAt = this.options.now();
    return true;
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
 * structurally unavailable. The `chars` column (phase 14-1) is
 * `JobSummary.resultChars` — a length only, not the body itself — so this
 * stays true even with the column added.
 */
export function formatJobList(summaries: JobSummary[], now: number): string {
  if (summaries.length === 0) {
    return 'No active or recent jobs. Submit one by calling custom_prompt or code_task_files with async: true.';
  }

  const sorted = [...summaries].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  const lines: string[] = [];
  lines.push('| job_id | tool | state | age | chars |');
  lines.push('|---|---|---|---|---|');
  for (const s of sorted) {
    const ageMin = (now - s.createdAt) / 60_000;
    lines.push(`| ${s.id} | ${s.tool} | ${s.state} | ${formatMinutes(ageMin)} | ${s.resultChars} |`);
  }
  lines.push('*Only your own jobs are listed.*');

  return lines.join('\n');
}
