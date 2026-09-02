/**
 * blob-store.ts — in-memory, TTL-bounded store for chunked payload upload
 * (phase 14-2: "input-side blob store"). Pure logic, no MCP/SDK/network
 * imports — index.ts (phase 14-3, not yet wired) will expose this via a new
 * `blobs` tool and `custom_prompt`'s `context_blob_id`.
 *
 * Why in-memory and not node:sqlite (like model-cache.ts): a blob's content
 * is caller-uploaded prompt input, the same category of content
 * conversation-store.ts and job-store.ts already refuse to persist to disk.
 * `houtini-lm-state` (the node:sqlite volume) happens to be a local volume
 * rather than NFS, so this isn't a latency concern — the objection is the
 * existing multi-tenant policy those two modules already state: this server
 * runs behind mcp-auth-proxy for multiple OIDC-authenticated users, and
 * leaving their uploaded content sitting on disk indefinitely is not
 * something a process restart should be able to avoid by construction.
 * Losing open/sealed blobs on restart or redeploy is an accepted, documented
 * tradeoff, not an oversight.
 *
 * Multi-tenant safety: every blob is scoped to an *owner* key supplied by
 * the caller, resolved the same way conversation-store.ts's and
 * job-store.ts's owner is (see either module's header) — this store treats
 * `owner` as an opaque string and does no resolution of its own (deferred to
 * `resolveOwnerKey()` in index.ts, phase 14-3). The map here is keyed by
 * blob id alone (ids are `randomUUID()` output, never caller-chosen), with
 * `owner` carried as a field on the entry and checked on every owner-scoped
 * access — job-store.ts's pattern, not conversation-store.ts's composite
 * `owner:id` key, since blob ids are never caller-supplied and so can't
 * collide across owners the way a caller-chosen conversation id could.
 *
 * No timers: same reasoning as the other two stores — `setInterval` would
 * pin a stdio server process's event loop open and block clean exit. Expiry
 * is a lazy sweep: every call removes TTL-expired entries before doing its
 * own work. Unlike job-store.ts, this sweep applies to *both* `open` and
 * `sealed` blobs, not just a terminal state — a job has a server-side
 * in-flight process (the job runner) that sweeping a `pending`/`running`
 * entry would orphan; a blob has no such process. An `open` blob is just
 * data sitting in a Map, and exempting it from TTL would let an abandoned
 * upload (a client that started `blobs create`/`append` and never came
 * back) leak forever instead of eventually being reclaimed.
 *
 * Overflow is a hard reject, not job-store.ts's soft evict-oldest: a job's
 * result is server-computed and can be silently discarded and recomputed by
 * the caller retrying; a blob's content exists *only* on the client that
 * uploaded it and the server has no way to reconstruct a partially-evicted
 * upload. Evicting an in-progress blob to make room for a new `create` would
 * turn a capacity limit into a silent, hard-to-diagnose `not_found` on the
 * client's *next* `append` call instead of an immediate, actionable error on
 * the call that actually hit the limit.
 *
 * sha256 is computed and verified exactly once, at `seal` time, over the
 * *whole* concatenated body — never incrementally per chunk. A chunk
 * boundary chosen by the client can land in the middle of a UTF-16
 * surrogate pair (the same hazard `sliceResult` in job-store.ts guards
 * against on the output side); encoding each half of a split pair to UTF-8
 * independently produces two mangled U+FFFD replacement characters instead
 * of the pair's real UTF-8 bytes, so a running hash updated chunk-by-chunk
 * would diverge from the hash of the joined string. Only join-then-hash is
 * guaranteed correct regardless of where the client happened to cut its
 * chunks.
 *
 * Memory ceiling (back-of-envelope, not a measured figure): maxTotalChars
 * (8,000,000) × 2 bytes/char for UTF-16 string storage ≈ 16MB steady-state,
 * plus up to ~4MB transient from `seal`'s hash computation flat-copying one
 * blob's `data` string into `createHash().update()` at once — call it a
 * ~20MB peak. See `.claude/phases/phase14-mcp-payload-blobs.md`'s フェーズ14-2
 * section (D12) for the full accounting this maps to.
 */

import { createHash, randomUUID } from 'node:crypto';

export type BlobState = 'open' | 'sealed';

