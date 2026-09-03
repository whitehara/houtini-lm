#!/usr/bin/env node
/**
 * End-to-end test for server-side conversation history (phase 9, phases
 * 2/3: chat and custom_prompt wiring). Spawns dist/index.js with
 * HOUTINI_LM_TRANSPORT=http against fake-openai-backend.mjs and drives it
 * over real HTTP — the same transport mechanics as test-http-transport.mjs
 * (session establishment is imported from http-test-helpers.mjs, not
 * re-derived here).
 *
 * Output format matches phase 1's scripts/test-conversation-store.mjs:
 * `PASS  <name>` / `FAIL  <name>`, no colon, two spaces.
 *
 * Usage: node scripts/test-conversations-e2e.mjs
 */
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

/** Calls any delegation tool over an established MCP HTTP session and returns its response. */
async function callTool(baseUrl, sessionId, toolName, args, id, extraHeaders = {}) {
  const res = await post(baseUrl, '/mcp', {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, sessionId, extraHeaders);
  const result = res.messages.find((m) => m.id === id)?.result;
  return { httpStatus: res.status, result };
}

/** Calls the `chat` tool. Thin wrapper over callTool() so the existing phase-2 assertions are untouched. */
async function callChat(baseUrl, sessionId, args, id, extraHeaders = {}) {
  return callTool(baseUrl, sessionId, 'chat', args, id, extraHeaders);
}

/** Calls the `custom_prompt` tool. */
async function callCustomPrompt(baseUrl, sessionId, args, id, extraHeaders = {}) {
  return callTool(baseUrl, sessionId, 'custom_prompt', args, id, extraHeaders);
}

/** Calls the `conversations` management tool (phase 9, phase 4). */
async function callConversations(baseUrl, sessionId, args, id, extraHeaders = {}) {
  return callTool(baseUrl, sessionId, 'conversations', args, id, extraHeaders);
}

/** Calls the `code_task_files` tool (phase 15-1b: conversation continuation). */
async function callCodeTaskFiles(baseUrl, sessionId, args, id, extraHeaders = {}) {
  return callTool(baseUrl, sessionId, 'code_task_files', args, id, extraHeaders);
}

/** True if `conversations list`'s markdown table shows exactly `n` turns for `convId` (mirrors test-jobs-e2e.mjs's convHasTurns). */
function convHasTurns(listText, convId, n) {
  return new RegExp(`\\|\\s*${convId}\\s*\\|\\s*${n}\\s*\\|`).test(listText);
}

/** Fetches tools/list and returns its result (the { tools: [...] } payload). */
async function toolsList(baseUrl, sessionId, id) {
  const res = await post(baseUrl, '/mcp', { jsonrpc: '2.0', id, method: 'tools/list', params: {} }, sessionId);
  return res.messages.find((m) => m.id === id)?.result;
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

    console.log('\n=== custom_prompt Conversation E2E Tests (phase 9, phase 3) ===\n');

    // --- no params + context: backend sees 4 messages (system/context-user/ack-assistant/instruction-user), no conversation line ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result } = await callCustomPrompt(baseUrl, sessionId, { context: 'file contents here', instruction: 'summarize', max_tokens: 64 }, 2);
      const sent = backend.requests.at(-1)?.messages ?? [];
      ok('custom_prompt no params + context: backend received exactly 4 messages', sent.length === 4, JSON.stringify(sent));
      ok('custom_prompt no params + context: response has no conversation line', !UUID_RE.test(textOf(result)) && !textOf(result).includes('Conversation'),
        textOf(result));
    }

    // --- no params, no context: backend sees 2 messages ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      await callCustomPrompt(baseUrl, sessionId, { instruction: 'summarize', max_tokens: 64 }, 2);
      const sent = backend.requests.at(-1)?.messages ?? [];
      ok('custom_prompt no params, no context: backend received exactly 2 messages', sent.length === 2, JSON.stringify(sent));
    }

    // --- start_conversation: true + context: response has a UUID id, backend still sees 4 messages ---
    let cpConversationId;
    let cpSessionId;
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      cpSessionId = sessionId;
      backend.reset();
      const { result } = await callCustomPrompt(baseUrl, sessionId,
        { context: 'file contents here', instruction: 'summarize', max_tokens: 64, start_conversation: true }, 2);
      const text = textOf(result);
      const match = text.match(UUID_RE);
      ok('custom_prompt start_conversation: response contains a UUID-shaped conversation id', !!match, text);
      cpConversationId = match?.[0];
      const sent = backend.requests.at(-1)?.messages ?? [];
      ok('custom_prompt start_conversation + context: backend received exactly 4 messages', sent.length === 4, JSON.stringify(sent));
    }

    // --- continuation with the identical context string: it must appear exactly once in the request ---
    {
      backend.reset();
      const contextText = 'file contents here';
      const { result } = await callCustomPrompt(baseUrl, cpSessionId,
        { context: contextText, instruction: 'refine', max_tokens: 64, conversation_id: cpConversationId }, 3);
      const sent = backend.requests.at(-1)?.messages ?? [];
      const occurrences = sent.filter((m) => typeof m.content === 'string' && m.content.includes(contextText)).length;
      ok('custom_prompt continuation with identical context: context string appears exactly once', occurrences === 1, JSON.stringify(sent));
      ok('custom_prompt continuation with identical context: HTTP call succeeded', result && result.isError !== true, JSON.stringify(result));
    }

    // --- continuation with a *different* context string: old and new each appear exactly once ---
    {
      backend.reset();
      const newContextText = 'updated file contents';
      await callCustomPrompt(baseUrl, cpSessionId,
        { context: newContextText, instruction: 'refine again', max_tokens: 64, conversation_id: cpConversationId }, 4);
      const sent = backend.requests.at(-1)?.messages ?? [];
      const oldOccurrences = sent.filter((m) => typeof m.content === 'string' && m.content.includes('file contents here')).length;
      const newOccurrences = sent.filter((m) => typeof m.content === 'string' && m.content.includes(newContextText)).length;
      ok('custom_prompt continuation with different context: old context string appears exactly once', oldOccurrences === 1, JSON.stringify(sent));
      ok('custom_prompt continuation with different context: new context string appears exactly once', newOccurrences === 1, JSON.stringify(sent));
    }

    // --- continuation with context omitted: the original context is still present exactly once, via history ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const contextText = 'omit-context-test file contents';
      const { result: firstResult } = await callCustomPrompt(baseUrl, sessionId,
        { context: contextText, instruction: 'first', max_tokens: 64, start_conversation: true }, 2);
      const id = textOf(firstResult).match(UUID_RE)?.[0];
      backend.reset();
      await callCustomPrompt(baseUrl, sessionId, { instruction: 'second, no context this time', max_tokens: 64, conversation_id: id }, 3);
      const sent = backend.requests.at(-1)?.messages ?? [];
      const occurrences = sent.filter((m) => typeof m.content === 'string' && m.content.includes(contextText)).length;
      ok('custom_prompt continuation with context omitted: original context still appears exactly once via history', occurrences === 1,
        JSON.stringify(sent));
      ok('custom_prompt continuation with context omitted: instruction is the last message', sent.at(-1)?.content === 'second, no context this time',
        JSON.stringify(sent.at(-1)));
    }

    // --- cross-tool continuation: a conversation started by chat can be continued by custom_prompt ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result: chatResult } = await callChat(baseUrl, sessionId, { message: 'chat first turn', max_tokens: 64, start_conversation: true }, 2);
      const id = textOf(chatResult).match(UUID_RE)?.[0];
      backend.reset();
      const { result: cpResult } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'continue via custom_prompt', max_tokens: 64, conversation_id: id }, 3);
      ok('cross-tool continuation: custom_prompt can continue a conversation started by chat', cpResult && cpResult.isError !== true, JSON.stringify(cpResult));
      const sent = backend.requests.at(-1)?.messages ?? [];
      const containsFirstTurn = sent.some((m) => typeof m.content === 'string' && m.content.includes('chat first turn'));
      ok('cross-tool continuation: backend request includes chat\'s first turn content', containsFirstTurn, JSON.stringify(sent));
    }

    // --- cross-session access via custom_prompt: another session's conversation_id must not be usable ---
    {
      const { sessionId: sessionIdB } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result } = await callCustomPrompt(baseUrl, sessionIdB, { instruction: 'intruding via custom_prompt', max_tokens: 64, conversation_id: cpConversationId }, 2);
      ok('custom_prompt cross-session: accessing another session\'s conversation_id is isError', result?.isError === true, JSON.stringify(result));
      const text = textOf(result);
      ok('custom_prompt cross-session: response contains no conversation content', !text.includes('file contents here') && !text.includes('fake.'), text);
      ok('custom_prompt cross-session: no request reached the backend', backend.requests.length === 0, String(backend.requests.length));
    }

    // --- nonexistent conversation_id via custom_prompt: isError, no backend request ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result } = await callCustomPrompt(baseUrl, sessionId, { instruction: 'hi', max_tokens: 64, conversation_id: '00000000-0000-0000-0000-000000000000' }, 2);
      ok('custom_prompt nonexistent conversation_id: isError', result?.isError === true, JSON.stringify(result));
      ok('custom_prompt nonexistent conversation_id: no request reached the backend', backend.requests.length === 0, String(backend.requests.length));
    }

    // --- tools/list exposes the conversation params on custom_prompt too ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const list = await toolsList(baseUrl, sessionId, 99);
      const customPrompt = (list?.tools ?? []).find((t) => t.name === 'custom_prompt');
      const props = customPrompt?.inputSchema?.properties ?? {};
      ok('tools/list: custom_prompt.inputSchema.properties has start_conversation', 'start_conversation' in props, JSON.stringify(Object.keys(props)));
      ok('tools/list: custom_prompt.inputSchema.properties has conversation_id', 'conversation_id' in props, JSON.stringify(Object.keys(props)));
      // Phase 15-1b: code_task_files gained the same two params.
      const codeTaskFiles = (list?.tools ?? []).find((t) => t.name === 'code_task_files');
      const ctfProps = codeTaskFiles?.inputSchema?.properties ?? {};
      ok('tools/list: code_task_files.inputSchema.properties has start_conversation', 'start_conversation' in ctfProps, JSON.stringify(Object.keys(ctfProps)));
      ok('tools/list: code_task_files.inputSchema.properties has conversation_id', 'conversation_id' in ctfProps, JSON.stringify(Object.keys(ctfProps)));
    }

    // === code_task_files conversation continuation (phase 15-1b) ===
    console.log('\n=== code_task_files Conversation E2E Tests (phase 15-1b) ===\n');

    // --- synchronous 2-turn continuation: turns accumulate, the conversation shows up in `conversations
    // list`, and the file bundle itself is never recorded — only manifest lines ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result: turn1 } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'sync turn one', start_conversation: true }, 2);
      ok('code_task_files sync conversation turn 1: not isError', turn1?.isError !== true, JSON.stringify(turn1));
      const ctfSyncConvId = textOf(turn1).match(UUID_RE)?.[0];
      ok('code_task_files sync conversation turn 1: started with a conversation id', !!ctfSyncConvId, textOf(turn1));

      backend.reset();
      const { result: turn2 } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'sync turn two', conversation_id: ctfSyncConvId }, 3);
      ok('code_task_files sync conversation turn 2: not isError', turn2?.isError !== true, JSON.stringify(turn2));
      const sent2 = backend.requests.at(-1)?.messages ?? [];
      const roles2 = sent2.map((m) => m.role);
      ok(
        'code_task_files sync conversation turn 2: upstream messages are [system, history-user, history-assistant, file-bundle-user, bundle-ack, manifest-user]',
        JSON.stringify(roles2) === JSON.stringify(['system', 'user', 'assistant', 'user', 'assistant', 'user']),
        JSON.stringify(roles2),
      );
      const historyTurns = sent2.slice(1, -3); // strip system + this turn's [file-bundle, ack, manifest]
      ok('code_task_files sync conversation turn 2: history has no code fence (the file bundle itself was never recorded)',
        !historyTurns.some((m) => m.content.includes('```')), JSON.stringify(historyTurns));
      ok('code_task_files sync conversation turn 2: history\'s stored turn one is the manifest line, not the file bundle',
        /^\[files\]/.test(historyTurns[0]?.content ?? ''), JSON.stringify(historyTurns[0]));

      const { result: listResult } = await callConversations(baseUrl, sessionId, { action: 'list' }, 4);
      const listText = textOf(listResult);
      ok('code_task_files sync conversation: appears in conversations list with 4 turns (2 per turn)', convHasTurns(listText, ctfSyncConvId, 4), listText);
    }

    // --- a file that fails to read is never named in the recorded manifest, only the readable one is ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const missingPath = '/nonexistent/path/does-not-exist-phase15-1b.ts';
      const { result: turn1 } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile, missingPath], task: 'manifest turn one', start_conversation: true }, 5);
      ok('code_task_files with one unreadable path: not isError (one readable file is enough)', turn1?.isError !== true, JSON.stringify(turn1));
      const manifestConvId = textOf(turn1).match(UUID_RE)?.[0];
      ok('manifest setup: conversation started', !!manifestConvId, textOf(turn1));

      backend.reset();
      const { result: turn2 } = await callCodeTaskFiles(baseUrl, sessionId, { paths: [thisFile], task: 'manifest turn two', conversation_id: manifestConvId }, 6);
      ok('manifest turn two: not isError', turn2?.isError !== true, JSON.stringify(turn2));
      const sent = backend.requests.at(-1)?.messages ?? [];
      const historyManifest = sent[1]?.content ?? ''; // stored manifest+task from turn one
      ok('manifest: does not name the unreadable file', !historyManifest.includes('does-not-exist-phase15-1b'), historyManifest);
      ok('manifest: does name the readable file', historyManifest.includes('test-conversations-e2e.mjs'), historyManifest);
    }

    // === `conversations` management tool (phase 9, phase 4) ===
    console.log('\n=== conversations tool E2E Tests (phase 9, phase 4) ===\n');

    // --- fresh session: list is empty, no conversation id leaks in ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const { result } = await callConversations(baseUrl, sessionId, { action: 'list' }, 2);
      const text = textOf(result);
      ok('conversations list on a fresh session mentions no active conversations', text.includes('No active conversations'), text);
      ok('conversations list on a fresh session contains no conversation id', !UUID_RE.test(text), text);
    }

    // --- two conversations started by this session both appear in list, with no message bodies ---
    let listSessionId;
    let listIdA;
    let listIdB;
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      listSessionId = sessionId;
      backend.reset();
      const { result: r1 } = await callChat(baseUrl, sessionId, { message: 'list-test conversation A', max_tokens: 64, start_conversation: true }, 2);
      listIdA = textOf(r1).match(UUID_RE)?.[0];
      backend.reset();
      const { result: r2 } = await callChat(baseUrl, sessionId, { message: 'list-test conversation B', max_tokens: 64, start_conversation: true }, 3);
      listIdB = textOf(r2).match(UUID_RE)?.[0];

      const { result } = await callConversations(baseUrl, sessionId, { action: 'list' }, 4);
      const text = textOf(result);
      ok('conversations list includes both conversation ids started on this session', text.includes(listIdA) && text.includes(listIdB), text);
      ok('conversations list does not include the assistant reply body', !text.includes('fake.'), text);
      ok('conversations list does not include the user turn body', !text.includes('list-test conversation A') && !text.includes('list-test conversation B'), text);
    }

    // --- cross-session isolation: another session's list never shows this session's ids, and delete gives the identical "not found" response ---
    {
      const { sessionId: sessionIdB } = await initializeSession(baseUrl, '/mcp');
      const { result: listResult } = await callConversations(baseUrl, sessionIdB, { action: 'list' }, 2);
      const listText = textOf(listResult);
      ok('conversations list from another session does not include this session\'s ids', !listText.includes(listIdA) && !listText.includes(listIdB), listText);

      const { result: crossDeleteResult } = await callConversations(baseUrl, sessionIdB, { action: 'delete', conversation_id: listIdA }, 3);
      const { result: nonexistentDeleteResult } = await callConversations(baseUrl, sessionIdB, { action: 'delete', conversation_id: '00000000-0000-0000-0000-000000000000' }, 4);
      ok('conversations delete of another session\'s id is isError', crossDeleteResult?.isError === true, JSON.stringify(crossDeleteResult));
      ok('conversations delete of another session\'s id gives the exact same response as deleting a nonexistent id (no existence leak)',
        textOf(crossDeleteResult) === textOf(nonexistentDeleteResult) && crossDeleteResult?.isError === nonexistentDeleteResult?.isError,
        JSON.stringify({ cross: crossDeleteResult, nonexistent: nonexistentDeleteResult }));
    }

    // --- deleting one's own conversation: succeeds, the id stops working, and list reflects the removal ---
    {
      const { result: deleteResult } = await callConversations(baseUrl, listSessionId, { action: 'delete', conversation_id: listIdA }, 5);
      ok('conversations delete of one\'s own conversation id is not isError', deleteResult?.isError !== true, JSON.stringify(deleteResult));

      const { result: continueResult } = await callChat(baseUrl, listSessionId, { message: 'should fail', max_tokens: 64, conversation_id: listIdA }, 6);
      ok('chat continuation of a deleted conversation id is isError', continueResult?.isError === true, JSON.stringify(continueResult));

      const { result: listAfterDelete } = await callConversations(baseUrl, listSessionId, { action: 'list' }, 7);
      const text = textOf(listAfterDelete);
      ok('conversations list no longer includes the deleted id', !text.includes(listIdA), text);
      ok('conversations list still includes the untouched sibling id', text.includes(listIdB), text);
    }

    // --- parameter validation ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const { result: missingIdResult } = await callConversations(baseUrl, sessionId, { action: 'delete' }, 2);
      ok('conversations delete without conversation_id is isError', missingIdResult?.isError === true, JSON.stringify(missingIdResult));

      const { result: badActionResult } = await callConversations(baseUrl, sessionId, { action: 'not-a-real-action' }, 3);
      ok('conversations with an invalid action is isError', badActionResult?.isError === true, JSON.stringify(badActionResult));
    }

    // --- clear: wipes every conversation owned by this session, and previously-valid ids stop working ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      backend.reset();
      const { result: startResult } = await callChat(baseUrl, sessionId, { message: 'clear-test conversation', max_tokens: 64, start_conversation: true }, 2);
      const clearId = textOf(startResult).match(UUID_RE)?.[0];

      const { result: clearResult } = await callConversations(baseUrl, sessionId, { action: 'clear' }, 3);
      const clearText = textOf(clearResult);
      ok('conversations clear response mentions a count', /\d+/.test(clearText), clearText);
      ok('conversations clear is not isError', clearResult?.isError !== true, JSON.stringify(clearResult));

      const { result: listAfterClear } = await callConversations(baseUrl, sessionId, { action: 'list' }, 4);
      ok('conversations list is empty after clear', textOf(listAfterClear).includes('No active conversations'), textOf(listAfterClear));

      const { result: continueAfterClear } = await callChat(baseUrl, sessionId, { message: 'should fail after clear', max_tokens: 64, conversation_id: clearId }, 5);
      ok('chat continuation of a cleared conversation id is isError', continueAfterClear?.isError === true, JSON.stringify(continueAfterClear));
    }

    // --- tools/list exposes the conversations tool ---
    {
      const { sessionId } = await initializeSession(baseUrl, '/mcp');
      const list = await toolsList(baseUrl, sessionId, 99);
      const names = (list?.tools ?? []).map((t) => t.name);
      ok('tools/list includes the conversations tool', names.includes('conversations'), JSON.stringify(names));
    }

    console.log(failed ? `\n${failed} FAILED\n` : '\nAll conversation e2e tests passed\n');
  } finally {
    child.kill();
    await backend.close();
  }

  // === HOUTINI_LM_CONVERSATIONS=off tests: a second server instance with the feature disabled ===
  console.log('\n=== HOUTINI_LM_CONVERSATIONS=off E2E Tests ===\n');
  const backend2 = await startFakeBackend();
  const port2 = await getFreePort();
  const { child: child2, ready: ready2 } = startServer(backend2.url, port2, { HOUTINI_LM_CONVERSATIONS: '0' });
  const baseUrl2 = `http://127.0.0.1:${port2}`;
  try {
    await ready2;
    const { sessionId } = await initializeSession(baseUrl2, '/mcp');

    const list = await toolsList(baseUrl2, sessionId, 2);
    const chatProps = (list?.tools ?? []).find((t) => t.name === 'chat')?.inputSchema?.properties ?? {};
    const cpProps = (list?.tools ?? []).find((t) => t.name === 'custom_prompt')?.inputSchema?.properties ?? {};
    ok('off: chat.inputSchema.properties has no conversation params',
      !('start_conversation' in chatProps) && !('conversation_id' in chatProps), JSON.stringify(Object.keys(chatProps)));
    ok('off: custom_prompt.inputSchema.properties has no conversation params',
      !('start_conversation' in cpProps) && !('conversation_id' in cpProps), JSON.stringify(Object.keys(cpProps)));
    // Phase 15-1b: code_task_files must lose the same two params, the same way.
    const ctfProps = (list?.tools ?? []).find((t) => t.name === 'code_task_files')?.inputSchema?.properties ?? {};
    ok('off: code_task_files.inputSchema.properties has no conversation params',
      !('start_conversation' in ctfProps) && !('conversation_id' in ctfProps), JSON.stringify(Object.keys(ctfProps)));
    const toolNames = (list?.tools ?? []).map((t) => t.name);
    ok('off: tools/list does not include the conversations tool', !toolNames.includes('conversations'), JSON.stringify(toolNames));

    backend2.reset();
    const { result: conversationsOffResult } = await callConversations(baseUrl2, sessionId, { action: 'list' }, 6);
    ok('off: calling conversations is isError', conversationsOffResult?.isError === true, JSON.stringify(conversationsOffResult));

    backend2.reset();
    const { result: chatOffResult } = await callChat(baseUrl2, sessionId, { message: 'hi', max_tokens: 64, start_conversation: true }, 3);
    ok('off: chat with start_conversation:true is isError', chatOffResult?.isError === true, JSON.stringify(chatOffResult));

    backend2.reset();
    const { result: cpOffResult } = await callCustomPrompt(baseUrl2, sessionId, { instruction: 'hi', max_tokens: 64, start_conversation: true }, 4);
    ok('off: custom_prompt with start_conversation:true is isError', cpOffResult?.isError === true, JSON.stringify(cpOffResult));

    // Phase 15-1b: code_task_files must behave identically to custom_prompt
    // here — both fold their conversation args through the same
    // resolveConversation(), so there must be no tool-specific difference
    // (e.g. one silently ignoring the params while the other errors).
    backend2.reset();
    const { result: ctfOffResult } = await callCodeTaskFiles(baseUrl2, sessionId, { paths: [thisFile], task: 'hi', start_conversation: true }, 7);
    ok('off: code_task_files with start_conversation:true is isError, same as custom_prompt',
      ctfOffResult?.isError === true && textOf(ctfOffResult) === textOf(cpOffResult),
      JSON.stringify({ ctf: ctfOffResult, cp: cpOffResult }));
    ok('off: code_task_files with start_conversation:true reaches the backend no more than custom_prompt does (rejected before inference, not silently ignored)',
      backend2.requests.length === 0, String(backend2.requests.length));

    backend2.reset();
    const { result: cpNormalResult } = await callCustomPrompt(baseUrl2, sessionId, { instruction: 'hi', max_tokens: 64 }, 5);
    const sent = backend2.requests.at(-1)?.messages ?? [];
    ok('off: custom_prompt without conversation params succeeds normally, backend receives 2 messages', sent.length === 2, JSON.stringify(sent));
    ok('off: custom_prompt response has no conversation line', !UUID_RE.test(textOf(cpNormalResult)) && !textOf(cpNormalResult).includes('Conversation'),
      textOf(cpNormalResult));

    console.log(failed ? `\n${failed} FAILED\n` : '\nAll disabled-mode e2e tests passed\n');
  } finally {
    child2.kill();
    await backend2.close();
  }

  // === HOUTINI_LM_CONVERSATION_OWNER_HEADER e2e tests: a third server
  // instance where the owner key comes from a request header instead of the
  // MCP session id (phase 11, phase 2). OWNER_HEADER is the name this
  // server is configured to look for; it is a test-only value and must
  // never appear in compose/README/manual/CHANGELOG. ===
  console.log('\n=== HOUTINI_LM_CONVERSATION_OWNER_HEADER E2E Tests ===\n');
  const OWNER_HEADER = 'x-test-user';
  // Marker line the completion-condition grep counts — one per scenario
  // (a)-(f) below, emitted only when that scenario's assertions all passed.
  function ownerHeaderPass(letter, description, allOk) {
    if (allOk) process.stdout.write(`owner-header (${letter}) ${description}\n`);
  }
  const backend3 = await startFakeBackend();
  const port3 = await getFreePort();
  const { child: child3, ready: ready3 } = startServer(backend3.url, port3, { HOUTINI_LM_CONVERSATION_OWNER_HEADER: OWNER_HEADER });
  const baseUrl3 = `http://127.0.0.1:${port3}`;
  try {
    await ready3;

    // --- (a) same header value, different MCP session: continuation succeeds and the prior turn reaches the backend ---
    let ownerHeaderConvId;
    {
      const before = failed;
      const { sessionId: sessionA } = await initializeSession(baseUrl3, '/mcp', { [OWNER_HEADER]: 'user-a' });
      backend3.reset();
      const { result: startResult } = await callChat(baseUrl3, sessionA, { message: 'owner-header first turn', max_tokens: 64, start_conversation: true }, 2, { [OWNER_HEADER]: 'user-a' });
      ownerHeaderConvId = textOf(startResult).match(UUID_RE)?.[0];
      ok('owner header a: start_conversation returns a UUID-shaped id', !!ownerHeaderConvId, textOf(startResult));

      const { sessionId: sessionB } = await initializeSession(baseUrl3, '/mcp', { [OWNER_HEADER]: 'user-a' });
      backend3.reset();
      const { result: continueResult } = await callChat(baseUrl3, sessionB, { message: 'owner-header second turn', max_tokens: 64, conversation_id: ownerHeaderConvId }, 2, { [OWNER_HEADER]: 'user-a' });
      ok('owner header a: continuation from a different MCP session with the same header value is not isError', continueResult?.isError !== true, JSON.stringify(continueResult));
      const sent = backend3.requests.at(-1)?.messages ?? [];
      ok('owner header a: backend received 4 messages (prior turn threaded in)', sent.length === 4, JSON.stringify(sent));
      ownerHeaderPass('a', 'same-user cross-session continuation succeeds, prior turn reaches the backend', failed === before);
    }

    // --- (b) different header value: continuation is isError ---
    {
      const before = failed;
      const { sessionId: sessionC } = await initializeSession(baseUrl3, '/mcp', { [OWNER_HEADER]: 'user-b' });
      backend3.reset();
      const { result } = await callChat(baseUrl3, sessionC, { message: 'intruding', max_tokens: 64, conversation_id: ownerHeaderConvId }, 2, { [OWNER_HEADER]: 'user-b' });
      ok('owner header b: continuation with a different header value is isError', result?.isError === true, JSON.stringify(result));
      ok('owner header b: no request reached the backend', backend3.requests.length === 0, String(backend3.requests.length));
      ownerHeaderPass('b', 'different header value on continuation is isError', failed === before);
    }

    // --- (c) no header at all: continuation is isError (fail closed, no session-ID fallback) ---
    {
      const before = failed;
      const { sessionId: sessionD } = await initializeSession(baseUrl3, '/mcp');
      backend3.reset();
      const { result } = await callChat(baseUrl3, sessionD, { message: 'no header', max_tokens: 64, conversation_id: ownerHeaderConvId }, 2);
      ok('owner header c: continuation with the header entirely absent is isError', result?.isError === true, JSON.stringify(result));
      ok('owner header c: no request reached the backend', backend3.requests.length === 0, String(backend3.requests.length));
      ownerHeaderPass('c', 'missing header on continuation is isError (no session-ID fallback)', failed === before);
    }

    // --- (d) list from a different MCP session, same header value, shows the other session's conversation id ---
    {
      const before = failed;
      const { sessionId: sessionE } = await initializeSession(baseUrl3, '/mcp', { [OWNER_HEADER]: 'user-a' });
      const { result } = await callConversations(baseUrl3, sessionE, { action: 'list' }, 2, { [OWNER_HEADER]: 'user-a' });
      const text = textOf(result);
      ok('owner header d: list from a new session with the same header value includes the earlier session\'s conversation id', text.includes(ownerHeaderConvId), text);
      ownerHeaderPass('d', 'list is shared across sessions for the same header value', failed === before);
    }

    // --- (e) MCP session DELETE does not discard the conversation when the owner header is set ---
    {
      const before = failed;
      const { sessionId: sessionF } = await initializeSession(baseUrl3, '/mcp', { [OWNER_HEADER]: 'user-a' });
      backend3.reset();
      const { result: startResult } = await callChat(baseUrl3, sessionF, { message: 'discard-on-delete probe', max_tokens: 64, start_conversation: true }, 2, { [OWNER_HEADER]: 'user-a' });
      const deleteProbeId = textOf(startResult).match(UUID_RE)?.[0];
      ok('owner header e: probe conversation started', !!deleteProbeId, textOf(startResult));

      const delRes = await fetch(`${baseUrl3}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionF } });
      ok('owner header e: session DELETE succeeded', delRes.status === 200 || delRes.status === 204, String(delRes.status));

      const { sessionId: sessionG } = await initializeSession(baseUrl3, '/mcp', { [OWNER_HEADER]: 'user-a' });
      backend3.reset();
      const { result: continueResult } = await callChat(baseUrl3, sessionG, { message: 'after delete', max_tokens: 64, conversation_id: deleteProbeId }, 2, { [OWNER_HEADER]: 'user-a' });
      ok('owner header e: continuation still succeeds after the creating MCP session was DELETEd', continueResult?.isError !== true, JSON.stringify(continueResult));
      ownerHeaderPass('e', 'conversation survives MCP session DELETE in header-owner mode', failed === before);
    }

    // --- (f) duplicated/comma-joined header value: rejected, not silently split or averaged ---
    {
      const before = failed;
      const { sessionId: sessionH } = await initializeSession(baseUrl3, '/mcp', { [OWNER_HEADER]: 'user-a, user-b' });
      backend3.reset();
      const { result } = await callChat(baseUrl3, sessionH, { message: 'duplicated header', max_tokens: 64, start_conversation: true }, 2, { [OWNER_HEADER]: 'user-a, user-b' });
      ok('owner header f: a comma-joined (duplicated) header value is isError', result?.isError === true, JSON.stringify(result));
      ok('owner header f: no request reached the backend', backend3.requests.length === 0, String(backend3.requests.length));
      ownerHeaderPass('f', 'comma-joined header value is rejected outright', failed === before);
    }

    console.log(failed ? `\n${failed} FAILED\n` : '\nAll owner-header e2e tests passed\n');
  } finally {
    child3.kill();
    await backend3.close();
  }

  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
