// Unit test for BlobStore + formatBlobCreated/formatBlobAppended/formatBlobList
// (phase 14-2: input-side blob store). Pure logic, no backend needed.
// See .claude/phases/phase14-mcp-payload-blobs.md's フェーズ14-2 section (D9-D14)
// for the decision record these cases assert against.
// Run: npm run test:blobs
import { createHash } from 'node:crypto';
import { BlobStore, formatBlobCreated, formatBlobAppended, formatBlobList } from '../dist/blob-store.js';

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

// A mutable injected clock — same rationale as job-store.ts's test file:
// `now()` must be called fresh every time, never cached.
function makeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const DEFAULT_OPTS = { ttlMs: 60_000, maxBlobs: 10, maxChars: 1_000, maxTotalChars: 10_000 };

function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ============================================================================
// generation & seq numbering (5)
// ============================================================================

// --- (1) create(owner) with no data starts open, empty, nextSeq 0 ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const res = store.create('owner-a');
  ok('create(no data): ok', res.ok === true);
  eq('create(no data): state is open', res.value.state, 'open');
  eq('create(no data): chars is 0', res.value.chars, 0);
  eq('create(no data): chunks is 0', res.value.chunks, 0);
  eq('create(no data): nextSeq is 0', res.value.nextSeq, 0);
}

// --- (2) create(owner, data) treats data as the seq-0 chunk immediately ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const res = store.create('owner-a', 'hello');
  ok('create(with data): ok', res.ok === true);
  eq('create(with data): chars matches data length', res.value.chars, 5);
  eq('create(with data): chunks is 1', res.value.chunks, 1);
  eq('create(with data): nextSeq is 1', res.value.nextSeq, 1);
}

// --- (3) create(owner, '') — empty string is a real chunk, not "no data" (data !== undefined check) ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const res = store.create('owner-a', '');
  ok('create(empty string): ok', res.ok === true);
  eq('create(empty string): chars is 0', res.value.chars, 0);
  eq('create(empty string): chunks is 1 (empty string still counts as the seq-0 chunk)', res.value.chunks, 1);
  eq('create(empty string): nextSeq is 1', res.value.nextSeq, 1);
}

// --- (4) append() in sequence advances nextSeq/chunks/chars correctly ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const { value: created } = store.create('owner-a');
  const id = created.id;
  const r1 = store.append('owner-a', id, 0, 'abc');
  ok('append seq 0: ok', r1.ok === true);
  eq('append seq 0: chars', r1.value.chars, 3);
  eq('append seq 0: chunks', r1.value.chunks, 1);
  eq('append seq 0: nextSeq', r1.value.nextSeq, 1);
  const r2 = store.append('owner-a', id, 1, 'de');
  ok('append seq 1: ok', r2.ok === true);
  eq('append seq 1: chars accumulate', r2.value.chars, 5);
  eq('append seq 1: chunks accumulate', r2.value.chunks, 2);
  eq('append seq 1: nextSeq advances', r2.value.nextSeq, 2);
}

// --- (5) create() returns unique ids across calls ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id1 = store.create('owner-a').value.id;
  const id2 = store.create('owner-a').value.id;
  ok('create(): ids are unique strings', typeof id1 === 'string' && typeof id2 === 'string' && id1 !== id2);
}

// ============================================================================
// seq mismatch (3)
// ============================================================================

// --- (6) append() with seq ahead of nextSeq -> seq_mismatch, blob unchanged ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a').value.id;
  const res = store.append('owner-a', id, 5, 'x');
  ok('append seq mismatch (ahead): not ok', res.ok === false);
  eq('append seq mismatch (ahead): code', res.code, 'seq_mismatch');
  eq('append seq mismatch (ahead): message', res.message, 'chunk seq mismatch for blob ' + id + ': expected seq 0, got 5. Chunks must arrive in order, starting at seq 0 — retry this chunk with seq: 0.');
  eq('append seq mismatch (ahead): blob unchanged (still nextSeq 0)', store.get('owner-a', id).nextSeq, 0);
}

