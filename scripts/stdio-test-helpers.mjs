/**
 * Shared stdio test plumbing: spawning dist/index.js with the (default)
 * stdio transport, newline-delimited JSON-RPC framing, and the MCP
 * handshake (initialize -> notifications/initialized). The protocol layer
 * here is lifted from scripts/test-progress-notifications.mjs's runSession()
 * rather than reinvented, per this repo's existing stdio conventions.
 * Mirrors http-test-helpers.mjs's separation of concerns: this module only
 * owns the transport mechanics, not test-output formatting. Unlike
 * test-progress-notifications.mjs (one process per session), startStdioServer()
 * returns a single long-lived rpc()/notification() pair so a whole test
 * suite can share one process — needed here because the fixed stdio-local
 * owner key is process-wide, and proving that owner sharing works requires
 * making several calls against the same process.
 * scripts/test-mcp-e2e.mjs is a separate, non-modular smoke test against
 * real providers and is neither reused nor modified here.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Spawns dist/index.js with the stdio transport against a fake backend. extraEnv overrides/adds env vars. */
export function startStdioServer(backendUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js')], {
    env: { ...process.env, HOUTINI_LM_ENDPOINT_URL: backendUrl, HOUTINI_LM_TRANSPORT: 'stdio', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Startup model-profiling and any other server logging land on stderr; an
  // unconsumed pipe fills its OS buffer and blocks the child. This single
  // listener both drains stderr for the process's whole lifetime and (once)
  // resolves `ready` off the same data, exactly as http-test-helpers.mjs's
  // startServer() does for the http transport.
  let stderrBuf = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not print startup line in time')), 15_000);
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.includes('Houtini LM server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}. stderr:\n${stderrBuf}`));
    });
  });

  let buf = '';
  let nextId = 1;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Non-JSON-RPC stdout output would indicate framing corruption
        // upstream; ignored here rather than crashing the test, matching
        // test-progress-notifications.mjs's convention.
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  /** Sends a JSON-RPC request and resolves with its `result` (rejects on `error`). */
  function rpc(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc ${method} (id ${id}) timed out after 30s`));
      }, 30_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  /** Sends a JSON-RPC notification (no id, no response expected). */
  function notification(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  return { child, ready, rpc, notification, close: () => child.kill() };
}

/** Runs the MCP handshake: initialize, then notifications/initialized. */
export async function initializeStdioSession(rpc, notification) {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'stdio-test', version: '0.1.0' },
  });
  notification('notifications/initialized', {});
}
