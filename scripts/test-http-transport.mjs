#!/usr/bin/env node
/**
 * Verifies the Streamable HTTP transport (phase 2b): session lifecycle,
 * tools/list, tools/call with progress notifications routed to the correct
 * session, concurrent-session isolation, DELETE, and /healthz. Backend-free
 * — uses fake-openai-backend.mjs so this runs without a real LLM.
 *
 * Usage: node scripts/test-http-transport.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeBackend } from './fake-openai-backend.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** Grab an OS-assigned free port without racing the server we're about to spawn. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startServer(backendUrl, port) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js')], {
    env: {
      ...process.env,
      HOUTINI_LM_ENDPOINT_URL: backendUrl,
      HOUTINI_LM_TRANSPORT: 'http',
      HOUTINI_LM_HTTP_HOST: '127.0.0.1',
      HOUTINI_LM_HTTP_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const ready = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not print startup line in time')), 15_000);
    child.stderr.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('Houtini LM server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}. stderr:\n${buf}`));
    });
  });

  return { child, ready };
}

/** Parses an SSE (or plain JSON) response body into the JSON-RPC messages it carries. */
function parseSseOrJson(text, contentType) {
  if (contentType && contentType.includes('text/event-stream')) {
    const messages = [];
    for (const block of text.split('\n\n')) {
      const dataLines = block.split('\n').filter((l) => l.startsWith('data:'));
      if (dataLines.length === 0) continue;
      const data = dataLines.map((l) => l.slice(5).trim()).join('\n');
      try {
        messages.push(JSON.parse(data));
      } catch { /* ignore non-JSON SSE lines */ }
    }
    return messages;
  }
  try {
    return [JSON.parse(text)];
  } catch {
    return [];
  }
}

async function post(baseUrl, path_, body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${baseUrl}${path_}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  const messages = parseSseOrJson(text, res.headers.get('content-type'));
  return { status: res.status, headers: res.headers, messages };
}

/** Runs one full session: initialize -> initialized -> tools/call(progressToken), returns collected messages. */
async function runOneSession(baseUrl, progressToken) {
  const initRes = await post(baseUrl, '/mcp', {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http-test', version: '0.1.0' } },
  });
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('no mcp-session-id header on initialize response');

  // Fire-and-forget per JSON-RPC notification semantics (no id, no response expected).
  await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  });

  const callRes = await post(baseUrl, '/mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'chat', arguments: { message: 'hi', max_tokens: 64 }, _meta: { progressToken } },
  }, sessionId);

  return { sessionId, initMessages: initRes.messages, callMessages: callRes.messages };
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
