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
 */

type ReasoningSource = {
  reasoningContent?: string;
  reasoningFallback?: boolean;
  thinkStripFallback?: boolean;
};

export function formatReasoningBlock(include: unknown, resp: ReasoningSource): string {
  if (include !== true) return '';
  if (resp.reasoningFallback === true || resp.thinkStripFallback === true) return '';
  const reasoning = resp.reasoningContent?.trim();
  if (!reasoning) return '';
  return `\n\n---\n**Reasoning (verify how this conclusion was reached):**\n${reasoning}\n---`;
}
