#!/usr/bin/env node
/**
 * Verifies the Streamable HTTP transport (phase 2b): session lifecycle,
 * tools/list, tools/call with progress notifications routed to the correct
 * session, concurrent-session isolation, DELETE, and /healthz. Backend-free
 * — uses fake-openai-backend.mjs so this runs without a real LLM.
 *
 * Usage: node scripts/test-http-transport.mjs
 */
import { startFakeBackend } from './fake-openai-backend.mjs';
import { getFreePort, startServer, post, initializeSession } from './http-test-helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

/** Runs one full session: initialize -> initialized -> tools/call(progressToken), returns collected messages. */
async function runOneSession(baseUrl, progressToken) {
  const { sessionId, initMessages } = await initializeSession(baseUrl, '/mcp');

  const callRes = await post(baseUrl, '/mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'chat', arguments: { message: 'hi', max_tokens: 64 }, _meta: { progressToken } },
  }, sessionId);

  return { sessionId, initMessages, callMessages: callRes.messages };
}

async function main() {
  const backend = await startFakeBackend();
  const port = await getFreePort();
  const { child, ready } = startServer(backend.url, port);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await ready;
    console.log('\n=== HTTP Transport Tests (phase 2b) ===\n');

    // --- /healthz ---
    const health = await fetch(`${baseUrl}/healthz`);
    check('/healthz returns 200', health.status === 200, `got ${health.status}`);

    // --- GET on the MCP path is rejected (this server does not offer standalone SSE) ---
    const getRes = await fetch(`${baseUrl}/mcp`, { headers: { Accept: 'text/event-stream' } });
    check('GET /mcp is rejected with a client error', getRes.status >= 400 && getRes.status < 500,
      `got ${getRes.status}`);
    await getRes.text().catch(() => {});

    // --- Single session: initialize, tools/list, tools/call with progress ---
    const tokenA = 'http-token-A-' + Date.now();
    const single = await runOneSession(baseUrl, tokenA);
    check('initialize returns a session id', !!single.sessionId);
    check('initialize response has a result', single.initMessages.some((m) => m.id === 1 && m.result));

    const listRes = await post(baseUrl, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, single.sessionId);
    const listResult = listRes.messages.find((m) => m.id === 3)?.result;
    const toolNames = (listResult?.tools ?? []).map((t) => t.name);
    check('tools/list includes all 4 delegation tools', ['chat', 'custom_prompt', 'code_task', 'code_task_files'].every((n) => toolNames.includes(n)),
      `got: ${toolNames.join(', ')}`);

    const progressA = single.callMessages.filter((m) => m.method === 'notifications/progress');
    check('tools/call over HTTP produced at least one progress notification', progressA.length > 0);
    check('progress notification carries the token this session sent', progressA.every((m) => m.params.progressToken === tokenA),
      progressA.length ? JSON.stringify(progressA.map((m) => m.params.progressToken)) : 'no notifications received');

    // --- DELETE ends the session; a follow-up request with the same id is rejected ---
    const delRes = await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': single.sessionId } });
    check('DELETE on an active session succeeds', delRes.status >= 200 && delRes.status < 300, `got ${delRes.status}`);
    await delRes.text().catch(() => {});

    const afterDelete = await post(baseUrl, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, single.sessionId);
    check('re-using a deleted session id is rejected', afterDelete.status === 404, `got ${afterDelete.status}`);

    // --- Concurrency: two independent sessions in the SAME process must not cross-talk ---
    const tokenB = 'http-token-B-' + Date.now();
    const tokenC = 'http-token-C-' + Date.now();
    const [sessB, sessC] = await Promise.all([
      runOneSession(baseUrl, tokenB),
      runOneSession(baseUrl, tokenC),
    ]);
    const progressB = sessB.callMessages.filter((m) => m.method === 'notifications/progress');
    const progressC = sessC.callMessages.filter((m) => m.method === 'notifications/progress');
    check('concurrent session B received only its own progress token',
      progressB.length > 0 && progressB.every((m) => m.params.progressToken === tokenB));
    check('concurrent session C received only its own progress token',
      progressC.length > 0 && progressC.every((m) => m.params.progressToken === tokenC));
    check('two concurrent sessions were issued distinct session ids', sessB.sessionId !== sessC.sessionId);

    // === HTTP session idle TTL tests ===
    // Spawn a dedicated server with TTL = 0.03 min (1800 ms) so existing tests
    // are never affected by the setting.
    console.log('\n=== HTTP Session TTL Tests ===\n');

    const ttlBackend = await startFakeBackend();
    const ttlPort = await getFreePort();
    const { child: ttlChild, ready: ttlReady } = startServer(ttlBackend.url, ttlPort, {
      HOUTINI_LM_HTTP_SESSION_TTL_MIN: '0.03',
    });
    const ttlBaseUrl = `http://127.0.0.1:${ttlPort}`;
    await ttlReady;

    try {

      // 1. Session used inside the TTL window survives
      {
        const { sessionId } = await initializeSession(ttlBaseUrl, '/mcp');
        await sleep(600);
        const res = await post(ttlBaseUrl, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
        check('session used inside the TTL window survives', res.status === 200, `got ${res.status}`);
      }

      // 2. Idle session past the TTL is reaped (404 on next use)
      {
        const { sessionId } = await initializeSession(ttlBaseUrl, '/mcp');
        await sleep(2500);
        const res = await post(ttlBaseUrl, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
        check('idle session past the TTL is reaped (404 on next use)', res.status === 404, `got ${res.status}`);
      }

      // 3. An in-flight request is not reaped mid-call
      {
        // Reset the dedicated backend's delay to 3000ms so the call takes long enough
        ttlBackend.setFirstChunkDelayMs(3000);
        const { sessionId: sidA } = await initializeSession(ttlBaseUrl, '/mcp');
        // Fire a tools/call but don't await yet (use a promise so we can let it run)
        const callPromise = post(ttlBaseUrl, '/mcp', {
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'chat', arguments: { message: 'hi', max_tokens: 64 } },
        }, sidA);
        await sleep(2500);
        // The reaping trigger — session B's request will call reapIdleSessions
        const { sessionId: sidB } = await initializeSession(ttlBaseUrl, '/mcp');
        const callRes = await callPromise;
        check('an in-flight request is not reaped mid-call', callRes.status === 200, `got ${callRes.status}`);
        ttlBackend.setFirstChunkDelayMs(0);
      }

      // 4. A session owning a running async job is not reaped
      {
        ttlBackend.setFirstChunkDelayMs(3000);
        const { sessionId } = await initializeSession(ttlBaseUrl, '/mcp');
        // Submit an async job by calling custom_prompt with async: true
        const jobRes = await post(ttlBaseUrl, '/mcp', {
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'custom_prompt', arguments: { instruction: 'test', async: true } },
        }, sessionId);
        await sleep(2500);
        // Calling tools/list on the same session should still work (session NOT reaped)
        const listRes = await post(ttlBaseUrl, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, sessionId);
        check('a session owning a running async job is not reaped', listRes.status === 200, `got ${listRes.status}`);
        ttlBackend.setFirstChunkDelayMs(0);
      }

    } finally {
      ttlChild.kill();
      await ttlBackend.close();
    }

    // 5. Default config (TTL unset) never reaps an idle session
    // Uses the original (main) server instance which has no TTL set.
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      await sleep(2500);
      const res = await post(baseUrl, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
      check('default config (TTL unset) never reaps an idle session', res.status === 200, `got ${res.status}`);
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  } finally {
    child.kill();
    await backend.close();
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
