// Unit test for JobStore + formatJobSubmitted/formatJobStatus/formatJobList
// (phase 13: async job execution). Pure logic, no backend needed.
// Run: npm run test:jobs
import { JobStore, formatJobSubmitted, formatJobStatus, formatJobList } from '../dist/job-store.js';

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

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nAll job-store tests passed\n');
process.exitCode = failed ? 1 : 0;
