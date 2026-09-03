#!/usr/bin/env node
/**
 * End-to-end test for async job execution (phase 13-2: `async: true` on
 * custom_prompt/code_task_files + the `jobs` tool). Spawns dist/index.js
 * with HOUTINI_LM_TRANSPORT=http against fake-openai-backend.mjs and drives
 * it over real HTTP — same transport mechanics as test-conversations-e2e.mjs
 * (session establishment is imported from http-test-helpers.mjs, not
 * re-derived here).
 *
 * Output format matches the other e2e suites: `PASS  <name>` / `FAIL  <name>`.
 *
 * Usage: node scripts/test-jobs-e2e.mjs
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startFakeBackend } from './fake-openai-backend.mjs';
import { getFreePort, startServer, post, initializeSession } from './http-test-helpers.mjs';

const thisFile = fileURLToPath(import.meta.url);

let failed = 0;
function ok(name, cond, detail) {
  const pass = !!cond;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ` — ${detail}` : ''}\n`);
  if (!pass) failed++;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Global variant for String.matchAll() (phase 15-1a: extracting the 2nd UUID — the conversation id — out of a
// "Job <uuid> submitted ... Started conversation <uuid>" response). matchAll() throws on a non-global RegExp.
const UUID_RE_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function callTool(baseUrl, sessionId, toolName, args, id) {
  const res = await post(baseUrl, '/mcp', {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, sessionId);
  const result = res.messages.find((m) => m.id === id)?.result;
  return { httpStatus: res.status, result };
}
const callCustomPrompt = (baseUrl, sessionId, args, id) => callTool(baseUrl, sessionId, 'custom_prompt', args, id);
const callCodeTaskFiles = (baseUrl, sessionId, args, id) => callTool(baseUrl, sessionId, 'code_task_files', args, id);
const callJobs = (baseUrl, sessionId, args, id) => callTool(baseUrl, sessionId, 'jobs', args, id);
// phase 15-1a: chat/conversations helpers, mirroring test-conversations-e2e.mjs's, needed to exercise D3's
// cross-tool exclusion and D5's mid-flight-delete case.
const callChat = (baseUrl, sessionId, args, id) => callTool(baseUrl, sessionId, 'chat', args, id);
const callConversations = (baseUrl, sessionId, args, id) => callTool(baseUrl, sessionId, 'conversations', args, id);

async function toolsList(baseUrl, sessionId, id) {
  const res = await post(baseUrl, '/mcp', { jsonrpc: '2.0', id, method: 'tools/list', params: {} }, sessionId);
  return res.messages.find((m) => m.id === id)?.result;
}

function textOf(result) {
  return result?.content?.[0]?.text ?? '';
}

/**
 * True if `conversations list`'s markdown table (`| conversation_id | turns | chars | idle | expires in |`)
 * shows exactly `n` turns for `convId`. NOT the "💬 Conversation ... — N turns" trailing line format
 * (formatConversationLine in src/conversation-store.ts) — that one is appended to chat/custom_prompt
 * responses, not to `list`'s table rows.
 */
function convHasTurns(listText, convId, n) {
  return new RegExp(`\\|\\s*${convId}\\s*\\|\\s*${n}\\s*\\|`).test(listText);
}

/** Content portion of a synchronous/completed-job response, stripped of the timing-dependent "---" footer. */
function contentPortion(text) {
  return text.split('\n\n---')[0];
}

