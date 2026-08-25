/**
 * conversation-store.ts — in-memory, TTL-bounded store for server-side
 * chat/custom_prompt conversation history (phase 9: "server-side
 * conversations"). Pure logic, no MCP/SDK/network imports — index.ts wires
 * this to the chat and custom_prompt handlers.
 *
 * Why in-memory and not node:sqlite (like model-cache.ts): conversation
 * turns are the user's actual prompt/response content, not a re-derivable
 * cache. Persisting them to disk on a shared remote instance (this server
 * runs behind mcp-auth-proxy for multiple OIDC-authenticated users) would
 * leave that content sitting on disk indefinitely. Losing it on process
 * restart / redeploy is an accepted, documented tradeoff (see README
 * "Server-side conversations"), not an oversight.
 *
 * Multi-tenant safety (the reason this module exists in the shape it does):
 * every conversation is scoped to an *owner* key supplied by the caller.
 * This store treats `owner` as an opaque string and does no resolution of
 * its own — index.ts is responsible for deriving it per the session-ID
 * resolution rule (stdio transport → fixed key "stdio-local"; HTTP
 * transport → the MCP transport session ID, `extra.sessionId`, with no
 * fallback when that's undefined). Getting that resolution wrong is a
 * cross-tenant history leak, not a cosmetic bug, so it lives in index.ts
 * where the transport context is actually available and is reviewed
 * accordingly — this module just enforces that whatever owner string it's
 * given can never see another owner's conversations.
 *
 * No timers: `setInterval` would pin a stdio server process's event loop
 * open and block clean exit. Instead, expiry is a "lazy sweep" — every
 * mutating/enumerating call (create/get/append/list) removes TTL-expired
 * entries before doing its own work. delete/clear/size intentionally do
 * *not* sweep first; they operate on whatever is currently in the map,
 * which is harmless (deleting/counting an already-expired entry early is
 * not observably different from deleting/counting it after the next sweep).
 *
 * Memory ceiling: worst case is maxConversations × maxChars ≈ 50 × 48,000
 * chars ≈ 2.4M chars of stored text, call it ~5MB with UTF-16 string
 * storage and per-object/array overhead. That's a back-of-envelope bound
 * for operators sizing the container, not a measured figure.
 */

import { randomUUID } from 'node:crypto';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationStoreOptions {
  /** Idle-expiry window in milliseconds, measured from lastUsedAt. */
  ttlMs: number;
  /** Max conversations across *all* owners combined; oldest (by lastUsedAt) is evicted on overflow. */
  maxConversations: number;
  /** Max user/assistant turns retained per conversation. */
  maxTurns: number;
  /** Max total content chars (sum of all turns' `content.length`) retained per conversation. */
  maxChars: number;
  /**
   * Clock, called fresh every time a timestamp is needed — never cached.
   * Tests inject a mutable clock here to advance time without real delays;
   * caching `now()` once in the constructor would make that impossible.
   * Defaults to `Date.now`.
   */
  now?: () => number;
}

interface ConversationEntry {
  owner: string;
  id: string;
  turns: ConversationTurn[];
  createdAt: number;
  lastUsedAt: number;
}

export interface ConversationSummary {
  id: string;
  turns: number;
  chars: number;
  createdAt: number;
  lastUsedAt: number;
}

function makeKey(owner: string, id: string): string {
  return `${owner} ${id}`;
}

function totalChars(turns: ConversationTurn[]): number {
  let sum = 0;
  for (const t of turns) sum += t.content.length;
  return sum;
}

function countUserTurns(turns: ConversationTurn[]): number {
  let n = 0;
  for (const t of turns) if (t.role === 'user') n++;
  return n;
}

/**
 * Drop the oldest user/assistant pair from the front of `turns`, in place.
 * Assumes the invariant "turns starts with a user turn, or is empty" holds
 * on entry (true after any prior trim — see stripLeadingAssistants below),
 * so the first shift() removes a user turn and the second removes its
 * paired assistant reply if one is present.
 */
function removeOldestPair(turns: ConversationTurn[]): void {
  if (turns.length === 0) return;
  turns.shift();
  if (turns.length > 0 && turns[0].role === 'assistant') {
    turns.shift();
  }
}

