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

async function toolsList(baseUrl, sessionId, id) {
  const res = await post(baseUrl, '/mcp', { jsonrpc: '2.0', id, method: 'tools/list', params: {} }, sessionId);
  return res.messages.find((m) => m.id === id)?.result;
}

function textOf(result) {
  return result?.content?.[0]?.text ?? '';
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

    // --- async: true together with start_conversation or conversation_id is rejected, with the "not currently supported" framing ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result: withStart } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'nope', max_tokens: 64, async: true, start_conversation: true }, 2);
      ok('async + start_conversation: isError', withStart?.isError === true, JSON.stringify(withStart));
      ok('async + start_conversation: no request reached the backend', backend.requests.length === 0, String(backend.requests.length));
      const text = textOf(withStart);
      ok('async + start_conversation: framed as a scope limit, not "technically incompatible"', !/technically incompatible/i.test(text), text);

      backend.reset();
      const { result: withConvId } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'nope', max_tokens: 64, async: true, conversation_id: '00000000-0000-0000-0000-000000000000' }, 3);
      ok('async + conversation_id: isError', withConvId?.isError === true, JSON.stringify(withConvId));
      ok('async + conversation_id: no request reached the backend', backend.requests.length === 0, String(backend.requests.length));
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
    const { child: child2, ready: ready2 } = startServer(errorBackend.url, port2);
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

      const { result: listResult } = await callJobs(baseUrl2, sessionId, { action: 'list' }, 3);
      ok('failed job: list reports state failed', new RegExp(`${jobId}[^\\n]*failed`).test(textOf(listResult)), textOf(listResult));
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
