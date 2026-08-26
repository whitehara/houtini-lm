// Unit test for ConversationStore + formatConversationLine (phase 9:
// server-side conversations). Pure logic, no backend needed.
// Run: npm run test:conversations
import { ConversationStore, formatConversationLine, formatConversationList } from '../dist/conversation-store.js';

let failed = 0;
const eq = (name, got, want) => {
  const gotStr = JSON.stringify(got);
  const wantStr = JSON.stringify(want);
  const ok = gotStr === wantStr;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${gotStr}${ok ? '' : ` (want ${wantStr})`}\n`);
  if (!ok) failed++;
};
const ok = (name, cond) => {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}\n`);
  if (!cond) failed++;
};

// A mutable injected clock. Store.now must call this fresh each time it
// needs the current time — a store that caches the value at construction
// would never observe advanceClock()'s effect, which several tests below
// depend on.
function makeClock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// --- basic round trip: create → append → get returns turns in order ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  const owner = 'session-a';
  const id = store.create(owner);
  ok('create() returns a string id', typeof id === 'string' && id.length > 0);
  store.append(owner, id, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  eq('get() round trip returns turns in order', store.get(owner, id), [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
}

// --- TTL expiry: advancing the injected clock past ttlMs makes get() return undefined ---
{
  const clock = makeClock(0);
  const store = new ConversationStore({ ttlMs: 1_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000, now: clock.now });
  const owner = 'session-b';
  const id = store.create(owner);
  store.append(owner, id, [{ role: 'user', content: 'x' }]);
  ok('get() succeeds before TTL', store.get(owner, id) !== undefined);
  clock.advance(2_000);
  eq('get() returns undefined after TTL elapses (now() called fresh, not cached)', store.get(owner, id), undefined);
}

// --- get() on expired/missing conversation ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  eq('get() on unknown id → undefined', store.get('session-c', 'no-such-id'), undefined);
}

// --- maxTurns overflow: oldest pairs dropped, history stays user-first ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 4, maxChars: 48_000 });
  const owner = 'session-d';
  const id = store.create(owner);
  // 5 user/assistant pairs = 10 turns, well over maxTurns=4
  for (let i = 0; i < 5; i++) {
    store.append(owner, id, [{ role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` }]);
  }
  const turns = store.get(owner, id);
  ok('maxTurns: history trimmed to at most maxTurns', turns.length <= 4);
  ok('maxTurns: history starts with a user turn', turns[0].role === 'user');
  eq('maxTurns: most recent pair survives', turns[turns.length - 1], { role: 'assistant', content: 'a4' });
}

// --- maxChars overflow: oldest turns dropped ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 100, maxChars: 50 });
  const owner = 'session-e';
  const id = store.create(owner);
  for (let i = 0; i < 10; i++) {
    store.append(owner, id, [
      { role: 'user', content: 'x'.repeat(10) },
      { role: 'assistant', content: 'y'.repeat(10) },
    ]);
  }
  const turns = store.get(owner, id);
  const chars = turns.reduce((sum, t) => sum + t.content.length, 0);
  ok('maxChars: total content chars trimmed to at most maxChars', chars <= 50);
  ok('maxChars: history starts with a user turn', turns[0].role === 'user');
}

// --- always keep the most recent user turn, even if it alone exceeds maxChars ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 100, maxChars: 5 });
  const owner = 'session-f';
  const id = store.create(owner);
  store.append(owner, id, [{ role: 'user', content: 'this single turn is way over the char budget' }]);
  const turns = store.get(owner, id);
  eq('single oversized user turn is not dropped (countUserTurns<=1 stops trimming)', turns.length, 1);
}

// --- defensive: leading assistant turns (API misuse) are stripped, not just one ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 100, maxChars: 48_000 });
  const owner = 'session-g';
  const id = store.create(owner);
  // Directly append assistant-only turns (misuse: no matching user turn) to
  // construct multiple consecutive leading assistant turns, then a real pair.
  store.append(owner, id, [{ role: 'assistant', content: 'stray1' }]);
  store.append(owner, id, [{ role: 'assistant', content: 'stray2' }]);
  store.append(owner, id, [{ role: 'user', content: 'real question' }, { role: 'assistant', content: 'real answer' }]);
  const turns = store.get(owner, id);
  eq('all leading assistant turns stripped, not just the first', turns, [
    { role: 'user', content: 'real question' },
    { role: 'assistant', content: 'real answer' },
  ]);
}

// --- maxConversations overflow: oldest (by lastUsedAt) evicted, size() bounded ---
{
  const clock = makeClock(0);
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 3, maxTurns: 40, maxChars: 48_000, now: clock.now });
  const owner = 'session-h';
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(store.create(owner));
    clock.advance(10);
  }
  eq('size() reflects 3 created conversations', store.size(), 3);
  const fourthId = store.create(owner);
  eq('size() stays at maxConversations after overflow', store.size(), 3);
  eq('oldest conversation (first created) was evicted', store.get(owner, ids[0]), undefined);
  ok('newest conversation survives', store.get(owner, fourthId) !== undefined);
}

// --- append() on a non-existent conversation is a silent no-op ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  store.append('session-i', 'no-such-id', [{ role: 'user', content: 'x' }]);
  ok('append() on unknown id does not throw and creates nothing', store.size() === 0);
}

// --- owner isolation: get/delete from a different owner never succeed ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  const ownerA = 'session-j';
  const ownerB = 'session-k';
  const id = store.create(ownerA);
  store.append(ownerA, id, [{ role: 'user', content: 'secret' }]);
  eq('get() from a different owner → undefined (no cross-tenant read)', store.get(ownerB, id), undefined);
  eq('delete() from a different owner → false (no cross-tenant delete)', store.delete(ownerB, id), false);
  ok('the conversation is untouched after the cross-owner attempts', store.get(ownerA, id) !== undefined);
  eq('delete() from the correct owner → true', store.delete(ownerA, id), true);
  eq('get() after delete → undefined', store.get(ownerA, id), undefined);
}

// --- list()/clear() are scoped to a single owner ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  const ownerA = 'session-l';
  const ownerB = 'session-m';
  const idA1 = store.create(ownerA);
  const idA2 = store.create(ownerA);
  const idB1 = store.create(ownerB);
  store.append(ownerA, idA1, [{ role: 'user', content: 'a1' }]);
  store.append(ownerA, idA2, [{ role: 'user', content: 'a2' }]);
  store.append(ownerB, idB1, [{ role: 'user', content: 'b1' }]);

  const listA = store.list(ownerA);
  eq('list() returns only ownerA\'s 2 conversations', listA.map((c) => c.id).sort(), [idA1, idA2].sort());
  const listB = store.list(ownerB);
  eq('list() returns only ownerB\'s 1 conversation', listB.map((c) => c.id), [idB1]);

  const cleared = store.clear(ownerA);
  eq('clear() returns the count removed for that owner', cleared, 2);
  eq('list() for ownerA is empty after clear()', store.list(ownerA), []);
  eq('ownerB is unaffected by ownerA\'s clear()', store.list(ownerB).map((c) => c.id), [idB1]);
}

// --- list() summary shape ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  const owner = 'session-n';
  const id = store.create(owner);
  store.append(owner, id, [{ role: 'user', content: 'abc' }, { role: 'assistant', content: 'de' }]);
  const [summary] = store.list(owner);
  eq('list() summary: id matches', summary.id, id);
  eq('list() summary: turns count', summary.turns, 2);
  eq('list() summary: chars sums content lengths', summary.chars, 5);
  ok('list() summary: createdAt is a number', typeof summary.createdAt === 'number');
  ok('list() summary: lastUsedAt is a number', typeof summary.lastUsedAt === 'number');
}

// --- get() returns a defensive copy: neither the array nor its element objects are live references ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  const owner = 'session-o';
  const id = store.create(owner);
  store.append(owner, id, [{ role: 'user', content: 'original' }]);

  const turns = store.get(owner, id);
  turns.push({ role: 'assistant', content: 'mutated from outside' });
  eq('pushing onto the returned array does not affect the store', store.get(owner, id), [{ role: 'user', content: 'original' }]);

  const turnsAgain = store.get(owner, id);
  turnsAgain[0].content = 'tampered';
  eq('mutating a returned turn object\'s field does not affect the store', store.get(owner, id), [{ role: 'user', content: 'original' }]);
}

// --- append() copies the turn objects it's given: mutating the caller's array/objects after the call does not affect the store ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  const owner = 'session-p';
  const id = store.create(owner);

  const incoming = [{ role: 'user', content: 'original' }];
  store.append(owner, id, incoming);
  incoming[0].content = 'tampered after append';
  incoming.push({ role: 'assistant', content: 'sneaked in' });
  eq('mutating the caller\'s array/objects after append() does not affect the store', store.get(owner, id), [{ role: 'user', content: 'original' }]);
}

// --- makeKey() collision defense-in-depth: owner+id strings that concatenate
// to the same map key must never cross-leak, even though the store's public
// API is the only way to construct this (id is caller-supplied, not
// restricted to create()'s UUID output) ---
{
  const store = new ConversationStore({ ttlMs: 60_000, maxConversations: 10, maxTurns: 40, maxChars: 48_000 });
  const realOwner = 'A B';
  const realId = store.create(realOwner);
  store.append(realOwner, realId, [{ role: 'user', content: 'owner1 secret' }]);

  // makeKey('A', `B ${realId}`) === makeKey('A B', realId) — same map key,
  // different (owner, id) pair.
  const collidingOwner = 'A';
  const collidingId = `B ${realId}`;
  eq('get() with a colliding key but wrong owner → undefined', store.get(collidingOwner, collidingId), undefined);
  store.append(collidingOwner, collidingId, [{ role: 'user', content: 'should not land' }]);
  eq('append() with a colliding key but wrong owner is a no-op', store.get(realOwner, realId), [
    { role: 'user', content: 'owner1 secret' },
  ]);
  eq('delete() with a colliding key but wrong owner → false', store.delete(collidingOwner, collidingId), false);
  ok('the real conversation survives all colliding-key attempts', store.get(realOwner, realId) !== undefined);
}

// --- formatConversationLine: no leading/trailing newline, caller prepends \n itself ---
{
  const line = formatConversationLine('abc-123', 3, 120, 60);
  ok('formatConversationLine does not start with \\n', !line.startsWith('\n'));
  ok('formatConversationLine does not end with \\n', !line.endsWith('\n'));
  ok('formatConversationLine mentions the conversation id', line.includes('abc-123'));
  ok('formatConversationLine mentions the turn count', line.includes('3'));
  ok('formatConversationLine mentions the char count', line.includes('120'));
  ok('formatConversationLine mentions the TTL', line.includes('60'));
}

// --- formatConversationList: the `conversations` tool's `list` action rendering (phase 9, phase 4) ---
{
  const emptyOutput = formatConversationList([], 60, 1_000_000);
  ok('formatConversationList on empty input mentions no active conversations', emptyOutput.includes('No active conversations'));
  ok('formatConversationList on empty input has no table pipe characters', !emptyOutput.includes('|'));

  const now = 1_000_000;
  const older = { id: 'older-id', turns: 2, chars: 40, createdAt: now - 500_000, lastUsedAt: now - 400_000 };
  const newer = { id: 'newer-id', turns: 4, chars: 200, createdAt: now - 100_000, lastUsedAt: now - 10_000 };
  const twoOutput = formatConversationList([older, newer], 60, now);
  ok('formatConversationList includes both conversation ids', twoOutput.includes('older-id') && twoOutput.includes('newer-id'));
  ok('formatConversationList sorts most-recently-used first', twoOutput.indexOf('newer-id') < twoOutput.indexOf('older-id'));
  ok('formatConversationList includes turn and char counts', twoOutput.includes('4') && twoOutput.includes('200'));
  ok('formatConversationList has no leading or trailing newline', !twoOutput.startsWith('\n') && !twoOutput.endsWith('\n'));

  // idle time exceeds the TTL window entirely — expires-in must clamp to "<1m",
  // never show a negative or over-TTL value.
  const expiredButNotYetSwept = { id: 'stale-id', turns: 1, chars: 10, createdAt: now - 10_000_000, lastUsedAt: now - 10_000_000 };
  const staleOutput = formatConversationList([expiredButNotYetSwept], 60, now);
  ok('formatConversationList clamps an over-TTL idle time to <1m expires-in, not a negative number', staleOutput.includes('<1m') && !/-\d+m/.test(staleOutput));
}

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nAll conversation-store tests passed\n');
process.exitCode = failed ? 1 : 0;
