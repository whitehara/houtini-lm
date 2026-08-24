/**
 * reasoning-block.ts — format a thinking model's reasoning as a delimited
 * block for callers that opt in via `include_reasoning`.
 *
 * Reasoning is stripped by default (see StreamingResult.reasoningContent in
 * index.ts) so delegated-task responses stay compact. When a caller passes
 * include_reasoning: true and the model actually produced reasoning, this
 * appends it after the answer so the caller can verify how the conclusion
 * was reached — without changing default behaviour for everyone else.
 *
 * Guarded against reasoningFallback / thinkStripFallback: in both cases the
 * response body already IS the raw reasoning (the model gave no other
 * content to fall back to), so appending reasoningContent again would
 * duplicate it verbatim.
 *
 * When include_reasoning is set but no reasoning came back, a delimited
 * hint line explains why — sourced from the thinkingDecision the server
 * made (see thinking-mode.ts) so the caller knows whether force_thinking
 * would help, or whether the operator has locked thinking off entirely.
 */

type ReasoningSource = {
  reasoningContent?: string;
  reasoningFallback?: boolean;
  thinkStripFallback?: boolean;
  thinkingDecision?: string;
};

const HINT_SUPPRESS_AUTO =
  '\n\n---\n**Reasoning: none captured.** This model advertises an enable_thinking toggle, so houtini-lm ' +
  'suppressed its thinking automatically. Pass force_thinking: true alongside include_reasoning: true to make it think.\n---';

const HINT_SUPPRESS_ENV =
  '\n\n---\n**Reasoning: none captured.** Thinking is disabled server-side (HOUTINI_LM_THINKING=off); ' +
  'force_thinking cannot override that per call. The server operator has to change the setting.\n---';

const HINT_FORCE =
  '\n\n---\n**Reasoning: none captured.** Thinking was forced on for this call, but the model returned none ' +
  '— it may ignore the enable_thinking toggle, or it may not be a thinking model.\n---';

export function formatReasoningBlock(include: unknown, resp: ReasoningSource): string {
  if (include !== true) return '';
  if (resp.reasoningFallback === true || resp.thinkStripFallback === true) return '';
  const reasoning = resp.reasoningContent?.trim();
  if (reasoning) return `\n\n---\n**Reasoning (verify how this conclusion was reached):**\n${reasoning}\n---`;
  if (resp.thinkingDecision === 'suppress-auto') return HINT_SUPPRESS_AUTO;
  if (resp.thinkingDecision === 'suppress-env') return HINT_SUPPRESS_ENV;
  if (resp.thinkingDecision === 'force') return HINT_FORCE;
  return '';
}
