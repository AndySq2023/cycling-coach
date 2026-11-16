// Source-level guards for two bugs that unit tests of pure functions can't see.
//
// 1. TDZ: init() is an IIFE that runs mid-script. Any top-level const/let it touches
//    (directly or through functions it calls) must be declared ABOVE it, or the
//    ReferenceError halts the whole <script> — the app loads blank. This bit twice
//    while building proposals (PROPOSAL_SOURCE, COACH_DATA_ALLOWLIST).
// 2. The per-exercise RIR box in the strength-log modal shares the .slog-set class
//    for styling; the set collector must exclude it or the RIR is logged as a set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/cycling-coach.html', import.meta.url), 'utf8');
const initAt = html.indexOf('(function init()');

// Globals read during init() — via renderProposalSurfaces, renderCoachSees,
// coachDataView, loadProposalState, startStatePolling.
const READ_DURING_INIT = [
  'PC', 'pendingProposal', 'coachSnapshots', 'dismissedChanges', 'lastReview', 'PROPOSAL_SOURCE',
  'COACH_WINDOW_DAYS', 'RIDE_FIELDS', 'MUSCLE_FIELDS', 'COACH_DATA_ALLOWLIST', 'COACH_ALSO_SEES',
  'STATE_POLL_MS',
];

test('init() exists', () => { assert.ok(initAt > 0); });

for (const name of READ_DURING_INIT) {
  test(`${name} is declared above init()`, () => {
    const m = new RegExp(`^(?:const|let)\\s+${name}\\b`, 'm').exec(html);
    assert.ok(m, `${name} not declared at top level`);
    assert.ok(m.index < initAt, `${name} is declared after init() — TDZ crash on load`);
  });
}

test('strength-log set collector excludes the RIR input', () => {
  const fn = html.slice(html.indexOf('function submitStrengthLog'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /\.slog-set:not\(\.slog-rir\)/);
});