export type BlobErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'seq_mismatch'
  | 'hash_mismatch'
  | 'too_large'
  | 'store_full'
  | 'store_chars_full';

/** A failed BlobStore call. `message` is a complete, `Error: `-prefix-free sentence — index.ts (phase 14-3) is responsible for any prefix it wants to add. */
export interface BlobFailure {
  ok: false;
  code: BlobErrorCode;
  message: string;
}

export type BlobResult<T> = { ok: true; value: T } | BlobFailure;

export interface BlobStoreOptions {
  /** Idle-expiry window in milliseconds, measured from lastUsedAt. Applies to open AND sealed blobs — see module header. */
  ttlMs: number;
  /** Max blobs across *all* owners combined, open+sealed both counted. Hard reject on overflow — see module header. */
  maxBlobs: number;
  /** Max chars retained in a single blob's body. Hard reject on overflow, checked on create(data) and append. */
  maxChars: number;
  /** Max total chars across *all* owners' blobs combined, open+sealed both counted. Hard reject on overflow, checked on create(data) and append. */
  maxTotalChars: number;
  /**
   * Clock, called fresh every time a timestamp is needed — never cached.
   * Tests inject a mutable clock here to advance time without real delays;
   * caching `now()` once in the constructor would make that impossible.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

interface BlobEntry {
  owner: string;
  id: string;
  state: BlobState;
  data: string;
  chunks: number;
  nextSeq: number;
  sha256?: string;
  createdAt: number;
  lastUsedAt: number;
}

/** Blob metadata, as returned by every BlobStore method. No `owner` field (the caller already knows its own owner) and no `data` field — the body is only ever returned by `read()`, and only once `sealed`. */
export interface BlobRecord {
  id: string;
  state: BlobState;
  chunks: number;
  chars: number;
  nextSeq: number;
  sha256?: string;
  createdAt: number;
  lastUsedAt: number;
}

function toRecord(entry: BlobEntry): BlobRecord {
  const record: BlobRecord = {
    id: entry.id,
    state: entry.state,
    chunks: entry.chunks,
    chars: entry.data.length,
    nextSeq: entry.nextSeq,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  };
  if (entry.sha256 !== undefined) record.sha256 = entry.sha256;
  return record;
}

export class BlobStore {
  private readonly entries = new Map<string, BlobEntry>();
  private readonly options: Required<BlobStoreOptions>;

  constructor(options: BlobStoreOptions) {
    this.options = { now: Date.now, ...options };
  }

