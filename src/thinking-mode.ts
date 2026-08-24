/**
 * thinking-mode.ts — decide whether a thinking-capable model's reasoning
 * should be suppressed, forced on, or left alone for a given call.
 *
 * Extracted from chatCompletionStreamingInner()'s inline `if` so the
 * precedence rules have a single, testable source of truth. The env var
 * HOUTINI_LM_THINKING=off is a hard floor: vLLM-behind-an-alias deployments
 * rely on it to avoid empty responses (the model answers into
 * reasoning_content instead of content when thinking isn't suppressed —
 * see docs/SETUP-VLLM.md / docs/VLLM-BACKEND.md), and a per-call opt-in must
 * never override that operator-level safety net.
 *
 * Precedence, highest first:
 *   1. envMode === 'off'                          → 'suppress-env'
 *   2. forceThinking === true || envMode === 'on'  → 'force'
 *   3. supportsThinkingToggle === true             → 'suppress-auto'
 *   4. otherwise                                   → 'leave'
 *
 * 'suppress-env' and 'suppress-auto' both suppress thinking — callers send
 * an identical request body and log line for either; the distinct decision
 * values exist so callers can tell *why* (forced by the operator vs. the
 * server's own default-suppression heuristic), which future callers may
 * want to log or branch on differently.
 */

export type ThinkingDecision = 'suppress-env' | 'suppress-auto' | 'force' | 'leave';

export function resolveThinkingDecision(input: {
  /** HOUTINI_LM_THINKING, already lower-cased by the caller. */
  envMode: string;
  /** Per-call opt-in to force thinking. Only `true` (strict) counts as set. */
  forceThinking: unknown;
  /** Whether the routed model is known to support an enable_thinking-style toggle. */
  supportsThinkingToggle: boolean | null | undefined;
}): ThinkingDecision {
  if (input.envMode === 'off') return 'suppress-env';
  if (input.forceThinking === true || input.envMode === 'on') return 'force';
  if (input.supportsThinkingToggle === true) return 'suppress-auto';
  return 'leave';
}