// --- (7) append() with seq behind nextSeq (replay) -> seq_mismatch, blob unchanged ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a').value.id;
  store.append('owner-a', id, 0, 'abc');
  const res = store.append('owner-a', id, 0, 'xyz');
  ok('append seq mismatch (replay): not ok', res.ok === false);
  eq('append seq mismatch (replay): code', res.code, 'seq_mismatch');
  eq('append seq mismatch (replay): blob content unchanged', store.get('owner-a', id).chars, 3);
}

// --- (8) after a seq_mismatch, retrying with the expected seq (from the error message) succeeds ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a').value.id;
  const bad = store.append('owner-a', id, 3, 'nope');
  ok('append seq mismatch: rejected', bad.ok === false);
  const retry = store.append('owner-a', id, 0, 'abc');
  ok('append with the message-embedded expected seq: succeeds', retry.ok === true);
  eq('append with the message-embedded expected seq: content applied', retry.value.chars, 3);
}

// ============================================================================
// state transition violations (3) — critical
// ============================================================================

// --- (9) read() on an open (unsealed) blob -> invalid_state ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a', 'data').value.id;
  const res = store.read('owner-a', id);
  ok('read() on open blob: not ok', res.ok === false);
  eq('read() on open blob: code', res.code, 'invalid_state');
  eq('read() on open blob: message', res.message, `blob ${id} is still open — seal it first with blobs seal before reading its content.`);
}

// --- (10) append() on a sealed blob -> invalid_state, blob unchanged ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a', 'data').value.id;
  store.seal('owner-a', id);
  const res = store.append('owner-a', id, 1, 'more');
  ok('append() on sealed blob: not ok', res.ok === false);
  eq('append() on sealed blob: code', res.code, 'invalid_state');
  eq('append() on sealed blob: message', res.message, `blob ${id} is already sealed and cannot accept more chunks. Create a new blob if you need to upload more data.`);
  eq('append() on sealed blob: chars unchanged', store.get('owner-a', id).chars, 4);
}

// --- (11) seal() on an already-sealed blob -> invalid_state ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a', 'data').value.id;
  const first = store.seal('owner-a', id);
  ok('first seal(): ok', first.ok === true);
  const second = store.seal('owner-a', id);
  ok('seal() on already-sealed blob: not ok', second.ok === false);
  eq('seal() on already-sealed blob: code', second.code, 'invalid_state');
  eq('seal() on already-sealed blob: message', second.message, `blob ${id} is already sealed.`);
}

// ============================================================================
// seal & sha256 (5)
// ============================================================================

// --- (12) seal() computes sha256 over the full concatenated body ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a').value.id;
  store.append('owner-a', id, 0, 'hello ');
  store.append('owner-a', id, 1, 'world');
  const res = store.seal('owner-a', id);
  ok('seal(): ok', res.ok === true);
  eq('seal(): state becomes sealed', res.value.state, 'sealed');
  eq('seal(): sha256 matches the joined body', res.value.sha256, sha256hex('hello world'));
}

// --- (13) seal() with a matching expectedSha256 (case-insensitive) succeeds ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a', 'payload').value.id;
  const expected = sha256hex('payload').toUpperCase();
  const res = store.seal('owner-a', id, expected);
  ok('seal(expectedSha256, uppercase): ok (case-insensitive match)', res.ok === true);
  eq('seal(expectedSha256, uppercase): sealed sha256 is lowercase', res.value.sha256, sha256hex('payload'));
}

// --- (14) seal() with a mismatched expectedSha256 -> hash_mismatch, blob stays open and unchanged ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a', 'payload').value.id;
  const wrong = '0'.repeat(64);
  const res = store.seal('owner-a', id, wrong);
  ok('seal(wrong expectedSha256): not ok', res.ok === false);
  eq('seal(wrong expectedSha256): code', res.code, 'hash_mismatch');
  eq('seal(wrong expectedSha256): message', res.message, `sha256 mismatch for blob ${id}: expected ${wrong}, got ${sha256hex('payload')}. The blob is left open and unchanged — delete it and re-upload.`);
  eq('seal(wrong expectedSha256): blob stays open', store.get('owner-a', id).state, 'open');
}