/**
 * Enforce "history starts with a user turn, or is empty" by dropping any
 * leading assistant turns — not just one. This is a defensive invariant
 * check: normal append()/trim() traffic (always user-then-assistant pairs,
 * always removed in pairs) should never produce a leading assistant turn,
 * but a caller that appends an assistant-only turn (API misuse) must not
 * be able to leave the stored history in that state.
 */
function stripLeadingAssistants(turns: ConversationTurn[]): void {
  while (turns.length > 0 && turns[0].role === 'assistant') {
    turns.shift();
  }
}

/** Trim `turns` in place to the configured limits. See module header for the pair-removal rationale. */
function trim(turns: ConversationTurn[], maxTurns: number, maxChars: number): void {
  while (turns.length > maxTurns || totalChars(turns) > maxChars) {
    if (countUserTurns(turns) <= 1) break; // always keep the most recent user turn
    removeOldestPair(turns);
  }
  stripLeadingAssistants(turns);
}

export class ConversationStore {
  private readonly entries = new Map<string, ConversationEntry>();
  private readonly options: Required<ConversationStoreOptions>;

  constructor(options: ConversationStoreOptions) {
    this.options = { now: Date.now, ...options };
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.options.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  private oldestKey(): string | undefined {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    return oldestKey;
  }

  create(owner: string): string {
    const now = this.options.now();
    this.sweep(now);
    if (this.entries.size >= this.options.maxConversations) {
      const evictKey = this.oldestKey();
      if (evictKey !== undefined) this.entries.delete(evictKey);
    }
    const id = randomUUID();
    this.entries.set(makeKey(owner, id), { owner, id, turns: [], createdAt: now, lastUsedAt: now });
    return id;
  }

  get(owner: string, id: string): ConversationTurn[] | undefined {
    const now = this.options.now();
    this.sweep(now);
    const entry = this.entries.get(makeKey(owner, id));
    // entry.owner !== owner: defense-in-depth against a makeKey() collision
    // (e.g. owner "A B" + id "X" vs. owner "A" + id "B X" both hash to the
    // same map key) — treated the same as a plain miss, not a special error.
    if (!entry || entry.owner !== owner) return undefined;
    entry.lastUsedAt = now;
    return entry.turns.map((t) => ({ ...t }));
  }

  /** No-op if the conversation doesn't exist (e.g. already expired) — append is fire-and-forget from the caller's side. */
  append(owner: string, id: string, turns: ConversationTurn[]): void {
    const now = this.options.now();
    this.sweep(now);
    const entry = this.entries.get(makeKey(owner, id));
    // See the matching comment in get() re: makeKey() collision defense-in-depth.
    if (!entry || entry.owner !== owner) return;
    entry.turns.push(...turns.map((t) => ({ ...t })));
    trim(entry.turns, this.options.maxTurns, this.options.maxChars);
    entry.lastUsedAt = now;
  }

  delete(owner: string, id: string): boolean {
    const key = makeKey(owner, id);
    const entry = this.entries.get(key);
    // See the matching comment in get() re: makeKey() collision defense-in-depth.
    if (!entry || entry.owner !== owner) return false;
    return this.entries.delete(key);
  }

  clear(owner: string): number {
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (entry.owner === owner) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  list(owner: string): ConversationSummary[] {
    const now = this.options.now();
    this.sweep(now);
    const out: ConversationSummary[] = [];
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue;
      out.push({
        id: entry.id,
        turns: entry.turns.length,
        chars: totalChars(entry.turns),
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
      });
    }
    return out;
  }

  /** Total conversation count across all owners. No sweep — a diagnostic/test accessor, not a source of truth for TTL state. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Build the one-line summary appended to a chat/custom_prompt response when
 * server-side conversation tracking is active. Returns a line with no
 * leading or trailing newline — callers prepend `\n` themselves, matching
 * the existing `suggestionLine` convention in index.ts (see e.g. the
 * code_task handler).
 */
export function formatConversationLine(id: string, turns: number, chars: number, ttlMin: number): string {
  return `💬 Conversation ${id} — ${turns} turn${turns === 1 ? '' : 's'}, ${chars} chars retained. Idle-expires in ${ttlMin}min. Continue with conversation_id: "${id}".`;
}
