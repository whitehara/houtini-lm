#!/usr/bin/env node
/**
 * End-to-end test for server-side conversation history over the stdio
 * transport (phase 9, phase 3-C2). HTTP always has an MCP session id, so
 * test-conversations-e2e.mjs never exercises the HOUTINI_LM_TRANSPORT ===
 * 'stdio' branch in resolveConversation() (fixed owner key 'stdio-local').
 * If that branch breaks, only stdio clients (e.g. Claude Desktop) would
 * fail — silently, since nothing else covers it. This file proves the
 * fixed-key branch actually works: a conversation started over stdio
 * continuing successfully IS the proof, since stdio never carries a
 * session id for it to fall back to.
 *
 * All cases run against ONE shared child process/session — the fixed
 * 'stdio-local' owner key is process-wide, not per-call, so sharing one
 * process across chat and custom_prompt calls is what actually
 * demonstrates owner sharing (case 6) while distinct conversation ids
 * under that owner stay isolated (case 7). Cases therefore run in a fixed
 * order: open a conversation, continue it, continue it from the other
 * tool, then open an unrelated second conversation and check for leakage.
 *
 * Output format matches phase 1's scripts/test-conversation-store.mjs:
 * `PASS  <name>` / `FAIL  <name>`, no colon, two spaces.
 *
 * Usage: node scripts/test-conversations-stdio-e2e.mjs
 */
import { startFakeBackend } from './fake-openai-backend.mjs';
import { startStdioServer, initializeStdioSession } from './stdio-test-helpers.mjs';

let failed = 0;
function ok(name, cond, detail) {
  const pass = !!cond;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ` — ${detail}` : ''}\n`);
  if (!pass) failed++;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function textOf(result) {
  return result?.content?.[0]?.text ?? '';
}

async function main() {
  const backend = await startFakeBackend();
  const { ready, rpc, notification, close } = startStdioServer(backend.url);

  /** Calls a delegation tool over the shared stdio session. */
  async function callTool(name, args) {
    return { result: await rpc('tools/call', { name, arguments: args }) };
  }

  try {
    await ready;
    await initializeStdioSession(rpc, notification);

    console.log('\n=== stdio Conversation E2E Tests (phase 9, phase 3-C2) ===\n');

    // --- 1/2/3: start_conversation over stdio must not hit the "needs an MCP session" error, must return a UUID id, and must not inflate the opening turn's message count ---
    backend.reset();
    const first = await callTool('chat', { message: 'first turn', max_tokens: 64, start_conversation: true });
    const firstText = textOf(first.result);
    ok('stdio: start_conversation is not a "needs an MCP session" error', first.result?.isError !== true && !firstText.includes('MCPセッションが必要です'), JSON.stringify(first.result));
    const firstMatch = firstText.match(UUID_RE);
    ok('stdio: start_conversation response contains a UUID-shaped conversation id', !!firstMatch, firstText);
    const conversationId = firstMatch?.[0];
    ok('stdio: start_conversation backend received exactly 2 messages', backend.requests.at(-1)?.messages?.length === 2, JSON.stringify(backend.requests.at(-1)?.messages));

    // --- 4/5: continuing via conversation_id threads history back in ---
    backend.reset();
    await callTool('chat', { message: 'second turn', max_tokens: 64, conversation_id: conversationId });
    const sentMessages = backend.requests.at(-1)?.messages ?? [];
    ok('stdio: conversation_id continuation backend received exactly 4 messages', sentMessages.length === 4, JSON.stringify(sentMessages));
    ok('stdio: continuation messages[1].content is the first turn\'s user message', sentMessages[1]?.content === 'first turn', JSON.stringify(sentMessages[1]));

    // --- 6: custom_prompt can continue a conversation chat opened (fixed-key sharing across tools) ---
    backend.reset();
    const cpContinue = await callTool('custom_prompt', { instruction: 'continue via custom_prompt', max_tokens: 64, conversation_id: conversationId });
    ok('stdio: custom_prompt continues a chat-opened conversation (fixed owner key shared across tools)', cpContinue.result?.isError !== true, JSON.stringify(cpContinue.result));
    const cpSent = backend.requests.at(-1)?.messages ?? [];
    ok('stdio: custom_prompt continuation backend saw the first turn\'s content in history', cpSent.some((m) => m.content === 'first turn'), JSON.stringify(cpSent));

    // --- 7: a second, independent conversation on the same fixed owner does not leak the first conversation's history ---
    backend.reset();
    await callTool('chat', { message: 'unrelated turn', max_tokens: 64, start_conversation: true });
    const otherSent = backend.requests.at(-1)?.messages ?? [];
    ok('stdio: a second conversation on the same owner opens with exactly 2 messages (independent history)', otherSent.length === 2, JSON.stringify(otherSent));
    ok('stdio: a second conversation does not leak the first conversation\'s content', !otherSent.some((m) => m.content === 'first turn'), JSON.stringify(otherSent));

    // --- 8: nonexistent conversation_id never reaches the backend ---
    backend.reset();
    const missing = await callTool('chat', { message: 'hi', max_tokens: 64, conversation_id: '00000000-0000-0000-0000-000000000000' });
    ok('stdio: nonexistent conversation_id is isError', missing.result?.isError === true, JSON.stringify(missing.result));
    ok('stdio: nonexistent conversation_id backend received no request', backend.requests.length === 0, String(backend.requests.length));

    console.log(`\n=== Results: ${failed === 0 ? 'all stdio conversation e2e tests passed' : `${failed} FAILED`} ===\n`);
  } finally {
    close();
    await backend.close();
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