// --- (15) sha256 over a body whose chunk boundary splits a UTF-16 surrogate pair matches the whole-string hash ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const emoji = '\u{1F600}'; // single astral emoji = one surrogate pair, 2 UTF-16 code units
  const high = emoji[0]; // lone high surrogate
  const low = emoji[1]; // lone low surrogate
  const whole = `ab${emoji}cd`;

  const id = store.create('owner-a').value.id;
  store.append('owner-a', id, 0, `ab${high}`); // chunk 1 ends mid-pair
  store.append('owner-a', id, 1, `${low}cd`); // chunk 2 starts mid-pair
  eq('surrogate-split chunks: joined body equals the intact string', store.get('owner-a', id).chars, whole.length);
  const res = store.seal('owner-a', id);
  ok('surrogate-split chunks: seal() succeeds', res.ok === true);
  eq('surrogate-split chunks: sha256 matches hashing the whole joined string (not per-chunk)', res.value.sha256, sha256hex(whole));
}

// --- (16) sha256 is not present until seal(); appears only after ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a', 'x').value.id;
  ok('pre-seal record has no sha256', store.get('owner-a', id).sha256 === undefined);
  const sealed = store.seal('owner-a', id);
  ok('post-seal record has a sha256 string', typeof sealed.value.sha256 === 'string' && sealed.value.sha256.length === 64);
}

// ============================================================================
// read (2)
// ============================================================================

// --- (17) read() on a sealed blob returns the full joined body ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a').value.id;
  store.append('owner-a', id, 0, 'part-one-');
  store.append('owner-a', id, 1, 'part-two');
  store.seal('owner-a', id);
  const res = store.read('owner-a', id);
  ok('read() on sealed blob: ok', res.ok === true);
  eq('read() on sealed blob: returns the joined body', res.value, 'part-one-part-two');
}

// --- (18) read() on a missing id -> not_found ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const res = store.read('owner-a', 'no-such-id');
  ok('read() on missing id: not ok', res.ok === false);
  eq('read() on missing id: code', res.code, 'not_found');
  eq('read() on missing id: message', res.message, 'blob no-such-id was not found or is not available to you.');
}

// ============================================================================
// overflow (4)
// ============================================================================

// --- (19) create(data) larger than maxChars -> too_large, no blob created ---
{
  const store = new BlobStore({ ...DEFAULT_OPTS, maxChars: 5 });
  const res = store.create('owner-a', 'this is too long');
  ok('create() over maxChars: not ok', res.ok === false);
  eq('create() over maxChars: code', res.code, 'too_large');
  eq('create() over maxChars: message', res.message, 'initial data is 16 chars, over the 5-char per-blob limit. No blob was created.');
  eq('create() over maxChars: no blob was created', store.size(), 0);
}

// --- (20) append() that would push a blob over maxChars -> too_large, blob unchanged ---
{
  const store = new BlobStore({ ...DEFAULT_OPTS, maxChars: 5 });
  const id = store.create('owner-a', 'abc').value.id;
  const res = store.append('owner-a', id, 1, 'defgh');
  ok('append() over maxChars: not ok', res.ok === false);
  eq('append() over maxChars: code', res.code, 'too_large');
  eq('append() over maxChars: message', res.message, `blob ${id} would grow to 8 chars, over the 5-char per-blob limit. The chunk was rejected and the blob is unchanged.`);
  eq('append() over maxChars: blob unchanged', store.get('owner-a', id).chars, 3);
}

// --- (21) create() at maxBlobs -> store_full ---
{
  const store = new BlobStore({ ...DEFAULT_OPTS, maxBlobs: 2 });
  store.create('owner-a');
  store.create('owner-a');
  const res = store.create('owner-a');
  ok('create() at maxBlobs: not ok', res.ok === false);
  eq('create() at maxBlobs: code', res.code, 'store_full');
  eq('create() at maxBlobs: message', res.message, 'the server\'s global blob capacity is full (max 2 blobs). Delete a blob you no longer need, or retry shortly — idle blobs expire automatically.');
}