  /** Remove TTL-expired entries — open AND sealed both, unlike job-store.ts's pending/running exemption. See module header. */
  private sweep(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.options.ttlMs) {
        this.entries.delete(id);
      }
    }
  }

  private fail(code: BlobErrorCode, message: string): BlobFailure {
    return { ok: false, code, message };
  }

  /**
   * Create a new blob in `open` state, owned by `owner`. With `data`
   * omitted, the blob starts empty (`nextSeq: 0`) and the caller uploads
   * its first chunk via `append(owner, id, 0, chunk)`. With `data` given
   * (including `data: ''`), it becomes the blob's seq-0 chunk immediately
   * (`nextSeq: 1`) — checked with `data !== undefined`, not a truthy check,
   * so an explicit empty string is correctly treated as a real first chunk
   * rather than "no data".
   */
  create(owner: string, data?: string): BlobResult<BlobRecord> {
    const now = this.options.now();
    this.sweep(now);

    if (data !== undefined && data.length > this.options.maxChars) {
      return this.fail('too_large', `initial data is ${data.length} chars, over the ${this.options.maxChars}-char per-blob limit. No blob was created.`);
    }
    if (this.entries.size >= this.options.maxBlobs) {
      return this.fail('store_full', `the server's global blob capacity is full (max ${this.options.maxBlobs} blobs). Delete a blob you no longer need, or retry shortly — idle blobs expire automatically.`);
    }
    if (data !== undefined && this.totalChars() + data.length > this.options.maxTotalChars) {
      return this.fail('store_chars_full', `the server's global blob memory budget is full (max ${this.options.maxTotalChars} chars). Delete a blob you no longer need, or retry shortly — idle blobs expire automatically.`);
    }

    const id = randomUUID();
    const entry: BlobEntry = {
      owner,
      id,
      state: 'open',
      data: data ?? '',
      chunks: data !== undefined ? 1 : 0,
      nextSeq: data !== undefined ? 1 : 0,
      createdAt: now,
      lastUsedAt: now,
    };
    this.entries.set(id, entry);
    return { ok: true, value: toRecord(entry) };
  }

  /**
   * Append the next chunk to an `open` blob. `seq` must equal the blob's
   * current `nextSeq` (chunks must arrive in order starting at 0) — a
   * mismatch leaves the blob completely unchanged and returns the expected
   * seq in the error message so the caller can self-correct and retry the
   * same chunk. `invalid_state`/`not_found` likewise leave the blob (if any)
   * unchanged.
   */
  append(owner: string, id: string, seq: number, data: string): BlobResult<BlobRecord> {
    const now = this.options.now();
    this.sweep(now);

    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) {
      return this.fail('not_found', `blob ${id} was not found or is not available to you.`);
    }
    if (entry.state !== 'open') {
      return this.fail('invalid_state', `blob ${id} is already sealed and cannot accept more chunks. Create a new blob if you need to upload more data.`);
    }
    if (seq !== entry.nextSeq) {
      return this.fail('seq_mismatch', `chunk seq mismatch for blob ${id}: expected seq ${entry.nextSeq}, got ${seq}. Chunks must arrive in order, starting at seq 0 — retry this chunk with seq: ${entry.nextSeq}.`);
    }
    const would = entry.data.length + data.length;
    if (would > this.options.maxChars) {
      return this.fail('too_large', `blob ${id} would grow to ${would} chars, over the ${this.options.maxChars}-char per-blob limit. The chunk was rejected and the blob is unchanged.`);
    }
    if (this.totalChars() + data.length > this.options.maxTotalChars) {
      return this.fail('store_chars_full', `the server's global blob memory budget is full (max ${this.options.maxTotalChars} chars). Delete a blob you no longer need, or retry shortly — idle blobs expire automatically.`);
    }

    entry.data += data;
    entry.chunks += 1;
    entry.nextSeq += 1;
    entry.lastUsedAt = now;
    return { ok: true, value: toRecord(entry) };
  }

  /**
   * Transition an `open` blob to `sealed`, computing its sha256 over the
   * full concatenated body (see module header for why this happens only
   * here, once, rather than incrementally per chunk). `expectedSha256`, if
   * given, is compared case-insensitively against the computed digest; a
   * mismatch returns `hash_mismatch` and leaves the blob `open` and
   * unchanged (not deleted — the error message tells the caller to delete
   * and re-upload themselves).
   */
  seal(owner: string, id: string, expectedSha256?: string): BlobResult<BlobRecord> {
    const now = this.options.now();
    this.sweep(now);

    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) {
      return this.fail('not_found', `blob ${id} was not found or is not available to you.`);
    }
    if (entry.state !== 'open') {
      return this.fail('invalid_state', `blob ${id} is already sealed.`);
    }

    const actual = createHash('sha256').update(entry.data, 'utf8').digest('hex');
    if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== actual.toLowerCase()) {
      return this.fail('hash_mismatch', `sha256 mismatch for blob ${id}: expected ${expectedSha256}, got ${actual}. The blob is left open and unchanged — delete it and re-upload.`);
    }

    entry.state = 'sealed';
    entry.sha256 = actual;
    entry.lastUsedAt = now;
    return { ok: true, value: toRecord(entry) };
  }

  /**
   * Read a `sealed` blob's full body. `sealed` is required — this is the
   * design's crux (see module header / phase file's D9): letting a caller
   * read an `open` blob would silently let an incomplete upload reach
   * inference with no signal that chunks are still missing.
   */
  read(owner: string, id: string): BlobResult<string> {
    const now = this.options.now();
    this.sweep(now);

    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) {
      return this.fail('not_found', `blob ${id} was not found or is not available to you.`);
    }
    if (entry.state !== 'sealed') {
      return this.fail('invalid_state', `blob ${id} is still open — seal it first with blobs seal before reading its content.`);
    }

    entry.lastUsedAt = now;
    return { ok: true, value: entry.data };
  }

  /** Metadata only (no body) for either state. Does not update lastUsedAt — a status check should not extend a blob's lifetime, only an actual create/append/seal/read should. */
  get(owner: string, id: string): BlobRecord | undefined {
    const now = this.options.now();
    this.sweep(now);
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return undefined;
    return toRecord(entry);
  }

  /** All of `owner`'s blobs, either state. Does not update lastUsedAt (see get()). */
  list(owner: string): BlobRecord[] {
    const now = this.options.now();
    this.sweep(now);
    const out: BlobRecord[] = [];
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue;
      out.push(toRecord(entry));
    }
    return out;
  }

  /** True if a blob existed for this owner (either state) and was removed. False for a missing id or wrong owner. Does not sweep first, matching job-store.ts's delete() rationale. */
  delete(owner: string, id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return false;
    return this.entries.delete(id);
  }

  /** Remove every blob owned by `owner`, regardless of state. Returns the count removed. */
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

  /** Total blob count across all owners, open+sealed both counted. No sweep — a diagnostic/test accessor, not a source of truth for TTL state. */
  size(): number {
    return this.entries.size;
  }

  /** Total char count across all owners' blob bodies, open+sealed both counted. No sweep (see size()). Used internally by create()/append() to enforce maxTotalChars. */
  totalChars(): number {
    let sum = 0;
    for (const entry of this.entries.values()) sum += entry.data.length;
    return sum;
  }
}

