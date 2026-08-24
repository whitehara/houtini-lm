// Unit test for formatReasoningBlock (the include_reasoning gate). Pure
// function, no backend needed. Run: npm run test:reasoning
import { formatReasoningBlock } from '../dist/reasoning-block.js';

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}\n`);
  if (!ok) failed++;
};

const EXPECTED = '\n\n---\n**Reasoning (verify how this conclusion was reached):**\nabc\n---';

// --- normal case ---
eq('include=true + reasoningContent → exact delimited block',
  formatReasoningBlock(true, { reasoningContent: 'abc' }),
  EXPECTED);

// --- boolean-only gate: anything that isn't exactly `true` is false ---
eq('include=undefined → empty', formatReasoningBlock(undefined, { reasoningContent: 'abc' }), '');
eq('include=false → empty', formatReasoningBlock(false, { reasoningContent: 'abc' }), '');
eq('include="false" (string) → empty', formatReasoningBlock('false', { reasoningContent: 'abc' }), '');
eq('include="true" (string) → empty', formatReasoningBlock('true', { reasoningContent: 'abc' }), '');
eq('include=1 (number) → empty', formatReasoningBlock(1, { reasoningContent: 'abc' }), '');

// --- no reasoning to show ---
eq('include=true + reasoningContent=undefined → empty', formatReasoningBlock(true, {}), '');
eq('include=true + reasoningContent="   " (whitespace only) → empty',
  formatReasoningBlock(true, { reasoningContent: '   ' }), '');

// --- duplicate-content guard: fallback cases already put reasoning in resp.content ---
eq('include=true + reasoningFallback=true → empty (avoid duplicate)',
  formatReasoningBlock(true, { reasoningContent: 'abc', reasoningFallback: true }), '');
eq('include=true + thinkStripFallback=true → empty (avoid duplicate)',
  formatReasoningBlock(true, { reasoningContent: 'abc', thinkStripFallback: true }), '');

// --- concatenation contract: starts with \n\n, ends with no trailing newline,
//     footer is appended untouched (no extra blank line introduced) ---
const block = formatReasoningBlock(true, { reasoningContent: 'R' });
const concatenated = 'BODY' + block + '\n\nFOOTER';
eq('concatenation form matches expected join',
  concatenated,
  'BODY\n\n---\n**Reasoning (verify how this conclusion was reached):**\nR\n---\n\nFOOTER');

// --- hint lines: include_reasoning:true, no reasoning came back, and the
//     server's thinkingDecision explains why (phase 5) ---
const HINT_SUPPRESS_AUTO =
  '\n\n---\n**Reasoning: none captured.** This model advertises an enable_thinking toggle, so houtini-lm ' +
  'suppressed its thinking automatically. Pass force_thinking: true alongside include_reasoning: true to make it think.\n---';
const HINT_SUPPRESS_ENV =
  '\n\n---\n**Reasoning: none captured.** Thinking is disabled server-side (HOUTINI_LM_THINKING=off); ' +
  'force_thinking cannot override that per call. The server operator has to change the setting.\n---';
const HINT_FORCE =
  '\n\n---\n**Reasoning: none captured.** Thinking was forced on for this call, but the model returned none ' +
  '— it may ignore the enable_thinking toggle, or it may not be a thinking model.\n---';

eq('include=true + no reasoning + thinkingDecision=suppress-auto → hint A',
  formatReasoningBlock(true, { thinkingDecision: 'suppress-auto' }), HINT_SUPPRESS_AUTO);
eq('include=true + no reasoning + thinkingDecision=suppress-env → hint B',
  formatReasoningBlock(true, { thinkingDecision: 'suppress-env' }), HINT_SUPPRESS_ENV);
eq('include=true + no reasoning + thinkingDecision=force → hint C',
  formatReasoningBlock(true, { thinkingDecision: 'force' }), HINT_FORCE);
eq('include=true + no reasoning + thinkingDecision=leave → empty (no hint)',
  formatReasoningBlock(true, { thinkingDecision: 'leave' }), '');
eq('include=true + no reasoning + thinkingDecision=undefined → empty (no hint)',
  formatReasoningBlock(true, {}), '');

// --- reasoning present wins over any hint ---
eq('include=true + reasoningContent + thinkingDecision=suppress-auto → normal block, not the hint',
  formatReasoningBlock(true, { reasoningContent: 'abc', thinkingDecision: 'suppress-auto' }), EXPECTED);

// --- hints must not leak onto the default (include not true) path ---
eq('include=false + thinkingDecision=suppress-auto → empty (no hint leak)',
  formatReasoningBlock(false, { thinkingDecision: 'suppress-auto' }), '');

// --- duplicate-content guard still wins over a hint ---
eq('include=true + reasoningFallback=true + thinkingDecision=suppress-env → empty (guard beats hint)',
  formatReasoningBlock(true, { reasoningContent: 'abc', reasoningFallback: true, thinkingDecision: 'suppress-env' }), '');

// --- concatenation contract for a hint line, same as the normal block ---
const hintBlock = formatReasoningBlock(true, { thinkingDecision: 'suppress-auto' });
const hintConcatenated = 'BODY' + hintBlock + '\n\nFOOTER';
eq('hint concatenation form matches expected join',
  hintConcatenated,
  'BODY' + HINT_SUPPRESS_AUTO + '\n\nFOOTER');

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nAll reasoning-block tests passed\n');
process.exitCode = failed ? 1 : 0;