// --- (22) append() that would push the global total over maxTotalChars -> store_chars_full, blob unchanged ---
{
  const store = new BlobStore({ ...DEFAULT_OPTS, maxChars: 10_000, maxTotalChars: 10 });
  const id = store.create('owner-a', 'abcde').value.id; // 5 of 10 global chars used
  const res = store.append('owner-a', id, 1, 'zzzzzz'); // would push total to 11 > 10
  ok('append() over maxTotalChars: not ok', res.ok === false);
  eq('append() over maxTotalChars: code', res.code, 'store_chars_full');
  eq('append() over maxTotalChars: message', res.message, 'the server\'s global blob memory budget is full (max 10 chars). Delete a blob you no longer need, or retry shortly — idle blobs expire automatically.');
  eq('append() over maxTotalChars: blob unchanged', store.get('owner-a', id).chars, 5);
}

// ============================================================================
// TTL (3)
// ============================================================================

// --- (23) an idle open blob is swept once past ttlMs ---
{
  const clock = makeClock(0);
  const store = new BlobStore({ ...DEFAULT_OPTS, ttlMs: 1_000, now: clock.now });
  const id = store.create('owner-a').value.id;
  clock.advance(5_000);
  eq('idle open blob is swept past ttlMs (unlike JobStore, open is not exempt)', store.get('owner-a', id), undefined);
}

// --- (24) an idle sealed blob is swept once past ttlMs ---
{
  const clock = makeClock(0);
  const store = new BlobStore({ ...DEFAULT_OPTS, ttlMs: 1_000, now: clock.now });
  const id = store.create('owner-a', 'data').value.id;
  store.seal('owner-a', id);
  clock.advance(5_000);
  eq('idle sealed blob is swept past ttlMs', store.get('owner-a', id), undefined);
}

// --- (25) activity (append) resets the idle clock, keeping the blob alive past the original deadline ---
{
  const clock = makeClock(0);
  const store = new BlobStore({ ...DEFAULT_OPTS, ttlMs: 1_000, now: clock.now });
  const id = store.create('owner-a').value.id;
  clock.advance(800);
  store.append('owner-a', id, 0, 'still alive'); // lastUsedAt refreshed to t=800
  clock.advance(800); // t=1600, 800ms since last activity — under ttlMs=1000
  ok('blob touched by append() survives past its original TTL deadline', store.get('owner-a', id) !== undefined);
}

// ============================================================================
// owner isolation (3)
// ============================================================================

// --- (26) get()/read() from a different owner never sees the blob (not_found, not a distinct "forbidden") ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a', 'secret').value.id;
  store.seal('owner-a', id);
  eq('get() from a different owner: undefined', store.get('owner-b', id), undefined);
  const readRes = store.read('owner-b', id);
  ok('read() from a different owner: not ok', readRes.ok === false);
  eq('read() from a different owner: not_found (indistinguishable from missing)', readRes.code, 'not_found');
}

// --- (27) append()/seal() from a different owner are rejected as not_found, blob unaffected ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const id = store.create('owner-a').value.id;
  const appendRes = store.append('owner-b', id, 0, 'intrusion');
  ok('append() from a different owner: not ok', appendRes.ok === false);
  eq('append() from a different owner: code', appendRes.code, 'not_found');
  const sealRes = store.seal('owner-b', id);
  ok('seal() from a different owner: not ok', sealRes.ok === false);
  eq('seal() from a different owner: code', sealRes.code, 'not_found');
  eq('blob is untouched by the cross-owner attempts', store.get('owner-a', id).chars, 0);
}

