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

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nAll reasoning-block tests passed\n');
process.exitCode = failed ? 1 : 0;
