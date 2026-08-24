// Unit test for resolveThinkingDecision (suppress/force/leave precedence).
// Pure function, no backend needed. Run: npm run test:thinking-mode
import { resolveThinkingDecision } from '../dist/thinking-mode.js';

let failed = 0;
const eq = (name, got, want) => {
  const ok = got === want;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}\n`);
  if (!ok) failed++;
};

// Full 3×3×3 decision table: envMode × forceThinking × supportsThinkingToggle.
const ENVS = ['off', 'on', 'auto'];
const FORCES = [true, false, undefined];
const TOGGLES = [true, false, null];

const expected = (envMode, forceThinking, toggle) => {
  if (envMode === 'off') return 'suppress-env';
  if (forceThinking === true || envMode === 'on') return 'force';
  if (toggle === true) return 'suppress-auto';
  return 'leave';
};

for (const envMode of ENVS) {
  for (const forceThinking of FORCES) {
    for (const toggle of TOGGLES) {
      const name = `envMode=${envMode} forceThinking=${forceThinking} toggle=${toggle}`;
      eq(name,
        resolveThinkingDecision({ envMode, forceThinking, supportsThinkingToggle: toggle }),
        expected(envMode, forceThinking, toggle));
    }
  }
}

// --- forceThinking must be strictly `true` — no truthy coercion ---
eq('forceThinking="true" (string) does not force',
  resolveThinkingDecision({ envMode: 'auto', forceThinking: 'true', supportsThinkingToggle: false }),
  'leave');
eq('forceThinking=1 (number) does not force',
  resolveThinkingDecision({ envMode: 'auto', forceThinking: 1, supportsThinkingToggle: false }),
  'leave');
eq('forceThinking="true" (string) + toggle=true still just suppress-auto',
  resolveThinkingDecision({ envMode: 'auto', forceThinking: 'true', supportsThinkingToggle: true }),
  'suppress-auto');

// --- empty envMode (unset, before the caller's `|| 'auto'` fallback) behaves like 'auto' ---
eq('envMode="" behaves like auto (leave)',
  resolveThinkingDecision({ envMode: '', forceThinking: false, supportsThinkingToggle: false }),
  'leave');
eq('envMode="" behaves like auto (suppress-auto)',
  resolveThinkingDecision({ envMode: '', forceThinking: false, supportsThinkingToggle: true }),
  'suppress-auto');
eq('envMode="" + forceThinking=true still forces',
  resolveThinkingDecision({ envMode: '', forceThinking: true, supportsThinkingToggle: false }),
  'force');

process.stdout.write(failed ? `\n${failed} FAILED\n` : '\nAll thinking-mode tests passed\n');
process.exitCode = failed ? 1 : 0;
