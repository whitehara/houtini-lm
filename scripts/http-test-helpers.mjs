/**
 * Shared Streamable HTTP test plumbing: spawning dist/index.js with the http
 * transport, SSE/JSON response parsing, and MCP session establishment
 * (initialize -> notifications/initialized -> Mcp-Session-Id extraction).
 * Extracted from test-http-transport.mjs (phase 2b) so test-conversations-e2e.mjs
 * (phase 9) reuses the exact same initialize payload shape and header name
 * instead of re-deriving them. Each test file keeps its own pass/fail printer —
 * this module only owns the transport mechanics, not test-output formatting.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Grab an OS-assigned free port without racing the server we're about to spawn. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Spawns dist/index.js with the http transport against a fake backend. extraEnv overrides/adds env vars. */
export function startServer(backendUrl, port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js')], {
    env: {
      ...process.env,
      HOUTINI_LM_ENDPOINT_URL: backendUrl,
      HOUTINI_LM_TRANSPORT: 'http',
      HOUTINI_LM_HTTP_HOST: '127.0.0.1',
      HOUTINI_LM_HTTP_PORT: String(port),
      ...extraEnv,
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
export function parseSseOrJson(text, contentType) {
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

export async function post(baseUrl, path_, body, sessionId) {
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

/** Establishes one MCP session: initialize -> notifications/initialized. Returns { sessionId, initMessages }. */
export async function initializeSession(baseUrl, path_ = '/mcp') {
  const initRes = await post(baseUrl, path_, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http-test', version: '0.1.0' } },
  });
  const sessionId = initRes.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('no mcp-session-id header on initialize response');

  // Fire-and-forget per JSON-RPC notification semantics (no id, no response expected).
  await fetch(`${baseUrl}${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  });

  return { sessionId, initMessages: initRes.messages };
}