/** Render a duration in minutes the way formatBlobList's table does — floor to whole minutes, `<1m` below one. Local re-definition of job-store.ts's identical helper, not imported — matching the existing per-module duplication between conversation-store.ts and job-store.ts. */
function formatMinutes(minutes: number): string {
  const floored = Math.floor(minutes);
  return floored < 1 ? '<1m' : `${floored}m`;
}

/**
 * Build the one-line summary returned by the `blobs` tool's `create` action.
 * Returns a line with no leading or trailing newline — callers prepend `\n`
 * themselves, matching formatJobSubmitted's convention.
 */
export function formatBlobCreated(record: BlobRecord, ttlMin: number): string {
  return `📦 Blob ${record.id} created — ${record.chars} chars in ${record.chunks} chunk(s). Send the next chunk with blobs append, blob_id: "${record.id}", seq: ${record.nextSeq}. Seal it with blobs seal when done. Idle-expires in ${ttlMin}min.`;
}

/**
 * Build the one-line summary for the `blobs` tool's `append` action, and
 * also (by branching on `record.state`) the `seal` action — `seal()`'s
 * returned record is rendered through this same function rather than a
 * dedicated fourth formatter (D13). For the `open` branch, the just-accepted
 * chunk's seq is `record.nextSeq - 1` (nextSeq has already advanced past it).
 */
export function formatBlobAppended(record: BlobRecord, ttlMin: number): string {
  if (record.state === 'sealed') {
    return `📦 Blob ${record.id} sealed — ${record.chars} chars in ${record.chunks} chunk(s), sha256 ${record.sha256}. Use it with custom_prompt's context_blob_id: "${record.id}". Idle-expires in ${ttlMin}min.`;
  }
  const lastSeq = record.nextSeq - 1;
  return `📦 Blob ${record.id} — chunk ${lastSeq} accepted, ${record.chars} chars in ${record.chunks} chunk(s). Next chunk: seq ${record.nextSeq}, or seal with blobs seal. Idle-expires in ${ttlMin}min.`;
}

/**
 * Build the markdown output for the `blobs` tool's `list` action. Metadata
 * only — no body field, and no sha256 column (kept out for table width, per
 * D13); a caller wanting a sealed blob's sha256 uses `blobs seal`'s own
 * response or a subsequent `get`-shaped lookup once phase 14-3 wires one up.
 */
export function formatBlobList(records: BlobRecord[], ttlMin: number, now: number): string {
  if (records.length === 0) {
    return 'No blobs stored. Upload one with blobs create, then blobs append and blobs seal.';
  }

  const sorted = [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt);

  const lines: string[] = [];
  lines.push('| blob_id | state | chunks | chars | idle | expires in |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of sorted) {
    const idleMin = (now - r.lastUsedAt) / 60_000;
    const expiresMin = Math.max(0, (r.lastUsedAt + ttlMin * 60_000 - now) / 60_000);
    lines.push(`| ${r.id} | ${r.state} | ${r.chunks} | ${r.chars} | ${formatMinutes(idleMin)} | ${formatMinutes(expiresMin)} |`);
  }

  return lines.join('\n');
}