/** Poll `jobs get` (short-polling, no wait_ms) until the job reaches a terminal state or attempts run out. */
async function pollUntilDone(baseUrl, sessionId, jobId, { intervalMs = 200, maxAttempts = 50, idBase = 5000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const { result } = await callJobs(baseUrl, sessionId, { action: 'get', job_id: jobId }, idBase + i);
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

/** Minimal backend whose /v1/chat/completions always fails — for the "failed job" case. Not fake-openai-backend.mjs: that file only grew firstChunkDelayMs for phase 13, not an error mode. */
function startErrorBackend() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', created: 0, owned_by: 'fake' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'synthetic backend failure for the failed-job test case' } }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function main() {
  // === Main functional suite ===
  const backend = await startFakeBackend();
  const port = await getFreePort();
  const { child, ready } = startServer(backend.url, port);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await ready;
    console.log('\n=== Async Jobs E2E Tests (phase 13-2) ===\n');

    // --- tools/list exposes jobs, and async on custom_prompt/code_task_files ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const list = await toolsList(baseUrl, sessionId, 99);
      const names = (list?.tools ?? []).map((t) => t.name);
      ok('tools/list includes the jobs tool', names.includes('jobs'), JSON.stringify(names));
      const cpProps = (list?.tools ?? []).find((t) => t.name === 'custom_prompt')?.inputSchema?.properties ?? {};
      const ctfProps = (list?.tools ?? []).find((t) => t.name === 'code_task_files')?.inputSchema?.properties ?? {};
      ok('tools/list: custom_prompt.inputSchema.properties has async', 'async' in cpProps, JSON.stringify(Object.keys(cpProps)));
      ok('tools/list: code_task_files.inputSchema.properties has async', 'async' in ctfProps, JSON.stringify(Object.keys(ctfProps)));
      const chatProps = (list?.tools ?? []).find((t) => t.name === 'chat')?.inputSchema?.properties ?? {};
      const codeTaskProps = (list?.tools ?? []).find((t) => t.name === 'code_task')?.inputSchema?.properties ?? {};
      ok('tools/list: chat.inputSchema.properties has no async (untouched by phase 13)', !('async' in chatProps), JSON.stringify(Object.keys(chatProps)));
      ok('tools/list: code_task.inputSchema.properties has no async (untouched by phase 13)', !('async' in codeTaskProps), JSON.stringify(Object.keys(codeTaskProps)));
      const jobsProps = (list?.tools ?? []).find((t) => t.name === 'jobs')?.inputSchema?.properties ?? {};
      ok('tools/list: jobs.inputSchema.properties has offset (phase 14-1)', 'offset' in jobsProps, JSON.stringify(Object.keys(jobsProps)));
      ok('tools/list: jobs.inputSchema.properties has limit (phase 14-1)', 'limit' in jobsProps, JSON.stringify(Object.keys(jobsProps)));
    }

    // --- submit: returns immediately (well under a full round trip) with a job id, not isError ---
    let jobIdA, sessionA;
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      sessionA = sessionId;
      backend.reset();
      const start = Date.now();
      const { result } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'job test one', max_tokens: 64, async: true }, 2);
      const elapsedMs = Date.now() - start;
      ok('submit: not isError', result?.isError !== true, JSON.stringify(result));
      const text = textOf(result);
      const match = text.match(UUID_RE);
      ok('submit: response contains a UUID-shaped job id', !!match, text);
      jobIdA = match?.[0];
      ok('submit: response mentions the job was submitted', /submitted/i.test(text), text);
      ok('submit: returns well under a full inference round trip (<3s)', elapsedMs < 3000, String(elapsedMs));
    }

    // --- pending → completed transition, observed via list and get ---
    let completedTextA;
    {
      const { result: listResult } = await callJobs(baseUrl, sessionA, { action: 'list' }, 3);
      ok('list: includes the submitted job id', textOf(listResult).includes(jobIdA), textOf(listResult));

      const { result: immediateGet } = await callJobs(baseUrl, sessionA, { action: 'get', job_id: jobIdA, wait_ms: 0 }, 4);
      ok('get wait_ms:0 right after submit: not isError', immediateGet?.isError !== true, JSON.stringify(immediateGet));
      ok('get wait_ms:0 right after submit: reports pending or running, not the result yet',
        /^⏳/.test(textOf(immediateGet)), textOf(immediateGet));

      const { text } = await pollUntilDone(baseUrl, sessionA, jobIdA);
      ok('poll: job reaches a terminal state with the fake backend\'s content', text.includes('Hello, this is fake.'), text);
      // Phase 14-1 regression: this result is well under the default
      // HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS ceiling (50,000), so `get`
      // with no offset/limit must return it byte-identical to phase 13 —
      // no chunk footer appended.
      ok('poll: default-size result has no chunk footer (byte-identical to phase 13)', !text.includes('--- job result chunk:'), text);
      completedTextA = text;

      const { result: listAfter } = await callJobs(baseUrl, sessionA, { action: 'list' }, 40);
      ok('list after completion: still includes the job id (not evicted — TTL default is 60min)', textOf(listAfter).includes(jobIdA), textOf(listAfter));
      ok('list after completion: reports state completed', new RegExp(`${jobIdA}[^\\n]*completed`).test(textOf(listAfter)), textOf(listAfter));
    }

    // --- result content matches what a synchronous call produces (footer timing legitimately differs between two separate calls, so only the content portion is compared) ---
    {
      backend.reset();
      const { result: syncResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'job test one', max_tokens: 64 }, 41);
      ok('sync comparison call: not isError', syncResult?.isError !== true, JSON.stringify(syncResult));
      const syncContent = contentPortion(textOf(syncResult));
      const jobContent = contentPortion(completedTextA);
      ok('completed job content matches a synchronous call\'s content', syncContent === jobContent && syncContent.length > 0,
        JSON.stringify({ syncContent, jobContent }));
    }

    // --- wait_ms: a single get with a generous wait_ms returns the completed result without a manual poll loop ---
    {
      backend.reset();
      const { result: submitResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'job test wait_ms', max_tokens: 64, async: true }, 42);
      const jobId = textOf(submitResult).match(UUID_RE)?.[0];
      ok('wait_ms case: submitted', !!jobId, textOf(submitResult));
      const { result: waitedGet } = await callJobs(baseUrl, sessionA, { action: 'get', job_id: jobId, wait_ms: 10000 }, 43);
      ok('wait_ms:10000 returns the completed result directly', textOf(waitedGet).includes('Hello, this is fake.'), textOf(waitedGet));
      ok('wait_ms:10000 result is not isError', waitedGet?.isError !== true, JSON.stringify(waitedGet));
    }

    // --- cross-owner: another session cannot see or fetch this owner's job_id; same response as a nonexistent id ---
    {
      const { sessionId: sessionB } = await initializeSession(baseUrl, '/mcp');
      const { result: crossListResult } = await callJobs(baseUrl, sessionB, { action: 'list' }, 44);
      ok('cross-owner list: does not include another owner\'s job id', !textOf(crossListResult).includes(jobIdA), textOf(crossListResult));

      const { result: crossGet } = await callJobs(baseUrl, sessionB, { action: 'get', job_id: jobIdA }, 45);
      ok('cross-owner get: isError', crossGet?.isError === true, JSON.stringify(crossGet));
      const { result: nonexistentGet } = await callJobs(baseUrl, sessionB, { action: 'get', job_id: '00000000-0000-0000-0000-000000000000' }, 46);
      ok('cross-owner get: identical response to a nonexistent job_id (no existence leak)',
        textOf(crossGet) === textOf(nonexistentGet) && crossGet?.isError === nonexistentGet?.isError,
        JSON.stringify({ cross: crossGet, nonexistent: nonexistentGet }));

      const { result: crossDelete } = await callJobs(baseUrl, sessionB, { action: 'delete', job_id: jobIdA }, 47);
      ok('cross-owner delete: isError, same as deleting a nonexistent id', crossDelete?.isError === true, JSON.stringify(crossDelete));
    }

    // --- delete: owner can delete their own job; it then behaves like a nonexistent id ---
    {
      backend.reset();
      const { result: submitResult } = await callCustomPrompt(baseUrl, sessionA, { instruction: 'delete-me', max_tokens: 64, async: true }, 48);
      const jobId = textOf(submitResult).match(UUID_RE)?.[0];
      await pollUntilDone(baseUrl, sessionA, jobId, { idBase: 6000 });

      const { result: deleteResult } = await callJobs(baseUrl, sessionA, { action: 'delete', job_id: jobId }, 49);
      ok('delete: own job is not isError', deleteResult?.isError !== true, JSON.stringify(deleteResult));

      const { result: getAfterDelete } = await callJobs(baseUrl, sessionA, { action: 'get', job_id: jobId }, 50);
      ok('get after delete: isError (not found)', getAfterDelete?.isError === true, JSON.stringify(getAfterDelete));
    }

    // --- phase 15-1a: async: true together with start_conversation/conversation_id is now ALLOWED. This is an
    // intentional contract reversal from the block this replaces ("async + conversation is rejected") — see
    // .claude/phases/phase15-async-conversations.md and the commit message for the rationale (D1-D6). ---

    // --- D1/D2: async + start_conversation submits, completes, and the conversation reaches 2 turns ---
    let d3ConvId, d3SessionId;
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      d3SessionId = sessionId;
      backend.reset();
      const { result: startResult } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'turn one', max_tokens: 64, async: true, start_conversation: true }, 500);
      ok('async + start_conversation: not isError', startResult?.isError !== true, JSON.stringify(startResult));
      const startText = textOf(startResult);
      ok('async + start_conversation: no request reached the backend before the job runs', backend.requests.length === 0, String(backend.requests.length));
      const jobId1 = startText.match(UUID_RE)?.[0];
      ok('async + start_conversation: submitted with a job id', !!jobId1, startText);
      ok('async + start_conversation: mentions a started conversation (0 turns so far)', /Started conversation/.test(startText) && /0 turns/.test(startText), startText);
      const matches = [...startText.matchAll(UUID_RE_G)].map((m) => m[0]);
      const convId = matches.find((m) => m !== jobId1);
      ok('async + start_conversation: a second UUID (the conversation id) is present', !!convId, startText);
      d3ConvId = convId;

      await pollUntilDone(baseUrl, sessionId, jobId1, { idBase: 10000 });
      const { result: listAfterStart } = await callConversations(baseUrl, sessionId, { action: 'list' }, 501);
      ok('async + start_conversation: conversation has 2 turns after the job completes', convHasTurns(textOf(listAfterStart), convId, 2), textOf(listAfterStart));
    }

    // --- D2: async + conversation_id continues that conversation; upstream messages carry the prior turn ---
    {
      backend.reset();
      const { result: turn2Result } = await callCustomPrompt(baseUrl, d3SessionId, { instruction: 'turn two', max_tokens: 64, async: true, conversation_id: d3ConvId }, 502);
      const jobId2 = textOf(turn2Result).match(UUID_RE)?.[0];
      ok('async + conversation_id continuation: submitted', !!jobId2, textOf(turn2Result));
      const { text: turn2Text } = await pollUntilDone(baseUrl, d3SessionId, jobId2, { idBase: 10100 });
      ok('async + conversation_id: job completes', turn2Text.includes('Hello, this is fake.'), turn2Text);
      ok('async + conversation_id: completed result carries a conversation line', /💬 Conversation/.test(turn2Text), turn2Text);

      // Structural pin (regression): the 2nd turn's upstream request is
      // exactly [system, history-user, history-assistant, new-instruction]
      // — the same shape the synchronous path has always produced, now
      // shared via customPromptContextState()/messages assembly order
      // (system -> history -> context/ack -> instruction).
      ok('async + conversation_id: exactly one upstream request for this turn', backend.requests.length === 1, String(backend.requests.length));
      const req2 = backend.requests[0];
      const roles = (req2?.messages ?? []).map((m) => m.role);
      ok('async + conversation_id: upstream messages are [system, user, assistant, user]', JSON.stringify(roles) === JSON.stringify(['system', 'user', 'assistant', 'user']), JSON.stringify(roles));
      ok('async + conversation_id: history user turn is "turn one"', req2?.messages?.[1]?.content === 'turn one', JSON.stringify(req2?.messages?.[1]));
      ok('async + conversation_id: new instruction is "turn two"', req2?.messages?.[3]?.content === 'turn two', JSON.stringify(req2?.messages?.[3]));
    }

    // --- D3: while a job is in flight for a conversation, every new call against it (any tool, sync or async) is rejected ---
    {
      backend.setFirstChunkDelayMs(4000); // keep the job running long enough to exercise D3
      backend.reset();
      const { result: blockerResult } = await callCustomPrompt(baseUrl, d3SessionId, { instruction: 'blocker turn', max_tokens: 64, async: true, conversation_id: d3ConvId }, 503);
      const blockerJobId = textOf(blockerResult).match(UUID_RE)?.[0];
      ok('D3 setup: blocker job submitted', !!blockerJobId, textOf(blockerResult));

      // Phase 15-1b: let the blocker job's own upstream request land before
      // taking the baseline below — without this wait, that request can
      // still be in flight when the baseline is captured and then land
      // during one of the blocked calls below, false-failing the "none of
      // the blocked calls reached the backend" check (observed flaky
      // without this wait; see the cross-tool D3 test further down for the
      // same fix with a fuller explanation).
      await new Promise((r) => setTimeout(r, 300));
      const requestsBeforeD3 = backend.requests.length;
      const { result: d3Async } = await callCustomPrompt(baseUrl, d3SessionId, { instruction: 'should be blocked', max_tokens: 64, async: true, conversation_id: d3ConvId, force_thinking: false }, 504);
      ok('D3: a 2nd async submission to the same conversation is isError', d3Async?.isError === true, JSON.stringify(d3Async));
      const { result: d3Sync } = await callCustomPrompt(baseUrl, d3SessionId, { instruction: 'should be blocked', max_tokens: 64, conversation_id: d3ConvId }, 505);
      ok('D3: a synchronous custom_prompt call to the same conversation is isError', d3Sync?.isError === true, JSON.stringify(d3Sync));
      const { result: d3Chat } = await callChat(baseUrl, d3SessionId, { message: 'should be blocked', max_tokens: 64, conversation_id: d3ConvId }, 506);
      ok('D3: a synchronous chat call to the same conversation is isError', d3Chat?.isError === true, JSON.stringify(d3Chat));
      ok('D3: none of the three blocked calls reached the backend', backend.requests.length === requestsBeforeD3, String(backend.requests.length));

      // D3 must not block an unrelated conversation or an unrelated owner.
      backend.reset();
      const { result: otherStart } = await callCustomPrompt(baseUrl, d3SessionId, { instruction: 'unrelated turn', max_tokens: 64, async: true, start_conversation: true }, 507);
      ok('D3 non-interference: an unrelated new conversation is not blocked', otherStart?.isError !== true, JSON.stringify(otherStart));
      const otherJobId = textOf(otherStart).match(UUID_RE)?.[0];
      if (otherJobId) await pollUntilDone(baseUrl, d3SessionId, otherJobId, { idBase: 10200 });

      const { sessionId: otherOwnerSession } = await initializeSession(baseUrl, '/mcp');
      const { result: crossOwnerResult } = await callCustomPrompt(baseUrl, otherOwnerSession, { instruction: 'cross-owner probe', max_tokens: 64, conversation_id: d3ConvId }, 508);
      ok('D3 non-interference: a different owner gets the ordinary not-found error, not the busy error', crossOwnerResult?.isError === true && !/still in progress/i.test(textOf(crossOwnerResult)), textOf(crossOwnerResult));

      backend.setFirstChunkDelayMs(0);
      await pollUntilDone(baseUrl, d3SessionId, blockerJobId, { idBase: 10300 });
    }

    // --- D4 (a failed async job does not append turns) is verified in the "Failed job E2E Test" section
    // below, against the dedicated always-erroring backend — see that section for the conversation checks.

    // --- D5: a conversation deleted while its job is running does not silently lose the completion; the
    // result says so instead of the turns vanishing unnoticed ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.setFirstChunkDelayMs(2000);
      backend.reset();
      const { result: d5Start } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'd5 turn one', max_tokens: 64, async: true, start_conversation: true }, 511);
      const d5JobId = textOf(d5Start).match(UUID_RE)?.[0];
      const d5ConvId = [...textOf(d5Start).matchAll(UUID_RE_G)].map((m) => m[0]).find((m) => m !== d5JobId);
      ok('D5 setup: job submitted with a conversation', !!d5JobId && !!d5ConvId, textOf(d5Start));

      const { result: deleteResult } = await callConversations(baseUrl, sessionId, { action: 'delete', conversation_id: d5ConvId }, 512);
      ok('D5 setup: conversation deleted while its job is still running', deleteResult?.isError !== true, JSON.stringify(deleteResult));

      backend.setFirstChunkDelayMs(0);
      const { text: d5Text } = await pollUntilDone(baseUrl, sessionId, d5JobId, { idBase: 10500 });
      ok('D5: completion says the conversation was not updated (expired/deleted), rather than silently dropping it', /conversation expired; turns were not recorded/.test(d5Text), d5Text);
    }

    // --- ghost-append guard: deleting the JOB record (not the conversation) mid-flight must not let its
    // completion append turns behind a later call's turns (found by plan-deep-check's Fable review) ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.setFirstChunkDelayMs(2000);
      backend.reset();
      const { result: ghostStart } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'ghost turn one', max_tokens: 64, async: true, start_conversation: true }, 513);
      const ghostJobId = textOf(ghostStart).match(UUID_RE)?.[0];
      const ghostConvId = [...textOf(ghostStart).matchAll(UUID_RE_G)].map((m) => m[0]).find((m) => m !== ghostJobId);
      ok('ghost-append setup: job submitted with a conversation', !!ghostJobId && !!ghostConvId, textOf(ghostStart));

      const { result: jobDeleteResult } = await callJobs(baseUrl, sessionId, { action: 'delete', job_id: ghostJobId }, 514);
      ok('ghost-append setup: job record deleted while it is still running', jobDeleteResult?.isError !== true, JSON.stringify(jobDeleteResult));

      // With the job's D3 lock now released (its record is gone), a fresh
      // synchronous call against the same conversation succeeds and records
      // the "real" turn 2 before the deleted job's fn() finishes.
      backend.setFirstChunkDelayMs(0);
      const { result: legitTurn2 } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'ghost turn two (legit)', max_tokens: 64, conversation_id: ghostConvId }, 515);
      ok('ghost-append: a fresh call to the same conversation succeeds once the job record is gone', legitTurn2?.isError !== true, JSON.stringify(legitTurn2));

      // Give the deleted job's still-in-flight fn() time to finish and attempt its (guarded) append. The
      // deleted job's own "turn one" is never recorded (it's still mid-flight when its record is deleted,
      // so the ghost-append guard suppresses it) — the only turns that land are the legit call's, so the
      // conversation should have exactly 2 turns, not 4 (which it would if the ghost append went through
      // on top of the legit one) and not 0 (which it would if the guard also swallowed the legit call).
      await new Promise((r) => setTimeout(r, 2500));
      const { result: listAfterGhost } = await callConversations(baseUrl, sessionId, { action: 'list' }, 516);
      ok('ghost-append: conversation has exactly 2 turns (only the legit call — the ghost job\'s append was suppressed, not doubled up)', convHasTurns(textOf(listAfterGhost), ghostConvId, 2), textOf(listAfterGhost));
    }

    // --- multi-tenant: owner A's async job never appends to owner B's conversation, even by (impossible) accident ---
    {
      const { sessionId: ownerA } = await initializeSession(baseUrl, '/mcp');
      const { sessionId: ownerB } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result: bStart } = await callCustomPrompt(baseUrl, ownerB, { instruction: 'owner B turn one', max_tokens: 64, async: true, start_conversation: true }, 517);
      const bJobId = textOf(bStart).match(UUID_RE)?.[0];
      const bConvId = [...textOf(bStart).matchAll(UUID_RE_G)].map((m) => m[0]).find((m) => m !== bJobId);
      await pollUntilDone(baseUrl, ownerB, bJobId, { idBase: 10600 });

      const { result: aCrossResult } = await callCustomPrompt(baseUrl, ownerA, { instruction: 'owner A trying to use B\'s conversation', max_tokens: 64, async: true, conversation_id: bConvId }, 518);
      ok('multi-tenant: owner A cannot submit an async job against owner B\'s conversation_id', aCrossResult?.isError === true, JSON.stringify(aCrossResult));

      const { result: bListAfter } = await callConversations(baseUrl, ownerB, { action: 'list' }, 519);
      ok('multi-tenant: owner B\'s conversation is unaffected (still 2 turns)', convHasTurns(textOf(bListAfter), bConvId, 2), textOf(bListAfter));
    }

    // --- regression: async: true with no conversation params at all still produces the pre-15-1a message shape ---
    {
      backend.reset();
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const { result: plainAsync } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'plain async, no conversation', max_tokens: 64, async: true }, 520);
      const plainJobId = textOf(plainAsync).match(UUID_RE)?.[0];
      await pollUntilDone(baseUrl, sessionId, plainJobId, { idBase: 10700 });
      ok('regression (async, no conversation): exactly one upstream request', backend.requests.length === 1, String(backend.requests.length));
      const plainReq = backend.requests[0];
      const plainRoles = (plainReq?.messages ?? []).map((m) => m.role);
      ok('regression (async, no conversation): upstream messages are [system, user] only — no history, no context/ack pair', JSON.stringify(plainRoles) === JSON.stringify(['system', 'user']), JSON.stringify(plainRoles));
    }

    // --- regression: a synchronous custom_prompt conversation's 2nd-turn messages keep the exact pre-15-1a shape,
    // now that customPromptContextState()/customPromptTurnsToStore() build them instead of inline logic ---
    {
      backend.reset();
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const { result: syncStart } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'sync turn one', max_tokens: 64, start_conversation: true }, 521);
      const syncConvId = textOf(syncStart).match(UUID_RE)?.[0];
      ok('regression (sync conversation) setup: started', !!syncConvId, textOf(syncStart));
      backend.reset();
      const { result: syncTurn2 } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'sync turn two', max_tokens: 64, conversation_id: syncConvId }, 522);
      ok('regression (sync conversation): 2nd turn not isError', syncTurn2?.isError !== true, JSON.stringify(syncTurn2));
      ok('regression (sync conversation): exactly one upstream request', backend.requests.length === 1, String(backend.requests.length));
      const syncReq = backend.requests[0];
      const syncRoles = (syncReq?.messages ?? []).map((m) => m.role);
      ok('regression (sync conversation): upstream messages are [system, user, assistant, user]', JSON.stringify(syncRoles) === JSON.stringify(['system', 'user', 'assistant', 'user']), JSON.stringify(syncRoles));
      ok('regression (sync conversation): history user turn is "sync turn one"', syncReq?.messages?.[1]?.content === 'sync turn one', JSON.stringify(syncReq?.messages?.[1]));
      ok('regression (sync conversation): new instruction is "sync turn two"', syncReq?.messages?.[3]?.content === 'sync turn two', JSON.stringify(syncReq?.messages?.[3]));
    }

    // --- code_task_files: paths are read and validated synchronously at submit time (invalid path fails before any job is queued) ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result: relativePathResult } = await callCodeTaskFiles(baseUrl, sessionId, { paths: ['relative/path.ts'], task: 'find bugs', async: true }, 2);
      ok('code_task_files async with a relative path: isError at submit time', relativePathResult?.isError === true, JSON.stringify(relativePathResult));
      ok('code_task_files async with a relative path: no job id in the response', !UUID_RE.test(textOf(relativePathResult)), textOf(relativePathResult));
      ok('code_task_files async with a relative path: no backend request', backend.requests.length === 0, String(backend.requests.length));

      backend.reset();
      const { result: submitResult } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'find bugs', async: true }, 3);
      ok('code_task_files async with a valid absolute path: submitted', textOf(submitResult).match(UUID_RE) !== null, textOf(submitResult));
      const jobId = textOf(submitResult).match(UUID_RE)?.[0];
      if (jobId) {
        const { text } = await pollUntilDone(baseUrl, sessionId, jobId, { idBase: 7000 });
        ok('code_task_files async job completes with the fake backend\'s content', text.includes('Hello, this is fake.'), text);
      }
    }

    // --- phase 15-1b: code_task_files now accepts start_conversation/conversation_id, and can continue a
    // conversation started by custom_prompt (and vice versa) — the file bundle itself is never recorded into
    // history, only a manifest line. See .claude/phases/phase15-async-conversations.md ---

    // --- cross-tool continuation, direction 1: custom_prompt starts, code_task_files continues ---
    let ctfConvId, ctfSessionId;
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      ctfSessionId = sessionId;
      backend.reset();
      const { result: cpStart } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'cross-tool turn one', max_tokens: 64, async: true, start_conversation: true }, 600);
      const cpJobId = textOf(cpStart).match(UUID_RE)?.[0];
      const convId = [...textOf(cpStart).matchAll(UUID_RE_G)].map((m) => m[0]).find((m) => m !== cpJobId);
      ok('cross-tool setup: custom_prompt started a conversation', !!cpJobId && !!convId, textOf(cpStart));
      ctfConvId = convId;
      await pollUntilDone(baseUrl, sessionId, cpJobId, { idBase: 11000 });

      backend.reset();
      const { result: ctfContinue } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'cross-tool task', async: true, conversation_id: convId }, 601);
      const ctfJobId = textOf(ctfContinue).match(UUID_RE)?.[0];
      ok('cross-tool: code_task_files continuation submitted', !!ctfJobId, textOf(ctfContinue));
      ok('cross-tool: no backend request before the job runs', backend.requests.length === 0, String(backend.requests.length));
      await pollUntilDone(baseUrl, sessionId, ctfJobId, { idBase: 11100 });

      ok('cross-tool: exactly one upstream request for this turn', backend.requests.length === 1, String(backend.requests.length));
      const req = backend.requests[0];
      const roles = (req?.messages ?? []).map((m) => m.role);
      ok(
        'cross-tool: upstream messages are [system, history-user, history-assistant, file-bundle-user, bundle-ack, manifest-user]',
        JSON.stringify(roles) === JSON.stringify(['system', 'user', 'assistant', 'user', 'assistant', 'user']),
        JSON.stringify(roles),
      );
      ok('cross-tool: history carries custom_prompt\'s turn-one instruction', req?.messages?.[1]?.content === 'cross-tool turn one', JSON.stringify(req?.messages?.[1]));
      const fileBundleContent = req?.messages?.[3]?.content ?? '';
      ok('cross-tool: the file bundle turn is present in what was actually sent to the model', fileBundleContent.startsWith('```unknown\n==='), fileBundleContent.slice(0, 120));
      ok('cross-tool: file bundle turn is followed by the bundle ack', req?.messages?.[4]?.content === 'Files received. Awaiting the task.', JSON.stringify(req?.messages?.[4]));
      ok('cross-tool: final user turn is the manifest + task, not the file bundle', /^\[files\]/.test(req?.messages?.[5]?.content ?? ''), JSON.stringify(req?.messages?.[5]));

      const { result: listAfterCtf } = await callConversations(baseUrl, sessionId, { action: 'list' }, 602);
      ok('cross-tool: conversation has 4 turns after both tools have contributed', convHasTurns(textOf(listAfterCtf), convId, 4), textOf(listAfterCtf));
    }

    // --- cross-tool continuation, direction 2: continuing with custom_prompt after code_task_files — the
    // file bundle from the code_task_files turn must NOT appear in history, only its manifest line ---
    {
      backend.reset();
      const { result: cpContinue } = await callCustomPrompt(baseUrl, ctfSessionId, { instruction: 'cross-tool turn three', max_tokens: 64, conversation_id: ctfConvId }, 603);
      ok('cross-tool (custom_prompt after code_task_files): not isError', cpContinue?.isError !== true, JSON.stringify(cpContinue));
      ok('cross-tool: exactly one upstream request', backend.requests.length === 1, String(backend.requests.length));
      const req = backend.requests[0];
      const historyContents = (req?.messages ?? []).slice(1, -1).map((m) => m.content).join('\n');
      ok('cross-tool: history sent to the model contains no code-fence or file-header markers — the file bundle itself was never recorded',
        !historyContents.includes('```') && !historyContents.includes('=== '), historyContents.slice(0, 300));
      ok('cross-tool: history does contain the manifest line from the code_task_files turn', /\[files\]/.test(historyContents), historyContents.slice(0, 300));
    }

    // --- D3, cross-tool: a code_task_files job held in flight blocks async/sync custom_prompt, sync chat,
    // and sync code_task_files against the same conversation ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result: startResult } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'd3b turn one', max_tokens: 64, async: true, start_conversation: true }, 610);
      const startJobId = textOf(startResult).match(UUID_RE)?.[0];
      const d3bConvId = [...textOf(startResult).matchAll(UUID_RE_G)].map((m) => m[0]).find((m) => m !== startJobId);
      await pollUntilDone(baseUrl, sessionId, startJobId, { idBase: 11200 });

      backend.setFirstChunkDelayMs(4000); // keep the code_task_files job running long enough to exercise D3
      backend.reset();
      const { result: blockerResult } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'blocker', async: true, conversation_id: d3bConvId }, 611);
      const blockerJobId = textOf(blockerResult).match(UUID_RE)?.[0];
      ok('D3 cross-tool setup: code_task_files blocker job submitted', !!blockerJobId, textOf(blockerResult));

      // Let the blocker job's own upstream request land before taking the
      // baseline below — code_task_files' fn() does a file read before its
      // chatCompletionStreaming() call, and that read is enough of an event
      // loop yield for the request to still be in flight right after submit
      // returns. Without this wait, one of the four blocked calls' own
      // (unrelated) file read could yield long enough for the blocker's
      // request to land AFTER the baseline is captured, false-failing this
      // check.
      await new Promise((r) => setTimeout(r, 300));
      const requestsBeforeD3b = backend.requests.length;
      const { result: d3bAsync } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'blocked', max_tokens: 64, async: true, conversation_id: d3bConvId }, 612);
      ok('D3 cross-tool: async custom_prompt against the same conversation is isError', d3bAsync?.isError === true, JSON.stringify(d3bAsync));
      const { result: d3bSync } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'blocked', max_tokens: 64, conversation_id: d3bConvId }, 613);
      ok('D3 cross-tool: sync custom_prompt against the same conversation is isError', d3bSync?.isError === true, JSON.stringify(d3bSync));
      const { result: d3bChat } = await callChat(baseUrl, sessionId, { message: 'blocked', max_tokens: 64, conversation_id: d3bConvId }, 614);
      ok('D3 cross-tool: sync chat against the same conversation is isError', d3bChat?.isError === true, JSON.stringify(d3bChat));
      const { result: d3bCtfSync } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'blocked', conversation_id: d3bConvId }, 615);
      ok('D3 cross-tool: sync code_task_files against the same conversation is isError', d3bCtfSync?.isError === true, JSON.stringify(d3bCtfSync));
      ok('D3 cross-tool: none of the four blocked calls reached the backend', backend.requests.length === requestsBeforeD3b, String(backend.requests.length));

      backend.setFirstChunkDelayMs(0);
      await pollUntilDone(baseUrl, sessionId, blockerJobId, { idBase: 11300 });
    }

    // --- regression: code_task_files async with no conversation params keeps its pre-15-1b shape ---
    {
      backend.reset();
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const { result: plainResult } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'plain regression', async: true }, 620);
      const plainSubmitText = textOf(plainResult);
      ok('regression (code_task_files async, no conversation): submitted, no "Started conversation" line', /submitted/i.test(plainSubmitText) && !/Started conversation/.test(plainSubmitText), plainSubmitText);
      const plainJobId = plainSubmitText.match(UUID_RE)?.[0];
      await pollUntilDone(baseUrl, sessionId, plainJobId, { idBase: 11400 });
      ok('regression (code_task_files async, no conversation): exactly one upstream request', backend.requests.length === 1, String(backend.requests.length));
      const plainReq = backend.requests[0];
      const plainRoles = (plainReq?.messages ?? []).map((m) => m.role);
      ok('regression (code_task_files async, no conversation): upstream messages are [system, user] only', JSON.stringify(plainRoles) === JSON.stringify(['system', 'user']), JSON.stringify(plainRoles));

      // Task 4/task 11 (plan-deep-check finding): estimatePrefill()'s input must stay combined.length for
      // the non-conversation case, so formatJobSubmitted()'s text (which embeds the estimate) must not
      // shift merely because conversation support now exists in the code path. Two identical calls with
      // no conversation params should produce the identical submitted-response shape, job id aside.
      backend.reset();
      const { result: plainResult2 } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'plain regression', async: true }, 621);
      const plainSubmitText2 = textOf(plainResult2);
      const stripJobId = (s) => s.replace(UUID_RE_G, '<job-id>');
      ok(
        'regression (code_task_files async, no conversation): repeated identical call produces the same submitted-response shape (job id aside)',
        stripJobId(plainSubmitText) === stripJobId(plainSubmitText2),
        `${plainSubmitText}\n---\n${plainSubmitText2}`,
      );
      const plainJobId2 = plainSubmitText2.match(UUID_RE)?.[0];
      await pollUntilDone(baseUrl, sessionId, plainJobId2, { idBase: 11500 });
    }

    // --- active job limit: HOUTINI_LM_JOB_ACTIVE_MAX_PER_OWNER (default 2) blocks a 3rd concurrent submission for the same owner ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.setFirstChunkDelayMs(4000); // keep jobs pending/running long enough to hit the limit
      backend.reset();
      const submittedIds = [];
      for (let i = 0; i < 2; i++) {
        const { result } = await callCustomPrompt(baseUrl, sessionId, { instruction: `limit test ${i}`, max_tokens: 64, async: true }, 200 + i);
        ok(`active limit: submit #${i} succeeds`, result?.isError !== true, JSON.stringify(result));
        const id = textOf(result).match(UUID_RE)?.[0];
        if (id) submittedIds.push(id);
      }
      const { result: overLimit } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'limit test 2', max_tokens: 64, async: true }, 202);
      ok('active limit: a 3rd concurrent submission for the same owner is isError', overLimit?.isError === true, JSON.stringify(overLimit));
      ok('active limit: error mentions the limit', /active|limit/i.test(textOf(overLimit)), textOf(overLimit));

      backend.setFirstChunkDelayMs(0);
      for (const id of submittedIds) {
        await pollUntilDone(baseUrl, sessionId, id, { idBase: 8000 + submittedIds.indexOf(id) * 100, maxAttempts: 80 });
      }
    }

    console.log(failed ? `\n${failed} FAILED so far\n` : '\nMain jobs e2e suite passed so far\n');
  } finally {
    child.kill();
    await backend.close();
  }

  // === Failed job: dedicated server against a backend whose /v1/chat/completions always errors ===
  console.log('\n=== Failed job E2E Test ===\n');
  {
    const errorBackend = await startErrorBackend();
    const port2 = await getFreePort();
    // A tiny inline ceiling: if chunking logic ever mistakenly applied to a
    // failed job's `error` field, this would surface it (the synthetic
    // error message below is well over 5 chars).
    const { child: child2, ready: ready2 } = startServer(errorBackend.url, port2, { HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS: '5' });
    const baseUrl2 = `http://127.0.0.1:${port2}`;
    try {
      await ready2;
      const { sessionId } = await initializeSession(baseUrl2, '/mcp');
      const { result: submitResult } = await callCustomPrompt(baseUrl2, sessionId, { instruction: 'this will fail', max_tokens: 64, async: true }, 2);
      const jobId = textOf(submitResult).match(UUID_RE)?.[0];
      ok('failed job: submitted despite the backend being broken (submission does not call the model)', !!jobId, textOf(submitResult));

      const { text } = await pollUntilDone(baseUrl2, sessionId, jobId, { idBase: 9000 });
      ok('failed job: reaches a terminal ❌ failed state', text.startsWith('❌'), text);
      ok('failed job: status mentions "failed"', /failed/i.test(text), text);
      // Phase 14-1: offset/limit and the inline ceiling only ever apply to
      // a completed job's `result` — a failed job's `error` is never
      // chunked, even with a ceiling (5 chars) far smaller than the error
      // text.
      ok('failed job: error text has no chunk footer despite a tiny inline ceiling', !text.includes('--- job result chunk:'), text);
      // offset/limit are also simply ignored (not an error) on a
      // non-completed job — same status line either way.
      const { result: pagedGetOnFailed } = await callJobs(baseUrl2, sessionId, { action: 'get', job_id: jobId, offset: 0, limit: 3 }, 9500);
      ok('failed job: offset/limit on a failed job is ignored, not isError', pagedGetOnFailed?.isError !== true, JSON.stringify(pagedGetOnFailed));
      ok('failed job: offset/limit on a failed job returns the same status text', textOf(pagedGetOnFailed) === text, textOf(pagedGetOnFailed));

      const { result: listResult } = await callJobs(baseUrl2, sessionId, { action: 'list' }, 3);
      ok('failed job: list reports state failed', new RegExp(`${jobId}[^\\n]*failed`).test(textOf(listResult)), textOf(listResult));

      // --- D4 (phase 15-1a): a failed async job does not append turns to its conversation ---
      const { result: d4Start } = await callCustomPrompt(baseUrl2, sessionId, { instruction: 'd4 will fail', max_tokens: 64, async: true, start_conversation: true }, 4);
      const d4JobId = textOf(d4Start).match(UUID_RE)?.[0];
      const d4ConvId = [...textOf(d4Start).matchAll(UUID_RE_G)].map((m) => m[0]).find((m) => m !== d4JobId);
      ok('D4 setup: job submitted against a broken backend, with a new conversation', !!d4JobId && !!d4ConvId, textOf(d4Start));
      const { text: d4Text } = await pollUntilDone(baseUrl2, sessionId, d4JobId, { idBase: 9600 });
      ok('D4: the job reaches a terminal failed state', d4Text.startsWith('❌'), d4Text);
      const { result: d4List } = await callConversations(baseUrl2, sessionId, { action: 'list' }, 5);
      ok('D4: the conversation still has 0 turns — the failed job did not append anything', convHasTurns(textOf(d4List), d4ConvId, 0), textOf(d4List));
    } finally {
      child2.kill();
      await errorBackend.close();
    }
  }

  // === maxResultChars truncation: dedicated server with a small HOUTINI_LM_JOB_MAX_RESULT_CHARS ===
  console.log('\n=== maxResultChars truncation E2E Test ===\n');
  {
    const TRUNCATE_AT = 30;
    const backend3 = await startFakeBackend();
    const port3 = await getFreePort();
    const { child: child3, ready: ready3 } = startServer(backend3.url, port3, { HOUTINI_LM_JOB_MAX_RESULT_CHARS: String(TRUNCATE_AT) });
    const baseUrl3 = `http://127.0.0.1:${port3}`;
    try {
      await ready3;
      const { sessionId } = await initializeSession(baseUrl3, '/mcp');
      const { result: submitResult } = await callCustomPrompt(baseUrl3, sessionId, { instruction: 'truncation test', max_tokens: 64, async: true }, 2);
      const jobId = textOf(submitResult).match(UUID_RE)?.[0];
      ok('truncation case: submitted', !!jobId, textOf(submitResult));

      const { text } = await pollUntilDone(baseUrl3, sessionId, jobId, { idBase: 10_000 });
      const expectedLength = TRUNCATE_AT + ' [truncated]'.length;
      ok('truncation: result ends with the [truncated] marker', text.endsWith(' [truncated]'), text);
      ok('truncation: result length is exactly maxResultChars + " [truncated]".length', text.length === expectedLength,
        `got length ${text.length}, want ${expectedLength} — text: ${text}`);
      ok('truncation: the kept prefix still starts with the real content', text.startsWith('Hello, this is fake.'), text);
    } finally {
      child3.kill();
      await backend3.close();
    }
  }

  // === Result chunking: dedicated server with a small HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS (phase 14-1) ===
  console.log('\n=== Result Chunking E2E Test ===\n');
  {
    // The fake backend's completed-job result (content + the "Model: ..." /
    // quota footer custom_prompt appends) is ~200 chars — comfortably over
    // this ceiling, so the very first `get` is forced to chunk without
    // needing a large fake response.
    const INLINE_MAX = 50;
    const backend5 = await startFakeBackend();
    const port5 = await getFreePort();
    const { child: child5, ready: ready5 } = startServer(backend5.url, port5, { HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS: String(INLINE_MAX) });
    const baseUrl5 = `http://127.0.0.1:${port5}`;
    try {
      await ready5;
      const { sessionId } = await initializeSession(baseUrl5, '/mcp');

      // Reference: the same instruction against a killswitched server
      // (ceiling 0, its own port and session) returns the full, unchunked
      // result to compare the reassembled chunked result against.
      let fullReference;
      const port5ref = await getFreePort();
      const { child: child5ref, ready: ready5ref } = startServer(backend5.url, port5ref, { HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS: '0' });
      const baseUrl5ref = `http://127.0.0.1:${port5ref}`;
      try {
        await ready5ref;
        const { sessionId: sessionIdRef } = await initializeSession(baseUrl5ref, '/mcp');
        const { result: refSubmit } = await callCustomPrompt(baseUrl5ref, sessionIdRef, { instruction: 'chunking test', max_tokens: 64, async: true }, 2);
        const refJobId = textOf(refSubmit).match(UUID_RE)?.[0];
        const { text: refText } = await pollUntilDone(baseUrl5ref, sessionIdRef, refJobId, { idBase: 11_000 });
        fullReference = refText;
      } finally {
        child5ref.kill();
      }

      const { result: submitResult } = await callCustomPrompt(baseUrl5, sessionId, { instruction: 'chunking test', max_tokens: 64, async: true }, 2);
      const jobId = textOf(submitResult).match(UUID_RE)?.[0];
      ok('chunking: submitted', !!jobId, textOf(submitResult));

      const { text: firstChunkText } = await pollUntilDone(baseUrl5, sessionId, jobId, { idBase: 12_000 });
      ok('chunking: reference result exceeds the inline ceiling (test is actually exercising chunking)', fullReference.length > INLINE_MAX, String(fullReference.length));
      ok('chunking: first (no offset/limit) get is chunked — has a footer', firstChunkText.includes('--- job result chunk:'), firstChunkText);
      // reviewer nice-to-have: assert Next.limit on the first (limit-omitted)
      // call is the server's inline ceiling, not just "some value that
      // happens to make reassembly work" — limit<=0 also falls back to the
      // ceiling window in sliceResult, so an unasserted echoLimit bug here
      // (e.g. echoing 0) would silently still round-trip correctly.
      {
        const m0 = firstChunkText.match(/Next: (\{.*\})/);
        ok('chunking: first chunk has a Next object to check', !!m0, firstChunkText);
        if (m0) {
          const next0 = JSON.parse(m0[1]);
          ok('chunking: omitted-limit first call echoes the inline ceiling as Next.limit', next0.limit === INLINE_MAX,
            `Next.limit=${next0.limit}, want ${INLINE_MAX}`);
        }
      }

      // Walk the chunk chain via the footer's `Next`, reassembling the body
      // per the extraction contract: the first (end - start) characters of
      // the response text are the chunk body, the rest is footer.
      let reassembled = '';
      let current = firstChunkText;
      let hops = 0;
      const MAX_HOPS = 20;
      for (; hops < MAX_HOPS; hops++) {
        const m = current.match(/--- job result chunk: chars (\d+)-(\d+) of (\d+)/);
        ok(`chunking: hop ${hops} footer is parseable`, !!m, current);
        if (!m) break;
        const [, startStr, endStr] = m;
        const bodyLen = Number(endStr) - Number(startStr);
        reassembled += current.slice(0, bodyLen);
        const isFinal = / \(end-exclusive, end of result\) ---$/.test(current) || current.trimEnd().endsWith('(end-exclusive, end of result) ---');
        if (isFinal) {
          ok('chunking: final chunk footer has no Next line', !current.includes('Next:'), current);
          break;
        }
        const nextMatch = current.match(/Next: (\{.*\})/);
        ok(`chunking: hop ${hops} has a Next object`, !!nextMatch, current);
        if (!nextMatch) break;
        const next = JSON.parse(nextMatch[1]);
        const { result: nextResult } = await callJobs(baseUrl5, sessionId, { action: 'get', job_id: jobId, offset: next.offset, limit: next.limit }, 13_000 + hops);
        current = textOf(nextResult);
      }
      ok('chunking: reassembled from Next-driven paging terminated within MAX_HOPS', hops < MAX_HOPS, String(hops));
      // The two jobs are separate calls (chunked vs. reference), so their
      // "TTFT: Nms" footer digits legitimately differ between runs — same
      // rationale as contentPortion() above. Normalize that one
      // non-deterministic span before comparing; this is a fidelity check
      // on the chunking/reassembly mechanism, not on backend determinism,
      // so (unlike contentPortion) the rest of the footer stays in the
      // comparison.
      const normalizeTtft = (s) => s.replace(/TTFT: \d+ms/, 'TTFT: Xms');
      ok('chunking: reassembled chunked result matches the unchunked reference exactly (modulo per-call TTFT)',
        normalizeTtft(reassembled) === normalizeTtft(fullReference),
        JSON.stringify({ reassembledLen: reassembled.length, referenceLen: fullReference.length, reassembled, fullReference }));

      // `jobs list`'s `chars` column reflects the completed job's full
      // (unchunked) result length, independent of the inline ceiling.
      const { result: listResult } = await callJobs(baseUrl5, sessionId, { action: 'list' }, 14_000);
      ok('chunking: list chars column shows the full result length, not the ceiling',
        new RegExp(`${jobId}[^\\n]*\\| ${fullReference.length} \\|`).test(textOf(listResult)), textOf(listResult));

      console.log(failed ? `\n${failed} FAILED so far\n` : '\nResult chunking e2e tests passed so far\n');
    } finally {
      child5.kill();
      await backend5.close();
    }
  }

  // === Kill switch: HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS=0 disables auto-chunking, but explicit offset/limit still work (D4) ===
  console.log('\n=== Chunking Kill Switch E2E Test ===\n');
  {
    const backend6 = await startFakeBackend();
    const port6 = await getFreePort();
    const { child: child6, ready: ready6 } = startServer(backend6.url, port6, { HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS: '0' });
    const baseUrl6 = `http://127.0.0.1:${port6}`;
    try {
      await ready6;
      const { sessionId } = await initializeSession(baseUrl6, '/mcp');

      const { result: submitResult } = await callCustomPrompt(baseUrl6, sessionId, { instruction: 'kill switch test', max_tokens: 64, async: true }, 2);
      const jobId = textOf(submitResult).match(UUID_RE)?.[0];
      ok('kill switch: submitted', !!jobId, textOf(submitResult));

      const { text: plainText } = await pollUntilDone(baseUrl6, sessionId, jobId, { idBase: 15_000 });
      ok('kill switch: plain get (no offset/limit) is not chunked despite exceeding what would otherwise be the default ceiling',
        !plainText.includes('--- job result chunk:'), plainText);

      // D4: an explicit offset/limit is still honoured even with the kill
      // switch on — `=0` only turns off *automatic* chunking.
      const { result: pagedResult } = await callJobs(baseUrl6, sessionId, { action: 'get', job_id: jobId, offset: 0, limit: 5 }, 15_100);
      const pagedText = textOf(pagedResult);
      ok('kill switch: explicit offset/limit still chunks the response (D4)', pagedText.includes('--- job result chunk:'), pagedText);
      ok('kill switch: explicit-paged chunk body is exactly the requested 5 chars', pagedText.startsWith(plainText.slice(0, 5)), pagedText);

      console.log(failed ? `\n${failed} FAILED so far\n` : '\nChunking kill switch e2e tests passed so far\n');
    } finally {
      child6.kill();
      await backend6.close();
    }
  }

  // === HOUTINI_LM_JOBS=0: the feature is fully hidden and disabled ===
  console.log('\n=== HOUTINI_LM_JOBS=0 E2E Tests ===\n');
  {
    const backend4 = await startFakeBackend();
    const port4 = await getFreePort();
    const { child: child4, ready: ready4 } = startServer(backend4.url, port4, { HOUTINI_LM_JOBS: '0' });
    const baseUrl4 = `http://127.0.0.1:${port4}`;
    try {
      await ready4;
      const { sessionId } = await initializeSession(baseUrl4, '/mcp');

      const list = await toolsList(baseUrl4, sessionId, 2);
      const toolNames = (list?.tools ?? []).map((t) => t.name);
      ok('jobs=0: tools/list does not include the jobs tool', !toolNames.includes('jobs'), JSON.stringify(toolNames));
      const cpProps = (list?.tools ?? []).find((t) => t.name === 'custom_prompt')?.inputSchema?.properties ?? {};
      const ctfProps = (list?.tools ?? []).find((t) => t.name === 'code_task_files')?.inputSchema?.properties ?? {};
      ok('jobs=0: custom_prompt.inputSchema.properties has no async', !('async' in cpProps), JSON.stringify(Object.keys(cpProps)));
      ok('jobs=0: code_task_files.inputSchema.properties has no async', !('async' in ctfProps), JSON.stringify(Object.keys(ctfProps)));

      backend4.reset();
      const { result: cpAsyncResult } = await callCustomPrompt(baseUrl4, sessionId, { instruction: 'nope', max_tokens: 64, async: true }, 3);
      ok('jobs=0: custom_prompt with async:true is isError', cpAsyncResult?.isError === true, JSON.stringify(cpAsyncResult));
      ok('jobs=0: no backend request from the rejected async call', backend4.requests.length === 0, String(backend4.requests.length));

      backend4.reset();
      const { result: cpNormalResult } = await callCustomPrompt(baseUrl4, sessionId, { instruction: 'hi', max_tokens: 64 }, 4);
      ok('jobs=0: custom_prompt without async succeeds normally', cpNormalResult?.isError !== true, JSON.stringify(cpNormalResult));

      const { result: jobsCallResult } = await callJobs(baseUrl4, sessionId, { action: 'list' }, 5);
      ok('jobs=0: calling the (unlisted) jobs tool directly is isError', jobsCallResult?.isError === true, JSON.stringify(jobsCallResult));

      console.log(failed ? `\n${failed} FAILED\n` : '\nAll HOUTINI_LM_JOBS=0 e2e tests passed\n');
    } finally {
      child4.kill();
      await backend4.close();
    }
  }

  console.log(failed ? `\n${failed} FAILED\n` : '\nAll async jobs e2e tests passed\n');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