// --- (28) list()/clear() are scoped to a single owner ---
{
  const store = new BlobStore(DEFAULT_OPTS);
  const idA1 = store.create('owner-a').value.id;
  const idA2 = store.create('owner-a').value.id;
  const idB1 = store.create('owner-b').value.id;

  eq('list() returns only ownerA\'s 2 blobs', store.list('owner-a').map((b) => b.id).sort(), [idA1, idA2].sort());
  eq('list() returns only ownerB\'s 1 blob', store.list('owner-b').map((b) => b.id), [idB1]);

  const cleared = store.clear('owner-a');
  eq('clear() returns the count removed for that owner', cleared, 2);
  eq('list() for ownerA is empty after clear()', store.list('owner-a'), []);
  eq('ownerB is unaffected by ownerA\'s clear()', store.list('owner-b').map((b) => b.id), [idB1]);
}

// ============================================================================
// formatter (2 blocks)
// ============================================================================

// --- (29) formatBlobCreated / formatBlobAppended (open + sealed) exact-match ---
{
  const created = {
    id: 'blob-1', state: 'open', chunks: 0, chars: 0, nextSeq: 0, createdAt: 0, lastUsedAt: 0,
  };
  eq(
    'formatBlobCreated: exact match',
    formatBlobCreated(created, 30),
    '📦 Blob blob-1 created — 0 chars in 0 chunk(s). Send the next chunk with blobs append, blob_id: "blob-1", seq: 0. Seal it with blobs seal when done. Idle-expires in 30min.'
  );

  const appendedOpen = {
    id: 'blob-1', state: 'open', chunks: 1, chars: 5, nextSeq: 1, createdAt: 0, lastUsedAt: 0,
  };
  eq(
    'formatBlobAppended (open): exact match',
    formatBlobAppended(appendedOpen, 30),
    '📦 Blob blob-1 — chunk 0 accepted, 5 chars in 1 chunk(s). Next chunk: seq 1, or seal with blobs seal. Idle-expires in 30min.'
  );

  const sealed = {
    id: 'blob-1', state: 'sealed', chunks: 1, chars: 5, nextSeq: 1, sha256: 'a'.repeat(64), createdAt: 0, lastUsedAt: 0,
  };
  eq(
    'formatBlobAppended (sealed, rendering seal()\'s own return value): exact match',
    formatBlobAppended(sealed, 30),
    `📦 Blob blob-1 sealed — 5 chars in 1 chunk(s), sha256 ${'a'.repeat(64)}. Use it with custom_prompt's context_blob_id: "blob-1". Idle-expires in 30min.`
  );
}

// --- (30) formatBlobList: empty + populated table, no sha256 column, sorted by lastUsedAt ---
{
  const emptyOutput = formatBlobList([], 30, 1_000_000);
  eq('formatBlobList on empty input: exact match', emptyOutput, 'No blobs stored. Upload one with blobs create, then blobs append and blobs seal.');
  ok('formatBlobList on empty input has no table pipe characters', !emptyOutput.includes('|'));

  const now = 1_000_000;
  const older = { id: 'older-id', state: 'sealed', chunks: 2, chars: 40, nextSeq: 2, sha256: 'b'.repeat(64), createdAt: now - 500_000, lastUsedAt: now - 400_000 };
  const newer = { id: 'newer-id', state: 'open', chunks: 1, chars: 10, nextSeq: 1, createdAt: now - 10_000, lastUsedAt: now - 1_000 };
  const twoOutput = formatBlobList([older, newer], 30, now);
  ok('formatBlobList includes both blob ids', twoOutput.includes('older-id') && twoOutput.includes('newer-id'));
  ok('formatBlobList sorts most-recently-used first', twoOutput.indexOf('newer-id') < twoOutput.indexOf('older-id'));
  ok('formatBlobList includes state and chunks/chars', twoOutput.includes('sealed') && twoOutput.includes('open') && twoOutput.includes('40') && twoOutput.includes('10'));
  ok('formatBlobList has no sha256 column (width, per D13)', !twoOutput.includes('b'.repeat(64)));
  ok('formatBlobList has no leading or trailing newline', !twoOutput.startsWith('\n') && !twoOutput.endsWith('\n'));
}

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nAll blob-store tests passed\n');
process.exitCode = failed ? 1 : 0;
