#!/usr/bin/env node
/**
 * End-to-end test for the `blobs` tool (phase 14-3a: chunked payload
 * upload — the input-side counterpart to jobs get's output-side chunking
 * from phase 14-1) and custom_prompt's `context_blob_id` parameter (phase
 * 14-3b: consuming a sealed blob as `context`). Spawns dist/index.js with
 * HOUTINI_LM_TRANSPORT=http against fake-openai-backend.mjs and drives it
 * over real HTTP — same transport mechanics as test-jobs-e2e.mjs (session
 * establishment is imported from http-test-helpers.mjs, not re-derived
 * here). The fake backend is present for two reasons: startServer()
 * requires an endpoint URL, and (phase 14-3b) its recorded `requests[]`
 * array is how the byte-identity tests verify that `context` and
 * `context_blob_id` produce the same upstream messages.
 *
 * Output format matches the other e2e suites: `PASS  <name>` / `FAIL  <name>`.
 *
 * Usage: node scripts/test-blobs-e2e.mjs
 */
import { createHash } from 'node:crypto';
import { startFakeBackend } from './fake-openai-backend.mjs';
import { getFreePort, startServer, post, initializeSession } from './http-test-helpers.mjs';

let failed = 0;
function ok(name, cond, detail) {
  const pass = !!cond;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ` — ${detail}` : ''}\n`);
  if (!pass) failed++;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHA256_RE = /[0-9a-f]{64}/;

async function callTool(baseUrl, sessionId, toolName, args, id) {
  const res = await post(baseUrl, '/mcp', {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, sessionId);
  const result = res.messages.find((m) => m.id === id)?.result;
  return { httpStatus: res.status, result };
}
const callBlobs = (baseUrl, sessionId, args, id) => callTool(baseUrl, sessionId, 'blobs', args, id);
const callCustomPrompt = (baseUrl, sessionId, args, id) => callTool(baseUrl, sessionId, 'custom_prompt', args, id);

async function toolsList(baseUrl, sessionId, id) {
  const res = await post(baseUrl, '/mcp', { jsonrpc: '2.0', id, method: 'tools/list', params: {} }, sessionId);
  return res.messages.find((m) => m.id === id)?.result;
}

function textOf(result) {
  return result?.content?.[0]?.text ?? '';
}

function sha256Of(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Poll `jobs get` (short-polling, no wait_ms) until the job reaches a terminal state or attempts run out. Local copy of test-jobs-e2e.mjs's helper — not shared as a module import, matching the existing per-script duplication convention in this suite family. */
async function pollUntilDone(baseUrl, sessionId, jobId, { intervalMs = 200, maxAttempts = 50, idBase = 8000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const { result } = await callTool(baseUrl, sessionId, 'jobs', { action: 'get', job_id: jobId }, idBase + i);
    const text = textOf(result);
    if (result?.isError) return { result, text };
    if (/^⏳/.test(text)) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    return { result, text }; // completed (raw result body) or ❌ failed status line
  }
  return { result: undefined, text: '(timed out polling — job never reached a terminal state)' };
}

async function main() {
  // === Main functional suite ===
  const backend = await startFakeBackend();
  const port = await getFreePort();
  const { child, ready } = startServer(backend.url, port);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await ready;
    console.log('\n=== Blobs E2E Tests (phase 14-3a) ===\n');

    // --- tools/list: blobs is present with the right schema; custom_prompt/code_task_files are untouched (14-3a leaves context_blob_id to 14-3b) ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const list = await toolsList(baseUrl, sessionId, 99);
      const names = (list?.tools ?? []).map((t) => t.name);
      ok('tools/list includes the blobs tool', names.includes('blobs'), JSON.stringify(names));

      const blobsTool = (list?.tools ?? []).find((t) => t.name === 'blobs');
      const props = blobsTool?.inputSchema?.properties ?? {};
      ok('tools/list: blobs.inputSchema has action/blob_id/seq/data/sha256',
        ['action', 'blob_id', 'seq', 'data', 'sha256'].every((k) => k in props), JSON.stringify(Object.keys(props)));
      const actionEnum = props.action?.enum ?? [];
      ok('tools/list: blobs.action enum is exactly create/append/seal/list/delete',
        JSON.stringify([...actionEnum].sort()) === JSON.stringify(['append', 'create', 'delete', 'list', 'seal'].sort()),
        JSON.stringify(actionEnum));
      ok('tools/list: blobs.inputSchema.required is ["action"]', JSON.stringify(blobsTool?.inputSchema?.required) === JSON.stringify(['action']),
        JSON.stringify(blobsTool?.inputSchema?.required));

      const cpProps = (list?.tools ?? []).find((t) => t.name === 'custom_prompt')?.inputSchema?.properties ?? {};
      const ctfProps = (list?.tools ?? []).find((t) => t.name === 'code_task_files')?.inputSchema?.properties ?? {};
      ok('tools/list: custom_prompt has context_blob_id (phase 14-3b)', 'context_blob_id' in cpProps, JSON.stringify(Object.keys(cpProps)));
      ok('tools/list: code_task_files still has no context_blob_id (14-5 scope, not this phase)', !('context_blob_id' in ctfProps), JSON.stringify(Object.keys(ctfProps)));
    }

    // --- create: without data (starts empty, seq 0 next) ---
    let sessionA, blobId;
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      sessionA = sessionId;
      const { result } = await callBlobs(baseUrl, sessionId, { action: 'create' }, 2);
      ok('create (no data): not isError', result?.isError !== true, JSON.stringify(result));
      const text = textOf(result);
      const match = text.match(UUID_RE);
      ok('create (no data): response contains a UUID-shaped blob id', !!match, text);
      blobId = match?.[0];
      ok('create (no data): reports 0 chars in 0 chunk(s), next seq 0',
        text.includes('0 chars in 0 chunk(s)') && text.includes(`seq: 0`), text);
    }

    // --- create: with initial data (becomes seq-0 chunk, next seq 1) ---
    {
      const { result } = await callBlobs(baseUrl, sessionA, { action: 'create', data: 'hello' }, 3);
      ok('create (with data): not isError', result?.isError !== true, JSON.stringify(result));
      const text = textOf(result);
      ok('create (with data): reports 5 chars in 1 chunk(s), next seq 1', text.includes('5 chars in 1 chunk(s)') && text.includes('seq: 1'), text);
      ok('create (with data): not isError, type check', result?.isError !== true, JSON.stringify(result));
    }

    // --- create: data must be a string ---
    {
      const { result } = await callBlobs(baseUrl, sessionA, { action: 'create', data: 42 }, 4);
      ok('create: non-string data is isError', result?.isError === true, JSON.stringify(result));
      ok('create: non-string data error text', textOf(result).includes('data must be a string'), textOf(result));
    }

    // --- append: sequential seq 0, 1, 2 accumulate chars/chunks ---
    let appendId;
    {
      const { result: createResult } = await callBlobs(baseUrl, sessionA, { action: 'create' }, 5);
      appendId = textOf(createResult).match(UUID_RE)?.[0];
      ok('append setup: fresh blob created', !!appendId, textOf(createResult));

      const { result: r0 } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: appendId, seq: 0, data: 'ab' }, 6);
      ok('append seq 0: not isError', r0?.isError !== true, JSON.stringify(r0));
      ok('append seq 0: exact wording (chunk 0 accepted, 2 chars in 1 chunk(s), next seq 1)',
        textOf(r0).includes('chunk 0 accepted, 2 chars in 1 chunk(s)') && textOf(r0).includes('Next chunk: seq 1'), textOf(r0));

      const { result: r1 } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: appendId, seq: 1, data: 'cd' }, 7);
      ok('append seq 1: chunk 1 accepted, 4 chars in 2 chunk(s), next seq 2',
        textOf(r1).includes('chunk 1 accepted, 4 chars in 2 chunk(s)') && textOf(r1).includes('Next chunk: seq 2'), textOf(r1));

      const { result: r2 } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: appendId, seq: 2, data: 'ef' }, 8);
      ok('append seq 2: chunk 2 accepted, 6 chars in 3 chunk(s), next seq 3',
        textOf(r2).includes('chunk 2 accepted, 6 chars in 3 chunk(s)') && textOf(r2).includes('Next chunk: seq 3'), textOf(r2));
    }

    // --- append: seq mismatch leaves the blob unchanged ---
    {
      const { result: mismatch } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: appendId, seq: 9, data: 'zz' }, 9);
      ok('append seq mismatch: isError', mismatch?.isError === true, JSON.stringify(mismatch));
      ok('append seq mismatch: exact wording (expected seq 3, got 9, retry with seq: 3)',
        textOf(mismatch).includes('expected seq 3, got 9') && textOf(mismatch).includes('retry this chunk with seq: 3'), textOf(mismatch));

      const { result: listResult } = await callBlobs(baseUrl, sessionA, { action: 'list' }, 10);
      ok('append seq mismatch: blob unchanged (still 6 chars, 3 chunks in list)',
        new RegExp(`${appendId} \\| open \\| 3 \\| 6 \\|`).test(textOf(listResult)), textOf(listResult));
    }

    // --- append: seq must be a non-negative integer; data must be a string ---
    {
      const { result: badSeq } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: appendId, seq: -1, data: 'x' }, 11);
      ok('append: negative seq is isError', badSeq?.isError === true, JSON.stringify(badSeq));
      ok('append: negative seq error text', textOf(badSeq).includes('seq must be a non-negative integer'), textOf(badSeq));

      const { result: missingData } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: appendId, seq: 3 }, 12);
      ok('append: missing data is isError', missingData?.isError === true, JSON.stringify(missingData));
      ok('append: missing data error text', textOf(missingData).includes('data is required'), textOf(missingData));
    }

    // --- append/seal/delete: unknown blob_id ---
    {
      const bogus = '00000000-0000-0000-0000-000000000000';
      const { result: appendBogus } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: bogus, seq: 0, data: 'x' }, 13);
      ok('append on unknown blob_id: isError', appendBogus?.isError === true, JSON.stringify(appendBogus));
      ok('append on unknown blob_id: not-found wording', textOf(appendBogus).includes('not found or is not available'), textOf(appendBogus));

      const { result: sealBogus } = await callBlobs(baseUrl, sessionA, { action: 'seal', blob_id: bogus }, 14);
      ok('seal on unknown blob_id: isError', sealBogus?.isError === true, JSON.stringify(sealBogus));

      const { result: deleteBogus } = await callBlobs(baseUrl, sessionA, { action: 'delete', blob_id: bogus }, 15);
      ok('delete on unknown blob_id: isError', deleteBogus?.isError === true, JSON.stringify(deleteBogus));
    }

    // --- append/seal/delete: blob_id required ---
    {
      const { result: noId } = await callBlobs(baseUrl, sessionA, { action: 'append', seq: 0, data: 'x' }, 16);
      ok('append without blob_id: isError', noId?.isError === true, JSON.stringify(noId));
      ok('append without blob_id: error text', textOf(noId).includes('blob_id is required'), textOf(noId));
    }

    // --- seal: malformed sha256 (wrong length / uppercase) is a format error, distinct from a real mismatch ---
    let sealCandidateId;
    {
      const { result: createResult } = await callBlobs(baseUrl, sessionA, { action: 'create', data: 'seal-me' }, 17);
      sealCandidateId = textOf(createResult).match(UUID_RE)?.[0];

      const { result: tooShort } = await callBlobs(baseUrl, sessionA, { action: 'seal', blob_id: sealCandidateId, sha256: 'abc' }, 18);
      ok('seal: too-short sha256 is isError', tooShort?.isError === true, JSON.stringify(tooShort));
      ok('seal: too-short sha256 error is the format error, not a hash mismatch',
        textOf(tooShort).includes('must be a 64-character lowercase hex string') && !textOf(tooShort).includes('mismatch'), textOf(tooShort));

      const upper = sha256Of('seal-me').toUpperCase();
      const { result: uppercase } = await callBlobs(baseUrl, sessionA, { action: 'seal', blob_id: sealCandidateId, sha256: upper }, 19);
      ok('seal: uppercase sha256 is isError (format check requires lowercase)', uppercase?.isError === true, JSON.stringify(uppercase));
    }

    // --- seal: real hash mismatch (well-formed but wrong) leaves the blob open ---
    {
      const wrongButValid = '0'.repeat(64);
      const { result: mismatch } = await callBlobs(baseUrl, sessionA, { action: 'seal', blob_id: sealCandidateId, sha256: wrongButValid }, 20);
      ok('seal: hash mismatch is isError', mismatch?.isError === true, JSON.stringify(mismatch));
      ok('seal: hash mismatch wording', textOf(mismatch).includes('sha256 mismatch') && textOf(mismatch).includes('left open and unchanged'), textOf(mismatch));

      const { result: listResult } = await callBlobs(baseUrl, sessionA, { action: 'list' }, 21);
      ok('seal: hash mismatch leaves the blob open (per list)', new RegExp(`${sealCandidateId} \\| open`).test(textOf(listResult)), textOf(listResult));
    }

    // --- seal: correct sha256 succeeds; sealed message includes the digest ---
    {
      const correct = sha256Of('seal-me');
      const { result } = await callBlobs(baseUrl, sessionA, { action: 'seal', blob_id: sealCandidateId, sha256: correct }, 22);
      ok('seal: correct sha256 succeeds', result?.isError !== true, JSON.stringify(result));
      const text = textOf(result);
      ok('seal: sealed message reports the digest and context_blob_id usage', text.includes(`sealed`) && text.includes(correct) && text.includes('context_blob_id'), text);
      ok('seal: sealed message contains a well-formed sha256', SHA256_RE.test(text), text);

      const { result: listResult } = await callBlobs(baseUrl, sessionA, { action: 'list' }, 23);
      ok('seal: list now reports the blob as sealed', new RegExp(`${sealCandidateId} \\| sealed`).test(textOf(listResult)), textOf(listResult));
    }

    // --- seal: succeeds without sha256 too (verification is optional) ---
    let noVerifyId;
    {
      const { result: createResult } = await callBlobs(baseUrl, sessionA, { action: 'create', data: 'no-verify' }, 24);
      noVerifyId = textOf(createResult).match(UUID_RE)?.[0];
      const { result } = await callBlobs(baseUrl, sessionA, { action: 'seal', blob_id: noVerifyId }, 25);
      ok('seal without sha256: succeeds', result?.isError !== true, JSON.stringify(result));
      ok('seal without sha256: still reports a computed digest', SHA256_RE.test(textOf(result)), textOf(result));
    }

    // --- append to an already-sealed blob: invalid_state ---
    {
      const { result } = await callBlobs(baseUrl, sessionA, { action: 'append', blob_id: sealCandidateId, seq: 1, data: 'more' }, 26);
      ok('append to sealed blob: isError', result?.isError === true, JSON.stringify(result));
      ok('append to sealed blob: invalid_state wording', textOf(result).includes('already sealed'), textOf(result));
    }

    // --- list: empty vs. populated table format ---
    {
      const { sessionId: freshSession } = await initializeSession(baseUrl, '/mcp');
      const { result: emptyList } = await callBlobs(baseUrl, freshSession, { action: 'list' }, 27);
      ok('list on a fresh session: reports no blobs stored', textOf(emptyList).includes('No blobs stored'), textOf(emptyList));

      const { result: populatedList } = await callBlobs(baseUrl, sessionA, { action: 'list' }, 28);
      const text = textOf(populatedList);
      ok('list on a populated session: has a table header', text.includes('| blob_id | state | chunks | chars | idle | expires in |'), text);
      ok('list on a populated session: includes a known blob id', text.includes(sealCandidateId), text);
    }

    // --- delete: succeeds once, then behaves like a nonexistent id ---
    {
      const { result: deleteResult } = await callBlobs(baseUrl, sessionA, { action: 'delete', blob_id: noVerifyId }, 29);
      ok('delete: not isError', deleteResult?.isError !== true, JSON.stringify(deleteResult));
      ok('delete: exact wording', textOf(deleteResult) === `Deleted blob ${noVerifyId}.`, textOf(deleteResult));

      const { result: secondDelete } = await callBlobs(baseUrl, sessionA, { action: 'delete', blob_id: noVerifyId }, 30);
      ok('delete twice: second delete is isError (not found)', secondDelete?.isError === true, JSON.stringify(secondDelete));
      ok('delete twice: not-found wording', textOf(secondDelete).includes('not found'), textOf(secondDelete));
    }

    // --- owner separation: a different session cannot see or touch this owner's blobs ---
    {
      const { sessionId: sessionB } = await initializeSession(baseUrl, '/mcp');
      const { result: crossList } = await callBlobs(baseUrl, sessionB, { action: 'list' }, 31);
      ok('cross-owner list: does not include another owner\'s blob id', !textOf(crossList).includes(sealCandidateId), textOf(crossList));

      const { result: crossAppend } = await callBlobs(baseUrl, sessionB, { action: 'append', blob_id: appendId, seq: 3, data: 'x' }, 32);
      ok('cross-owner append: isError', crossAppend?.isError === true, JSON.stringify(crossAppend));

      const { result: crossSeal } = await callBlobs(baseUrl, sessionB, { action: 'seal', blob_id: appendId }, 33);
      ok('cross-owner seal: isError', crossSeal?.isError === true, JSON.stringify(crossSeal));

      const { result: crossDelete } = await callBlobs(baseUrl, sessionB, { action: 'delete', blob_id: appendId }, 34);
      ok('cross-owner delete: isError, same as deleting a nonexistent id', crossDelete?.isError === true, JSON.stringify(crossDelete));

      const { result: ownList } = await callBlobs(baseUrl, sessionA, { action: 'list' }, 35);
      ok('cross-owner attempts left the target blob untouched (still in owner A\'s list)', textOf(ownList).includes(appendId), textOf(ownList));
    }

    // --- action enum validation ---
    {
      const { result } = await callBlobs(baseUrl, sessionA, { action: 'nonsense' }, 36);
      ok('unknown action: isError', result?.isError === true, JSON.stringify(result));
      ok('unknown action: error text lists the valid actions', textOf(result).includes('"create", "append", "seal", "list", "delete"'), textOf(result));
    }

    /** create -> seal (optionally with data) a fresh blob owned by sessionA; returns its id. */
    async function createSealedBlob(data, idBase) {
      const { result: createResult } = await callBlobs(baseUrl, sessionA, { action: 'create', data }, idBase);
      const id = textOf(createResult).match(UUID_RE)?.[0];
      await callBlobs(baseUrl, sessionA, { action: 'seal', blob_id: id }, idBase + 1);
      return id;
    }

    // --- context_blob_id byte-identity: sync path ---
    {
      const text = 'The quick brown fox jumps over the lazy dog. 🦊';
      const blobId = await createSealedBlob(text, 100);

      backend.reset();
      const { result: directResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'sync byte-identity', context: text }, 102);
      ok('byte-identity (sync): direct context call not isError', directResult?.isError !== true, JSON.stringify(directResult));
      const directRequest = backend.requests.at(-1);

      const { result: blobResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'sync byte-identity', context_blob_id: blobId }, 103);
      ok('byte-identity (sync): blob-sourced call not isError', blobResult?.isError !== true, JSON.stringify(blobResult));
      const blobRequest = backend.requests.at(-1);

      ok('byte-identity (sync): upstream requests[].messages are byte-identical',
        JSON.stringify(directRequest?.messages) === JSON.stringify(blobRequest?.messages),
        `direct=${JSON.stringify(directRequest?.messages)}\nblob=${JSON.stringify(blobRequest?.messages)}`);
    }

    // --- context_blob_id byte-identity: async path (jobs get with wait_ms lets us skip a manual poll loop for the "direct" half) ---
    {
      const text = 'Async byte-identity payload — no surprises expected. 🚀';
      const blobId = await createSealedBlob(text, 110);

      backend.reset();
      const { result: directSubmit } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'async byte-identity', context: text, async: true }, 112);
      const directJobId = textOf(directSubmit).match(UUID_RE)?.[0];
      ok('byte-identity (async): direct context job submitted', !!directJobId, textOf(directSubmit));
      const { text: directDone } = await pollUntilDone(baseUrl, sessionA, directJobId, { idBase: 8100 });
      ok('byte-identity (async): direct context job completed (not a failure)', !/^❌/.test(directDone), directDone);
      const directRequest = backend.requests.at(-1);

      const { result: blobSubmit } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'async byte-identity', context_blob_id: blobId, async: true }, 113);
      const blobJobId = textOf(blobSubmit).match(UUID_RE)?.[0];
      ok('byte-identity (async): blob-sourced job submitted', !!blobJobId, textOf(blobSubmit));
      const { text: blobDone } = await pollUntilDone(baseUrl, sessionA, blobJobId, { idBase: 8200 });
      ok('byte-identity (async): blob-sourced job completed (not a failure)', !/^❌/.test(blobDone), blobDone);
      const blobRequest = backend.requests.at(-1);

      ok('byte-identity (async): upstream requests[].messages are byte-identical',
        JSON.stringify(directRequest?.messages) === JSON.stringify(blobRequest?.messages),
        `direct=${JSON.stringify(directRequest?.messages)}\nblob=${JSON.stringify(blobRequest?.messages)}`);
    }

    // --- context_blob_id exclusivity: context + context_blob_id together is an error ---
    {
      const blobId = await createSealedBlob('irrelevant', 120);
      const { result } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'x', context: 'also set', context_blob_id: blobId }, 122);
      ok('context + context_blob_id together: isError', result?.isError === true, JSON.stringify(result));
      ok('context + context_blob_id together: exact wording',
        textOf(result) === 'Error: context and context_blob_id cannot both be set — context_blob_id supplies the context out-of-band, so sending both is redundant. Use one or the other.',
        textOf(result));
    }

    // --- context_blob_id exclusivity: context: '' still counts as "set" (undefined check, not truthy check) ---
    {
      const blobId = await createSealedBlob('irrelevant', 124);
      const { result } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'x', context: '', context_blob_id: blobId }, 126);
      ok('context: \'\' + context_blob_id together: isError (empty string still counts as "set")', result?.isError === true, JSON.stringify(result));
    }

    // --- context_blob_id exclusivity: conversation params ---
    {
      const blobId = await createSealedBlob('irrelevant', 128);
      const { result: withStart } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'x', context_blob_id: blobId, start_conversation: true }, 130);
      ok('context_blob_id + start_conversation: isError', withStart?.isError === true, JSON.stringify(withStart));
      ok('context_blob_id + start_conversation: exact wording',
        textOf(withStart) === 'Error: context_blob_id does not currently support start_conversation/conversation_id together — this is a scope limit for the initial release, not a technical incompatibility, and may be lifted later. Submit without the conversation params when using context_blob_id, or drop context_blob_id to use a conversation.',
        textOf(withStart));

      const { result: withConvId } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'x', context_blob_id: blobId, conversation_id: 'whatever' }, 131);
      ok('context_blob_id + conversation_id: isError', withConvId?.isError === true, JSON.stringify(withConvId));
      ok('context_blob_id + conversation_id: same exact wording as start_conversation case',
        textOf(withConvId) === textOf(withStart), textOf(withConvId));
    }

    // --- context_blob_id: empty sealed blob is rejected explicitly, not silently dropped ---
    {
      const emptyBlobId = await createSealedBlob('', 133);
      const { result } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'x', context_blob_id: emptyBlobId }, 135);
      ok('empty sealed blob as context_blob_id: isError', result?.isError === true, JSON.stringify(result));
      ok('empty sealed blob as context_blob_id: exact wording',
        textOf(result) === `Error: blob ${emptyBlobId} is sealed but empty — nothing to use as context.`, textOf(result));
    }

    // --- context_blob_id: an open (not yet sealed) blob is rejected with the 14-2 invalid_state wording, unmodified ---
    {
      const { result: createResult } = await callBlobs(baseUrl, sessionA, { action: 'create', data: 'not sealed yet' }, 137);
      const openBlobId = textOf(createResult).match(UUID_RE)?.[0];
      const { result } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'x', context_blob_id: openBlobId }, 138);
      ok('open blob as context_blob_id: isError', result?.isError === true, JSON.stringify(result));
      ok('open blob as context_blob_id: exact 14-2 invalid_state wording, unmodified',
        textOf(result) === `Error: blob ${openBlobId} is still open — seal it first with blobs seal before reading its content.`, textOf(result));
    }

    // --- context_blob_id: unknown / another owner's blob_id is not_found, unmodified 14-2 wording ---
    {
      const bogus = '00000000-0000-0000-0000-000000000000';
      const { result: unknownResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'x', context_blob_id: bogus }, 140);
      ok('unknown blob_id as context_blob_id: isError', unknownResult?.isError === true, JSON.stringify(unknownResult));
      ok('unknown blob_id as context_blob_id: not_found wording',
        textOf(unknownResult) === `Error: blob ${bogus} was not found or is not available to you.`, textOf(unknownResult));

      const { sessionId: sessionB } = await initializeSession(baseUrl, '/mcp');
      const otherOwnerBlobId = await createSealedBlob('owner A data', 142);
      const { result: crossOwnerResult } = await callCustomPrompt(baseUrl, sessionB, { instruction: 'x', context_blob_id: otherOwnerBlobId }, 144);
      ok('another owner\'s blob_id as context_blob_id: isError', crossOwnerResult?.isError === true, JSON.stringify(crossOwnerResult));
      ok('another owner\'s blob_id as context_blob_id: same not_found wording (no ownership leak)',
        textOf(crossOwnerResult) === `Error: blob ${otherOwnerBlobId} was not found or is not available to you.`, textOf(crossOwnerResult));
    }

    // --- context_blob_id: unaffected regression — context: '' alone (no blob) still produces the same upstream messages as omitting context entirely (unchanged truthy-check behaviour) ---
    {
      backend.reset();
      const { result: emptyCtxResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'empty context regression', context: '' }, 146);
      ok('context: \'\' alone: not isError', emptyCtxResult?.isError !== true, JSON.stringify(emptyCtxResult));
      const emptyCtxRequest = backend.requests.at(-1);

      backend.reset();
      const { result: noCtxResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'empty context regression' }, 147);
      ok('no context field at all: not isError', noCtxResult?.isError !== true, JSON.stringify(noCtxResult));
      const noCtxRequest = backend.requests.at(-1);

      ok('context: \'\' alone produces the same upstream messages as omitting context (both stay falsy)',
        JSON.stringify(emptyCtxRequest?.messages) === JSON.stringify(noCtxRequest?.messages),
        `empty=${JSON.stringify(emptyCtxRequest?.messages)}\nomitted=${JSON.stringify(noCtxRequest?.messages)}`);
    }

    // --- context_blob_id: plain regression — a call with neither context nor context_blob_id still works (14-3b introduced no side effects on the common case) ---
    {
      const { result } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'plain regression, no context at all' }, 149);
      ok('plain custom_prompt call (no context, no context_blob_id): not isError', result?.isError !== true, JSON.stringify(result));
    }

    console.log(failed ? `\n${failed} FAILED so far\n` : '\nMain blobs e2e suite passed so far\n');
  } finally {
    child.kill();
    await backend.close();
  }

  // === Kill switch: HOUTINI_LM_BLOBS=0 hides the tool and rejects direct calls ===
  console.log('\n=== HOUTINI_LM_BLOBS=0 E2E Tests ===\n');
  {
    const backend2 = await startFakeBackend();
    const port2 = await getFreePort();
    const { child: child2, ready: ready2 } = startServer(backend2.url, port2, { HOUTINI_LM_BLOBS: '0' });
    const baseUrl2 = `http://127.0.0.1:${port2}`;
    try {
      await ready2;
      const { sessionId } = await initializeSession(baseUrl2, '/mcp');

      const list = await toolsList(baseUrl2, sessionId, 2);
      const toolNames = (list?.tools ?? []).map((t) => t.name);
      ok('blobs=0: tools/list does not include the blobs tool', !toolNames.includes('blobs'), JSON.stringify(toolNames));

      const { result: directCall } = await callBlobs(baseUrl2, sessionId, { action: 'list' }, 3);
      ok('blobs=0: calling the (unlisted) blobs tool directly is isError', directCall?.isError === true, JSON.stringify(directCall));
      ok('blobs=0: direct call reports the kill switch message', textOf(directCall).includes('HOUTINI_LM_BLOBS=0'), textOf(directCall));

      // --- context_blob_id (phase 14-3b) is gated by the same kill switch ---
      const cpProps2 = (list?.tools ?? []).find((t) => t.name === 'custom_prompt')?.inputSchema?.properties ?? {};
      ok('blobs=0: custom_prompt.inputSchema has no context_blob_id', !('context_blob_id' in cpProps2), JSON.stringify(Object.keys(cpProps2)));

      const { result: directCtxCall } = await callCustomPrompt(baseUrl2, sessionId, { instruction: 'x', context_blob_id: 'whatever' }, 4);
      ok('blobs=0: custom_prompt with context_blob_id is isError', directCtxCall?.isError === true, JSON.stringify(directCtxCall));
      ok('blobs=0: context_blob_id call reports the kill switch message', textOf(directCtxCall).includes('HOUTINI_LM_BLOBS=0'), textOf(directCtxCall));

      console.log(failed ? `\n${failed} FAILED\n` : '\nAll HOUTINI_LM_BLOBS=0 e2e tests passed\n');
    } finally {
      child2.kill();
      await backend2.close();
    }
  }

  // === onclose: MCP session DELETE clears that owner's blobs (observed via a tight HOUTINI_LM_BLOB_MAX) ===
  console.log('\n=== Blobs onclose E2E Test ===\n');
  {
    const backend3 = await startFakeBackend();
    const port3 = await getFreePort();
    const { child: child3, ready: ready3 } = startServer(backend3.url, port3, { HOUTINI_LM_BLOB_MAX: '1' });
    const baseUrl3 = `http://127.0.0.1:${port3}`;
    try {
      await ready3;
      const { sessionId: sessionC } = await initializeSession(baseUrl3, '/mcp');

      const { result: createResult } = await callBlobs(baseUrl3, sessionC, { action: 'create' }, 2);
      ok('onclose setup: first blob (fills the max-1 capacity) created', createResult?.isError !== true, JSON.stringify(createResult));

      const { result: overCapacity } = await callBlobs(baseUrl3, sessionC, { action: 'create' }, 3);
      ok('onclose setup: capacity is genuinely exhausted (sanity check for the rest of this test)', overCapacity?.isError === true, JSON.stringify(overCapacity));
      ok('onclose setup: exhaustion is store_full, not something else', textOf(overCapacity).includes('global blob capacity is full'), textOf(overCapacity));

      const delRes = await fetch(`${baseUrl3}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionC } });
      ok('onclose: session DELETE succeeded', delRes.status === 200 || delRes.status === 204, String(delRes.status));

      const { sessionId: sessionD } = await initializeSession(baseUrl3, '/mcp');
      const { result: afterCloseCreate } = await callBlobs(baseUrl3, sessionD, { action: 'create' }, 4);
      ok('onclose: a new session can create a blob after the old owner\'s session closed (capacity was freed by blobs.clear())',
        afterCloseCreate?.isError !== true, JSON.stringify(afterCloseCreate));

      console.log(failed ? `\n${failed} FAILED\n` : '\nBlobs onclose e2e test passed\n');
    } finally {
      child3.kill();
      await backend3.close();
    }
  }

  console.log(failed ? `\n${failed} FAILED\n` : '\nAll blobs e2e tests passed\n');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
