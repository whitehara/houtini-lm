#!/usr/bin/env node
/**
 * Verifies notifications/progress is request-scoped and byte-shape-identical
 * to before the sendNotification plumbing was introduced (phase 2a).
 * Backend-free — uses fake-openai-backend.mjs so this runs in CI without a
 * real LLM.
 *
 * Usage: node scripts/test-progress-notifications.mjs
 */
import { spawn } from 'node:child_process';
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

/**
 * Spawns one houtini-lm process over stdio, sends initialize + a chat
 * tools/call with the given progressToken, and collects every message
 * (notifications and responses alike) seen on stdout.
 */
function runSession(backendUrl, progressToken) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'index.js')], {
      env: { ...process.env, HOUTINI_LM_ENDPOINT_URL: backendUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const messages = [];
    let buf = '';
    let nextId = 1;
    const pending = new Map();
    let toolCallDone = false;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`session for token ${progressToken} timed out`));
    }, 60_000);

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
          continue;
        }
        messages.push(msg);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(JSON.stringify(msg.error)));
          else res(msg.result);
        }
      }
    });

    child.stderr.on('data', () => { /* ignore server logs for this test */ });

    function rpc(method, params) {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
    function notification(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    (async () => {
      try {
        await rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'progress-test', version: '0.1.0' },
        });
        notification('notifications/initialized', {});
        await rpc('tools/call', {
          name: 'chat',
          arguments: { message: 'hi', max_tokens: 64 },
          _meta: { progressToken },
        });
        toolCallDone = true;
        clearTimeout(timer);
        child.kill();
        resolve(messages);
      } catch (err) {
        clearTimeout(timer);
        child.kill();
        if (!toolCallDone) reject(err);
      }
    })();
  });
}

async function main() {
  const backend = await startFakeBackend();
  try {
    console.log('\n=== Progress Notification Tests (phase 2a) ===\n');

    // --- Single session: shape + routing ---
    const tokenA = 'token-A-' + Date.now();
    const messagesA = await runSession(backend.url, tokenA);
    const progressMsgsA = messagesA.filter((m) => m.method === 'notifications/progress');

    check('at least one progress notification received', progressMsgsA.length > 0,
      `got ${progressMsgsA.length}`);

    if (progressMsgsA.length > 0) {
      const allTopLevelKeysOk = progressMsgsA.every((m) =>
        JSON.stringify(Object.keys(m).sort()) === JSON.stringify(['jsonrpc', 'method', 'params']));
      check('top-level keys are exactly [jsonrpc, method, params]', allTopLevelKeysOk);

      const allParamKeysOk = progressMsgsA.every((m) =>
        JSON.stringify(Object.keys(m.params).sort()) === JSON.stringify(['message', 'progress', 'progressToken']));
      check('param keys are exactly [message, progress, progressToken] (no relatedRequestId leak)', allParamKeysOk);

      const allTokensMatch = progressMsgsA.every((m) => m.params.progressToken === tokenA);
      check('every notification carries the token this session sent', allTokensMatch,
        allTokensMatch ? undefined : JSON.stringify(progressMsgsA.map((m) => m.params.progressToken)));

      let monotonic = true;
      let prev = 0;
      for (const m of progressMsgsA) {
        if (m.params.progress <= prev) { monotonic = false; break; }
        prev = m.params.progress;
      }
      check('progress value is monotonically increasing', monotonic);
    }

    // --- Two concurrent independent processes: no cross-talk ---
    const tokenB = 'token-B-' + Date.now();
    const tokenC = 'token-C-' + Date.now();
    const [messagesB, messagesC] = await Promise.all([
      runSession(backend.url, tokenB),
      runSession(backend.url, tokenC),
    ]);
    const progressB = messagesB.filter((m) => m.method === 'notifications/progress');
    const progressC = messagesC.filter((m) => m.method === 'notifications/progress');

    check('session B received only its own token', progressB.length > 0 && progressB.every((m) => m.params.progressToken === tokenB));
    check('session C received only its own token', progressC.length > 0 && progressC.every((m) => m.params.progressToken === tokenC));

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  } finally {
    await backend.close();
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
