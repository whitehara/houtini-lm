#!/usr/bin/env node
/**
 * End-to-end test for server-side conversation history (phase 9, phase 2:
 * chat wiring). Spawns dist/index.js with HOUTINI_LM_TRANSPORT=http against
 * fake-openai-backend.mjs and drives it over real HTTP — the same transport
 * mechanics as test-http-transport.mjs (session establishment is imported
 * from http-test-helpers.mjs, not re-derived here).
 *
 * Output format matches phase 1's scripts/test-conversation-store.mjs:
 * `PASS  <name>` / `FAIL  <name>`, no colon, two spaces.
 *
 * Usage: node scripts/test-conversations-e2e.mjs
 */
import { startFakeBackend } from './fake-openai-backend.mjs';
import { getFreePort, startServer, post, initializeSession } from './http-test-helpers.mjs';

let failed = 0;
function ok(name, cond, detail) {
  const pass = !!cond;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ` — ${detail}` : ''}\n`);
  if (!pass) failed++;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Calls the `chat` tool over an established MCP HTTP session and returns its response text. */
async function callChat(baseUrl, sessionId, args, id) {
  const res = await post(baseUrl, '/mcp', {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'chat', arguments: args },
  }, sessionId);
  const result = res.messages.find((m) => m.id === id)?.result;
  return { httpStatus: res.status, result };
}

function textOf(result) {
  return result?.content?.[0]?.text ?? '';
}

async function main() {
  const backend = await startFakeBackend();
  const port = await getFreePort();
  const { child, ready } = startServer(backend.url, port);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await ready;
    console.log('\n=== Server-side Conversation E2E Tests (phase 9, phase 2) ===\n');

    // --- no conversation params: backend sees system+user only, no conversation line ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result } = await callChat(baseUrl, sessionId, { message: 'hi', max_tokens: 64 }, 2);
      ok('no params: backend received exactly 2 messages (system + user)', backend.requests.at(-1)?.messages?.length === 2,
        JSON.stringify(backend.requests.at(-1)?.messages));
      ok('no params: response text has no conversation line', !UUID_RE.test(textOf(result)) && !textOf(result).includes('Conversation'),
        textOf(result));
    }

    // --- start_conversation: true → response includes a UUID conversation id, backend still sees 2 messages ---
    let firstConversationId;
    let sessionIdA;
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      sessionIdA = sessionId;
      backend.reset();
      const { result } = await callChat(baseUrl, sessionId, { message: 'first turn', max_tokens: 64, start_conversation: true }, 2);
      const text = textOf(result);
      const match = text.match(UUID_RE);
      ok('start_conversation: response text contains a UUID-shaped conversation id', !!match, text);
      firstConversationId = match?.[0];
      ok('start_conversation: backend still received exactly 2 messages (system + user)', backend.requests.at(-1)?.messages?.length === 2,
        JSON.stringify(backend.requests.at(-1)?.messages));

      // --- second call with that conversation_id: backend sees 4 messages, history is threaded in correctly ---
      backend.reset();
      const second = await callChat(baseUrl, sessionId, { message: 'second turn', max_tokens: 64, conversation_id: firstConversationId }, 3);
      const sentMessages = backend.requests.at(-1)?.messages ?? [];
      ok('conversation_id continuation: backend received exactly 4 messages', sentMessages.length === 4, JSON.stringify(sentMessages));
      ok('conversation_id continuation: messages[1].content is the first turn\'s user message', sentMessages[1]?.content === 'first turn',
        JSON.stringify(sentMessages[1]));
      ok('conversation_id continuation: messages[2].role is assistant', sentMessages[2]?.role === 'assistant', JSON.stringify(sentMessages[2]));
      ok('conversation_id continuation: HTTP call succeeded', second.httpStatus === 200, String(second.httpStatus));
    }

    // --- cross-session access: conversation_id from session A must not be usable from session B ---
    {
      const { sessionId: sessionIdB } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result } = await callChat(baseUrl, sessionIdB, { message: 'intruding', max_tokens: 64, conversation_id: firstConversationId }, 2);
      ok('cross-session: accessing session A\'s conversation_id from session B is isError', result?.isError === true, JSON.stringify(result));
      const text = textOf(result);
      ok('cross-session: response contains no conversation content ("first turn"/"second turn")',
        !text.includes('first turn') && !text.includes('second turn') && !text.includes('fake.'), text);
      ok('cross-session: no request reached the backend', backend.requests.length === 0, String(backend.requests.length));
    }

    // --- nonexistent conversation_id: isError, no backend request ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result } = await callChat(baseUrl, sessionId, { message: 'hi', max_tokens: 64, conversation_id: '00000000-0000-0000-0000-000000000000' }, 2);
      ok('nonexistent conversation_id: isError', result?.isError === true, JSON.stringify(result));
      ok('nonexistent conversation_id: no request reached the backend', backend.requests.length === 0, String(backend.requests.length));
    }

    console.log(failed ? `\n${failed} FAILED\n` : '\nAll conversation e2e tests passed\n');
  } finally {
    child.kill();
    await backend.close();
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
