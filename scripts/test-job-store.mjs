// Unit test for JobStore + formatJobSubmitted/formatJobStatus/formatJobList
// (phase 13: async job execution). Pure logic, no backend needed.
// Run: npm run test:jobs
import { JobStore, formatJobSubmitted, formatJobStatus, formatJobList, sliceResult, formatJobChunkFooter } from '../dist/job-store.js';

let failed = 0;
const eq = (name, got, want) => {
  const gotStr = JSON.stringify(got);
  const wantStr = JSON.stringify(want);
  const ok = gotStr === wantStr;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${gotStr}${ok ? '' : ` (want ${wantStr})`}\n`);
  if (!ok) failed++;
};
const ok = (name, cond) => {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!cond) failed++;
};

// A mutable injected clock — see conversation-store's test file for why this
// must be called fresh each time, never cached.
function makeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const DEFAULT_OPTS = { ttlMs: 60_000, maxJobs: 10, maxResultChars: 200_000 };

// Test-local helper (phase 14-1 assertions) — true if `ch` (a single JS
// string character) is a UTF-16 low surrogate. Independent of job-store.ts's
// internal isLowSurrogate(), which is not exported — this just checks the
// *observable* result never ends on a lone low half.
function isLowSurrogateChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

// --- basic lifecycle: create → pending → markRunning → markCompleted → get() ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-a';
  const id = store.create(owner, 'custom_prompt');
  ok('create() returns a string id', typeof id === 'string' && id.length > 0);
  eq('new job starts pending', store.get(owner, id).state, 'pending');
  ok('markRunning() succeeds on a pending job', store.markRunning(id) === true);
  eq('job is running after markRunning()', store.get(owner, id).state, 'running');
  ok('markCompleted() succeeds on a running job', store.markCompleted(id, 'the result') === true);
  const record = store.get(owner, id);
  eq('job is completed after markCompleted()', record.state, 'completed');
  eq('result is stored verbatim (under maxResultChars)', record.result, 'the result');
}

// --- markFailed lifecycle ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-b';
  const id = store.create(owner, 'code_task_files');
  store.markRunning(id);
  ok('markFailed() succeeds on a running job', store.markFailed(id, 'boom') === true);
  const record = store.get(owner, id);
  eq('job is failed after markFailed()', record.state, 'failed');
  eq('error is stored', record.error, 'boom');
}

// --- state transition defence: no-op + false, never throw ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-c';

  eq('markRunning() on unknown id → false, no throw', store.markRunning('no-such-id'), false);
  eq('markCompleted() on unknown id → false, no throw', store.markCompleted('no-such-id', 'x'), false);
  eq('markFailed() on unknown id → false, no throw', store.markFailed('no-such-id', 'x'), false);

  const pendingId = store.create(owner, 'custom_prompt');
  eq('markCompleted() on a still-pending job → false (wrong prior state)', store.markCompleted(pendingId, 'x'), false);
  eq('markFailed() on a still-pending job → false (wrong prior state)', store.markFailed(pendingId, 'x'), false);
  eq('pending job is unaffected by the rejected transitions', store.get(owner, pendingId).state, 'pending');

  store.markRunning(pendingId);
  eq('markRunning() on an already-running job → false (wrong prior state)', store.markRunning(pendingId), false);
}

// --- deletion race #1: takeNextPending() after the job was already deleted ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-d';
  const id = store.create(owner, 'custom_prompt');
  ok('delete() removes the pending job', store.delete(owner, id) === true);
  eq('takeNextPending() finds nothing after the only pending job was deleted', store.takeNextPending(), undefined);
}

// --- deletion race #2: markCompleted() targeting an already-deleted job ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-e';
  const id = store.create(owner, 'custom_prompt');
  store.markRunning(id);
  store.delete(owner, id);
  eq('markCompleted() on a deleted job → false, no throw', store.markCompleted(id, 'late result'), false);
  eq('markFailed() on a deleted job → false, no throw', store.markFailed(id, 'late error'), false);
  eq('the deleted job stays gone', store.get(owner, id), undefined);
}

// --- takeNextPending(): claims oldest pending, transitions to running, re-verifies on take ---
{
  const clock = makeClock(0);
  const store = new JobStore({ ...DEFAULT_OPTS, now: clock.now });
  const owner = 'session-f';
  const id1 = store.create(owner, 'custom_prompt');
  clock.advance(10);
  const id2 = store.create(owner, 'code_task_files');

  const taken = store.takeNextPending();
  eq('takeNextPending() claims the oldest (first-created) pending job', taken.id, id1);
  eq('takeNextPending() transitions the claimed job to running', store.get(owner, id1).state, 'running');
  eq('the other job is still pending', store.get(owner, id2).state, 'pending');

  const takenAgain = store.takeNextPending();
  eq('a second takeNextPending() claims the remaining pending job', takenAgain.id, id2);
  eq('nothing left to claim', store.takeNextPending(), undefined);
}

// --- TTL: only completed/failed jobs are swept; pending/running are immune ---
{
  const clock = makeClock(0);
  const store = new JobStore({ ttlMs: 1_000, maxJobs: 10, maxResultChars: 200_000, now: clock.now });
  const owner = 'session-g';

  const pendingId = store.create(owner, 'custom_prompt');
  const runningId = store.create(owner, 'custom_prompt');
  store.markRunning(runningId);
  const completedId = store.create(owner, 'custom_prompt');
  store.markRunning(completedId);
  store.markCompleted(completedId, 'done');

  clock.advance(5_000); // well past ttlMs=1_000

  eq('a pending job survives past ttlMs (never swept)', store.get(owner, pendingId)?.state, 'pending');
  eq('a running job survives past ttlMs (never swept)', store.get(owner, runningId)?.state, 'running');
  eq('a completed job is swept once idle past ttlMs', store.get(owner, completedId), undefined);
}

// --- maxJobs overflow: oldest completed/failed evicted; pending/running are never evicted ---
{
  const clock = makeClock(0);
  const store = new JobStore({ ttlMs: 60_000, maxJobs: 2, maxResultChars: 200_000, now: clock.now });
  const owner = 'session-h';

  const id1 = store.create(owner, 'custom_prompt');
  store.markRunning(id1);
  store.markCompleted(id1, 'first');
  clock.advance(10);

  const id2 = store.create(owner, 'custom_prompt');
  store.markRunning(id2);
  store.markCompleted(id2, 'second');
  clock.advance(10);

  eq('size() reflects 2 created jobs, at maxJobs', store.size(), 2);

  const id3 = store.create(owner, 'custom_prompt'); // pending, over capacity
  eq('size() stays at maxJobs after overflow (oldest completed evicted)', store.size(), 2);
  eq('the oldest completed job (id1) was evicted', store.get(owner, id1), undefined);
  ok('the newer completed job (id2) survives', store.get(owner, id2) !== undefined);
  ok('the newly-created pending job (id3) exists', store.get(owner, id3) !== undefined);
}

{
  // When every job is pending/running (nothing evictable), creation still
  // succeeds — maxJobs is a soft target, not a hard refusal. See job-store.ts
  // create() comment.
  const store = new JobStore({ ttlMs: 60_000, maxJobs: 1, maxResultChars: 200_000 });
  const owner = 'session-i';
  const id1 = store.create(owner, 'custom_prompt');
  store.markRunning(id1);
  const id2 = store.create(owner, 'custom_prompt'); // over capacity, nothing to evict
  ok('create() succeeds even over maxJobs when nothing is evictable', store.size() === 2);
  eq('the running job (id1) was not evicted', store.get(owner, id1)?.state, 'running');
  eq('the new pending job (id2) exists', store.get(owner, id2)?.state, 'pending');
}

// --- maxResultChars: truncation on completion, Unicode-boundary safe ---
{
  const store = new JobStore({ ttlMs: 60_000, maxJobs: 10, maxResultChars: 10 });
  const owner = 'session-j';
  const id = store.create(owner, 'custom_prompt');
  store.markRunning(id);
  store.markCompleted(id, 'x'.repeat(50));
  const record = store.get(owner, id);
  ok('oversized result is truncated', record.result.length < 50);
  ok('truncated result carries the [truncated] marker', record.result.includes('[truncated]'));
}

{
  // Unicode boundary: 12 astral-plane emoji (each a surrogate pair in UTF-16,
  // so .length reports 24) truncated to maxResultChars=5 code points must not
  // bisect a surrogate pair into an unpaired half.
  const store = new JobStore({ ttlMs: 60_000, maxJobs: 10, maxResultChars: 5 });
  const owner = 'session-k';
  const id = store.create(owner, 'custom_prompt');
  store.markRunning(id);
  const emoji = '😀'.repeat(12);
  store.markCompleted(id, emoji);
  const record = store.get(owner, id);
  const kept = record.result.replace(' [truncated]', '');
  eq('truncation counts by code point, not UTF-16 unit (5 emoji kept, not 2.5)', Array.from(kept).length, 5);
  ok('no unpaired surrogate in the truncated result (valid string, round-trips through Array.from)', Array.from(kept).join('') === kept);
}

{
  // Result under the limit is stored verbatim, no marker appended.
  const store = new JobStore({ ttlMs: 60_000, maxJobs: 10, maxResultChars: 200_000 });
  const owner = 'session-l';
  const id = store.create(owner, 'custom_prompt');
  store.markRunning(id);
  store.markCompleted(id, 'short result');
  eq('result under maxResultChars is stored verbatim, no [truncated] marker', store.get(owner, id).result, 'short result');
}

// --- owner isolation: get/delete/list from a different owner never see or affect the job ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const ownerA = 'session-m';
  const ownerB = 'session-n';
  const id = store.create(ownerA, 'custom_prompt');
  eq('get() from a different owner → undefined (no cross-tenant read)', store.get(ownerB, id), undefined);
  eq('delete() from a different owner → false (no cross-tenant delete)', store.delete(ownerB, id), false);
  ok('the job is untouched after the cross-owner attempts', store.get(ownerA, id) !== undefined);
  eq('delete() from the correct owner → true', store.delete(ownerA, id), true);
  eq('get() after delete → undefined', store.get(ownerA, id), undefined);
}

// --- list()/clear()/countActive() are scoped to a single owner ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const ownerA = 'session-o';
  const ownerB = 'session-p';
  const idA1 = store.create(ownerA, 'custom_prompt');
  const idA2 = store.create(ownerA, 'code_task_files');
  const idB1 = store.create(ownerB, 'custom_prompt');

  eq('list() returns only ownerA\'s 2 jobs', store.list(ownerA).map((j) => j.id).sort(), [idA1, idA2].sort());
  eq('list() returns only ownerB\'s 1 job', store.list(ownerB).map((j) => j.id), [idB1]);
  eq('countActive() counts only ownerA\'s pending jobs', store.countActive(ownerA), 2);
  eq('countActive() counts only ownerB\'s pending jobs', store.countActive(ownerB), 1);

  const cleared = store.clear(ownerA);
  eq('clear() returns the count removed for that owner', cleared, 2);
  eq('list() for ownerA is empty after clear()', store.list(ownerA), []);
  eq('ownerB is unaffected by ownerA\'s clear()', store.list(ownerB).map((j) => j.id), [idB1]);
}

// --- clear() removes pending/running jobs too, not just terminal ones ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-q';
  const pendingId = store.create(owner, 'custom_prompt');
  const runningId = store.create(owner, 'custom_prompt');
  store.markRunning(runningId);
  eq('clear() removes both a pending and a running job', store.clear(owner), 2);
  eq('the pending job is gone', store.get(owner, pendingId), undefined);
  eq('the running job is gone too (best-effort — the in-flight inference itself is not stopped)', store.get(owner, runningId), undefined);
}

// --- list() summary shape: no result/error field present ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-r';
  const id = store.create(owner, 'custom_prompt');
  store.markRunning(id);
  store.markCompleted(id, 'secret result body');
  const [summary] = store.list(owner);
  eq('list() summary: id matches', summary.id, id);
  eq('list() summary: tool matches', summary.tool, 'custom_prompt');
  eq('list() summary: state matches', summary.state, 'completed');
  ok('list() summary has no result field (structurally can\'t leak the body)', !('result' in summary));
}

// --- formatJobSubmitted: no leading/trailing newline, mentions the key facts ---
{
  const line = formatJobSubmitted('abc-123', 'custom_prompt', 3118, 29, 60);
  ok('formatJobSubmitted does not start with \\n', !line.startsWith('\n'));
  ok('formatJobSubmitted does not end with \\n', !line.endsWith('\n'));
  ok('formatJobSubmitted mentions the job id', line.includes('abc-123'));
  ok('formatJobSubmitted mentions the tool', line.includes('custom_prompt'));
  ok('formatJobSubmitted mentions the token estimate', line.includes('3118'));
  ok('formatJobSubmitted mentions the prefill estimate', line.includes('29'));
  ok('formatJobSubmitted mentions the TTL', line.includes('60'));
}

// --- formatJobStatus: per-state rendering ---
{
  const now = 1_000_000;
  const pending = formatJobStatus({ id: 'p-1', tool: 'custom_prompt', state: 'pending', createdAt: now - 5_000, lastUsedAt: now - 5_000 }, now);
  ok('formatJobStatus(pending) mentions pending', pending.includes('pending'));
  ok('formatJobStatus(pending) mentions the job id', pending.includes('p-1'));

  const running = formatJobStatus({ id: 'r-1', tool: 'custom_prompt', state: 'running', createdAt: now - 10_000, lastUsedAt: now - 1_000 }, now);
  ok('formatJobStatus(running) mentions running', running.includes('running'));

  const failed_ = formatJobStatus({ id: 'f-1', tool: 'code_task_files', state: 'failed', createdAt: now - 20_000, lastUsedAt: now - 1_000, error: 'upstream 500' }, now);
  ok('formatJobStatus(failed) mentions the error message', failed_.includes('upstream 500'));

  const completed = formatJobStatus({ id: 'c-1', tool: 'custom_prompt', state: 'completed', createdAt: now - 30_000, lastUsedAt: now - 1_000, result: 'the actual result text' }, now);
  ok('formatJobStatus(completed) does not itself echo the result body (caller presents record.result separately)', !completed.includes('the actual result text'));
}

// --- formatJobList: table rendering ---
{
  const emptyOutput = formatJobList([], 1_000_000);
  ok('formatJobList on empty input mentions no jobs', emptyOutput.includes('No active or recent jobs'));
  ok('formatJobList on empty input has no table pipe characters', !emptyOutput.includes('|'));

  const now = 1_000_000;
  const older = { id: 'older-id', tool: 'custom_prompt', state: 'completed', createdAt: now - 500_000, lastUsedAt: now - 400_000 };
  const newer = { id: 'newer-id', tool: 'code_task_files', state: 'running', createdAt: now - 10_000, lastUsedAt: now - 1_000 };
  const twoOutput = formatJobList([older, newer], now);
  ok('formatJobList includes both job ids', twoOutput.includes('older-id') && twoOutput.includes('newer-id'));
  ok('formatJobList sorts most-recently-used first', twoOutput.indexOf('newer-id') < twoOutput.indexOf('older-id'));
  ok('formatJobList includes tool and state', twoOutput.includes('code_task_files') && twoOutput.includes('running'));
  ok('formatJobList has no leading or trailing newline', !twoOutput.startsWith('\n') && !twoOutput.endsWith('\n'));
}

// ============================================================================
// Phase 14-1: sliceResult / formatJobChunkFooter / JobStore.touch() /
// JobSummary.resultChars — output-side chunked retrieval for `jobs get`.
// See .claude/phases/phase14-mcp-payload-blobs.md's フェーズ14-1 section for
// the S1-S5 decision record these cases are asserting against.
// ============================================================================

// --- sliceResult: (1) full text when limit >= total ---
{
  const s = sliceResult('hello world', 0, 100, 0);
  eq('sliceResult: limit >= total returns the full text', s.text, 'hello world');
  eq('sliceResult: start is 0', s.start, 0);
  eq('sliceResult: end equals total', s.end, 11);
  eq('sliceResult: total is text.length', s.total, 11);
}

// --- sliceResult: (2) a window in the middle ---
{
  const s = sliceResult('hello world', 2, 3, 0);
  eq('sliceResult: middle window text', s.text, 'llo');
  eq('sliceResult: middle window start', s.start, 2);
  eq('sliceResult: middle window end', s.end, 5);
}

// --- sliceResult: (3) offset > total -> empty chunk, offset clamped to total ---
{
  const s = sliceResult('hi', 10, 5, 0);
  eq('sliceResult: offset > total clamps start to total', s.start, 2);
  eq('sliceResult: offset > total yields end === start (empty)', s.end, 2);
  eq('sliceResult: offset > total yields empty text', s.text, '');
}

// --- sliceResult: (4) offset < 0 -> 0 ---
{
  const s = sliceResult('hello', -5, 3, 0);
  eq('sliceResult: negative offset clamps to 0', s.start, 0);
  eq('sliceResult: negative offset then normal window', s.text, 'hel');
}

// --- sliceResult: (5) limit <= 0 -> default window (ceiling>0, then ceiling===0) ---
{
  const s = sliceResult('hello world', 2, 0, 4);
  eq('sliceResult: limit<=0 with ceiling>0 uses ceiling as the window', s.text, 'llo ');
}
{
  const s = sliceResult('hello', 1, undefined, 0);
  eq('sliceResult: limit undefined with ceiling===0 takes the rest of the text', s.text, 'ello');
  eq('sliceResult: limit undefined with ceiling===0 reaches total', s.end, 5);
}

// --- sliceResult: (6) non-integer offset/limit are floored ---
{
  const s = sliceResult('abcdefghij', 2.9, 3.9, 0);
  eq('sliceResult: non-integer offset is floored', s.start, 2);
  eq('sliceResult: non-integer limit is floored', s.text, 'cde');
}

// --- sliceResult: (7) limit > ceiling, ceiling>0 -> clamped to ceiling ---
{
  const s = sliceResult('abcdefghij', 0, 8, 3);
  eq('sliceResult: limit above a positive ceiling is clamped to it', s.text, 'abc');
  eq('sliceResult: clamped end reflects the ceiling, not the requested limit', s.end, 3);
}

// --- sliceResult: (8) ceiling===0 -> no clamp, even for a huge limit ---
{
  const s = sliceResult('abcdefghij', 0, 999, 0);
  eq('sliceResult: ceiling===0 applies no upper clamp', s.text, 'abcdefghij');
  eq('sliceResult: ceiling===0 lets end reach total', s.end, 10);
}

// --- sliceResult: (9) S4 — end lands mid-pair, backs off so no half surrogate is emitted ---
{
  const text = `ab${'😀'}cd`; // 'ab' + one astral emoji (surrogate pair) + 'cd'
  const s = sliceResult(text, 0, 3, 0);
  eq('sliceResult: S4 backs `end` off the pair boundary', s.end, 2);
  eq('sliceResult: S4-adjusted chunk stops cleanly before the pair', s.text, 'ab');
  ok('sliceResult: S4 chunk does not end on a lone low surrogate', !isLowSurrogateChar(s.text[s.text.length - 1]));
}

// --- sliceResult: (10) S5 — degenerate case, limit=1 at a pair's high half still returns the whole pair ---
{
  const text = `${'😀'}x`; // emoji (pair) + 'x'
  const s = sliceResult(text, 0, 1, 0);
  eq('sliceResult: S5 degenerate rescue advances end to start+2, not start+1', s.end, s.start + 2);
  eq('sliceResult: S5 returns the whole surrogate pair, not a lone half', s.text, '😀');
}

// --- sliceResult: (11) S2 — offset lands mid-pair, start backs off to the pair's head ---
{
  const text = `x${'😀'}y`; // 'x' + emoji (pair) + 'y'
  const s = sliceResult(text, 2, 2, 0); // offset 2 = the pair's low half
  eq('sliceResult: S2 backs `start` off to the pair head', s.start, 1);
  eq('sliceResult: S2-adjusted chunk begins at the pair, intact', s.text, '😀');
}

// --- sliceResult: (12) isolated (unpaired) surrogates are left untouched ---
{
  // Lone low surrogate at the requested start, with no high surrogate before it.
  const text = 'a\uDC00b';
  const s = sliceResult(text, 1, 1, 0);
  eq('sliceResult: an isolated low surrogate at `start` is not adjusted', s.start, 1);
  eq('sliceResult: the isolated surrogate is returned as-is', s.text, '\uDC00');
}
{
  // Lone high surrogate that `end` would land just after, with no low surrogate following it.
  const text = 'a\uD800b';
  const s = sliceResult(text, 0, 2, 0);
  eq('sliceResult: an isolated high surrogate at `end` is not adjusted', s.end, 2);
  eq('sliceResult: the chunk keeps the isolated high surrogate intact', s.text, 'a\uD800');
}

// --- sliceResult: (13) footer-driven round trip — no data loss, no infinite loop ---
{
  // Helper for the round-trip walk: mirrors how index.ts (phase 14-1b) is
  // expected to page — always follow the previous slice's `end`, never
  // compute the next offset by arithmetic.
  function walkChunks(text, limit, ceiling) {
    let offset = 0;
    const chunks = [];
    let iterations = 0;
    const maxIterations = text.length + 2; // conservative bound accounting for ±1 boundary adjustments
    for (;;) {
      iterations++;
      if (iterations > maxIterations) {
        throw new Error(`walkChunks exceeded ${maxIterations} iterations — possible infinite loop`);
      }
      const slice = sliceResult(text, offset, limit, ceiling);
      chunks.push(slice.text);
      if (slice.end >= slice.total) break;
      offset = slice.end;
    }
    return { joined: chunks.join(''), iterations };
  }

  const text = `Hi${'😀'.repeat(3)}Bye${'😀'}`; // mixed ASCII + astral emoji
  for (const limit of [1, 2, 3]) {
    const { joined, iterations } = walkChunks(text, limit, 0);
    eq(`sliceResult: footer-driven round trip (limit=${limit}) reconstructs the original text`, joined, text);
    ok(`sliceResult: footer-driven round trip (limit=${limit}) terminates within text.length + 2 iterations`, iterations <= text.length + 2);
  }
}

// --- formatJobChunkFooter: (14) P1 — partial chunk, exact text + Next as numeric JSON ---
{
  const slice = { text: 'cde', start: 2, end: 5, total: 10 };
  const footer = formatJobChunkFooter('job-1', slice, 5);
  const want = '\n\n--- job result chunk: chars 2-5 of 10 (end-exclusive) ---\nNext: {"action":"get","id":"job-1","offset":5,"limit":5}';
  eq('formatJobChunkFooter: P1 partial-chunk footer matches exactly', footer, want);
  const nextJson = JSON.parse(footer.slice(footer.indexOf('Next: ') + 'Next: '.length));
  ok('formatJobChunkFooter: P1 Next.offset is a number, not a string', typeof nextJson.offset === 'number');
  ok('formatJobChunkFooter: P1 Next.limit is a number, not a string', typeof nextJson.limit === 'number');
}

// --- formatJobChunkFooter: (15) P2 — final chunk ---
{
  const slice = { text: 'fghij', start: 5, end: 10, total: 10 };
  const footer = formatJobChunkFooter('job-1', slice, 5);
  const want = '\n\n--- job result chunk: chars 5-10 of 10 (end-exclusive, end of result) ---';
  eq('formatJobChunkFooter: P2 final-chunk footer matches exactly', footer, want);
  ok('formatJobChunkFooter: P2 final-chunk footer has no Next line', !footer.includes('Next:'));
}

// --- formatJobChunkFooter: (16) P3 — empty chunk (offset at or beyond end) ---
{
  const slice = { text: '', start: 10, end: 10, total: 10 };
  const footer = formatJobChunkFooter('job-1', slice, 5);
  const want = '\n\n--- job result chunk: chars 10-10 of 10 (end-exclusive, empty: offset is at or beyond end of result) ---';
  eq('formatJobChunkFooter: P3 empty-chunk footer matches exactly', footer, want);
}

// --- JobStore.touch(): (17) matching owner updates lastUsedAt and returns true ---
{
  const clock = makeClock(0);
  const store = new JobStore({ ...DEFAULT_OPTS, now: clock.now });
  const owner = 'session-touch-a';
  const id = store.create(owner, 'custom_prompt');
  store.markRunning(id);
  store.markCompleted(id, 'result body');
  const before = store.get(owner, id).lastUsedAt;
  clock.advance(500);
  ok('touch(): matching owner returns true', store.touch(owner, id) === true);
  const after = store.get(owner, id).lastUsedAt;
  ok('touch(): matching owner advances lastUsedAt', after > before);

  // --- JobStore.touch(): (18) wrong owner -> false, unchanged ---
  const stillBefore = after;
  clock.advance(500);
  eq('touch(): wrong owner returns false', store.touch('session-touch-wrong', id), false);
  eq('touch(): wrong owner does not update lastUsedAt', store.get(owner, id).lastUsedAt, stillBefore);

  // --- JobStore.touch(): (18b) unknown id -> false, no throw ---
  let threw = false;
  let result;
  try {
    result = store.touch(owner, 'no-such-id-xyz');
  } catch {
    threw = true;
  }
  ok('touch(): unknown id does not throw', !threw);
  eq('touch(): unknown id returns false', result, false);
}

// --- resultChars / formatJobList: (19) 0 for pending/running/failed, result.length for completed ---
let charsSummaries;
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-chars';
  const pendingId = store.create(owner, 'custom_prompt');
  const runningId = store.create(owner, 'custom_prompt');
  store.markRunning(runningId);
  const failedId = store.create(owner, 'custom_prompt');
  store.markRunning(failedId);
  store.markFailed(failedId, 'boom');
  const completedId = store.create(owner, 'custom_prompt');
  store.markRunning(completedId);
  store.markCompleted(completedId, 'twelve chars');

  charsSummaries = store.list(owner);
  const byId = Object.fromEntries(charsSummaries.map((s) => [s.id, s]));
  eq('resultChars: pending job is 0', byId[pendingId].resultChars, 0);
  eq('resultChars: running job is 0', byId[runningId].resultChars, 0);
  eq('resultChars: failed job is 0', byId[failedId].resultChars, 0);
  eq('resultChars: completed job equals result.length', byId[completedId].resultChars, 'twelve chars'.length);
}

// --- resultChars / formatJobList: (20) chars column renders without the literal string "undefined" ---
{
  const listOutput = formatJobList(charsSummaries, Date.now());
  ok('formatJobList: chars column never renders the literal "undefined"', !listOutput.includes('undefined'));
  ok('formatJobList: header includes the chars column', listOutput.includes('chars'));
}

// --- phase 15-1a: conversationId is stored and surfaced on JobRecord, not JobSummary ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-conv-a';
  const id = store.create(owner, 'custom_prompt', 'conv-123');
  eq('create() with conversationId: get() surfaces it on JobRecord', store.get(owner, id).conversationId, 'conv-123');
  ok('list() summaries have no conversationId field', !('conversationId' in store.list(owner)[0]));
  const noConvId = store.create(owner, 'custom_prompt');
  eq('create() without conversationId: get() reports undefined', store.get(owner, noConvId).conversationId, undefined);
}

// --- phase 15-1a: activeJobIdsForConversation() — pending/running only, owner+conversation scoped ---
{
  const store = new JobStore(DEFAULT_OPTS);
  const owner = 'session-conv-b';
  const otherOwner = 'session-conv-b-other';

  eq('no jobs at all: empty array', store.activeJobIdsForConversation(owner, 'conv-x'), []);

  const pendingId = store.create(owner, 'custom_prompt', 'conv-x');
  eq('one pending job in the conversation: found', store.activeJobIdsForConversation(owner, 'conv-x'), [pendingId]);

  store.markRunning(pendingId);
  eq('same job now running: still found', store.activeJobIdsForConversation(owner, 'conv-x'), [pendingId]);

  store.markCompleted(pendingId, 'done');
  eq('job now completed: no longer active', store.activeJobIdsForConversation(owner, 'conv-x'), []);

  const failedId = store.create(owner, 'custom_prompt', 'conv-x');
  store.markRunning(failedId);
  store.markFailed(failedId, 'boom');
  eq('job now failed: no longer active', store.activeJobIdsForConversation(owner, 'conv-x'), []);

  const noConvId = store.create(owner, 'custom_prompt');
  eq('a job with no conversationId is never returned', store.activeJobIdsForConversation(owner, 'conv-x'), []);
  eq('...nor when queried without a conversationId match at all', store.activeJobIdsForConversation(owner, 'undefined'), []);

  const otherConvId = store.create(owner, 'custom_prompt', 'conv-y');
  eq('a job bound to a different conversationId is not returned', store.activeJobIdsForConversation(owner, 'conv-x'), []);
  eq('...but is returned for its own conversationId', store.activeJobIdsForConversation(owner, 'conv-y'), [otherConvId]);

  store.create(otherOwner, 'custom_prompt', 'conv-x');
  eq('a same-conversationId job under a different owner is not returned', store.activeJobIdsForConversation(owner, 'conv-x'), []);

  const idA = store.create(owner, 'custom_prompt', 'conv-multi');
  const idB = store.create(owner, 'code_task_files', 'conv-multi');
  const found = store.activeJobIdsForConversation(owner, 'conv-multi').sort();
  eq('multiple active jobs on the same conversation are all returned', found, [idA, idB].sort());
}

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nAll job-store tests passed\n');
process.exitCode = failed ? 1 : 0;
