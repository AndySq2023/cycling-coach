// Coach proposals: every change type valid + invalid, stale detection, the one-round
// repair path, apply, snapshot/undo and dismissal matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../shared/proposal-core.js';

const P = globalThis.ProposalCore;
const TODAY = '2026-11-16';
const WHY = 'HRV 18% below 7-day baseline, recovery 31%';

function plan() {
  return [
    { id: 's1', day: 'Monday', date: '2026-11-16', type: 'Zone 2 Endurance', duration: 90, intensity: 'low', targets: 'HR 130-145', description: '', tips: [] },
    { id: 's2', day: 'Tuesday', date: '2026-11-17', type: 'Threshold 3x10', duration: 75, intensity: 'high', targets: '250-270W', description: '', tips: [] },
    { id: 's3', day: 'Wednesday', date: '2026-11-18', type: 'Rest Day', duration: 0, intensity: 'rest', targets: '', description: '', tips: [] },
  ];
}
function state(over = {}) {
  return {
    plan: plan(), resistance: [{ name: 'A', exercises: [{ name: 'Row', band: 'black', sets: 3, reps: '12' }] }],
    today: TODAY, bandIds: ['yellow', 'red', 'black', 'purple', 'green'],
    anchorIds: ['none', 'foot', 'feet-seated', 'back', 'peloton-low', 'peloton-mid', 'peloton-high'], ...over,
  };
}
const one = (c, st = state()) => P.validateProposal(P.prepareProposal({ changes: [c] }, st), st);

// ── each change type: one valid, one invalid ──────────────────
const CASES = {
  'move-session': [
    { type: 'move-session', target: { sessionId: 's2' }, after: { date: '2026-11-19' }, why: WHY },
    { type: 'move-session', target: { sessionId: 's2' }, after: { date: '2027-03-01' }, why: WHY }, // outside window
  ],
  'swap-session': [
    { type: 'swap-session', target: { sessionId: 's2' }, after: { type: 'Zone 2 Endurance', intensity: 'low' }, why: WHY },
    { type: 'swap-session', target: { sessionId: 's2' }, after: { type: '', intensity: 'brutal' }, why: WHY },
  ],
  'set-duration': [
    { type: 'set-duration', target: { sessionId: 's1' }, after: { duration: 60 }, why: WHY },
    { type: 'set-duration', target: { sessionId: 's1' }, after: { duration: 900 }, why: WHY },
  ],
  'set-intensity': [
    { type: 'set-intensity', target: { sessionId: 's2' }, after: { intensity: 'medium' }, why: WHY },
    { type: 'set-intensity', target: { sessionId: 's2' }, after: { intensity: 'max' }, why: WHY },
  ],
  'set-target': [
    { type: 'set-target', target: { sessionId: 's2' }, after: { targets: '230-250W' }, why: WHY },
    { type: 'set-target', target: { sessionId: 's2' }, after: { targets: 250 }, why: WHY },
  ],
  'add-rest-day': [
    { type: 'add-rest-day', target: { sessionId: 's2' }, why: WHY },
    { type: 'add-rest-day', target: {}, why: WHY },
  ],
  'add-session': [
    { type: 'add-session', target: { date: '2026-11-19' }, after: { type: 'Resistance — Upper', duration: 45, intensity: 'low', bands: true }, why: WHY },
    { type: 'add-session', target: { date: '2026-11-19' }, after: { type: 'Resistance', duration: -5 }, why: WHY },
  ],
  'remove-session': [
    { type: 'remove-session', target: { sessionId: 's2' }, why: WHY },
    { type: 'remove-session', target: { sessionId: 's99' }, why: WHY },
  ],
  'replace-week': [
    { type: 'replace-week', target: {}, after: { sessions: [{ date: '2026-11-16', type: 'Rest Day', duration: 0, intensity: 'rest' }] }, why: WHY },
    { type: 'replace-week', target: {}, after: { sessions: [] }, why: WHY },
  ],
  'replace-resistance-library': [
    { type: 'replace-resistance-library', target: {}, after: { workouts: [{ name: 'A', exercises: [{ name: 'Row', band: 'black', anchor: 'feet-seated', sets: 3 }] }] }, why: WHY },
    { type: 'replace-resistance-library', target: {}, after: { workouts: [{ name: 'A', exercises: [{ name: 'Row', band: 'blue', anchor: 'door', sets: 3 }] }] }, why: WHY },
  ],
};

test('every change type in the fixed list has a valid and an invalid case here', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...P.CHANGE_TYPES].sort());
});
for (const [type, [good, bad]] of Object.entries(CASES)) {
  test(`${type}: valid change passes`, () => {
    const v = one(good);
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.equal(v.changes[0].stale, false);
  });
  test(`${type}: invalid change is rejected`, () => {
    const v = one(bad);
    assert.equal(v.ok, false);
    assert.ok(v.errors.length);
  });
}

test('unknown type, missing target and missing evidence are rejected', () => {
  assert.match(one({ type: 'delete-everything', why: WHY }).errors[0], /unknown change type/);
  assert.match(one({ type: 'set-duration', after: { duration: 60 }, why: WHY }).errors.join(), /target\.sessionId is required/);
  assert.match(one({ type: 'set-duration', target: { sessionId: 's1' }, after: { duration: 60 } }).errors.join(), /why/);
});

test('band ids must come from the inventory and anchors from the anchor list', () => {
  const e = one(CASES['replace-resistance-library'][1]).errors.join('\n');
  assert.match(e, /band "blue"/);
  assert.match(e, /anchor "door"/);
});

test('more than MAX_CHANGES changes is rejected', () => {
  const many = Array.from({ length: P.MAX_CHANGES + 1 }, () => CASES['set-target'][0]);
  assert.match(P.validateProposal({ changes: many }, state()).errors[0], /too many/);
});

test('replace-week cannot be mixed with per-session edits', () => {
  const v = P.validateProposal({ changes: [CASES['replace-week'][0], CASES['set-duration'][0]] }, state());
  assert.equal(v.ok, false);
});

// ── staleness ─────────────────────────────────────────────
test('stale: before no longer matches the current session', () => {
  const st = state();
  const p = P.prepareProposal({ changes: [CASES['set-duration'][0]] }, st);
  assert.deepEqual(p.changes[0].before, { duration: 90 });
  st.plan[0].duration = 120; // edited by hand after the proposal arrived
  const v = P.validateProposal(p, st);
  assert.equal(v.ok, true);
  assert.equal(v.changes[0].stale, true);
});

test('stale: a coach-written before that is already wrong is caught', () => {
  const c = { ...CASES['set-duration'][0], before: { duration: 45 } };
  assert.equal(one(c).changes[0].stale, true);
});

test('stale: target session deleted', () => {
  const st = state();
  const p = P.prepareProposal({ changes: [CASES['set-intensity'][0]] }, st);
  st.plan = st.plan.filter(s => s.id !== 's2');
  assert.equal(P.isStale(p.changes[0], st), true);
});

test('stale: replace-week after the plan changed', () => {
  const st = state();
  const p = P.prepareProposal({ changes: [CASES['replace-week'][0]] }, st);
  st.plan[1].type = 'Hill repeats';
  assert.equal(P.isStale(p.changes[0], st), true);
});

test('stale changes are never applied', () => {
  const st = state();
  const p = P.prepareProposal({ changes: [CASES['set-duration'][0], CASES['set-target'][0]] }, st);
  st.plan[0].duration = 120;
  const r = P.applyChanges(st, p.changes);
  assert.deepEqual(r.applied, ['c2']);
  assert.deepEqual(r.skipped, [{ id: 'c1', reason: 'stale' }]);
  assert.equal(r.plan.find(s => s.id === 's1').duration, 120); // the hand edit survives
  assert.equal(r.plan.find(s => s.id === 's2').targets, '230-250W');
});

// ── apply ─────────────────────────────────────────────────
test('apply: each session change lands on a copy, original untouched', () => {
  const st = state();
  const changes = [
    CASES['move-session'][0], CASES['set-target'][0], CASES['add-session'][0],
  ];
  const p = P.prepareProposal({ changes }, st);
  const r = P.applyChanges(st, p.changes);
  assert.equal(r.applied.length, 3);
  const s2 = r.plan.find(s => s.id === 's2');
  assert.equal(s2.date, '2026-11-19');
  assert.equal(s2.day, 'Thursday');
  assert.equal(s2.targets, '230-250W');
  assert.ok(r.plan.find(s => s.id === 's4' && s.type === 'Resistance — Upper'));
  assert.equal(st.plan[1].date, '2026-11-17', 'input state not mutated');
  // sorted by date
  assert.deepEqual(r.plan.map(s => s.date), [...r.plan.map(s => s.date)].sort());
});

test('apply: add-rest-day converts a session; remove-session drops it', () => {
  const st = state();
  const r = P.applyChanges(st, P.prepareProposal({ changes: [CASES['add-rest-day'][0]] }, st).changes);
  assert.deepEqual(['Rest Day', 0, 'rest'], ['type', 'duration', 'intensity'].map(k => r.plan.find(s => s.id === 's2')[k]));
  const r2 = P.applyChanges(st, P.prepareProposal({ changes: [CASES['remove-session'][0]] }, st).changes);
  assert.equal(r2.plan.find(s => s.id === 's2'), undefined);
});

test('apply: replace-week and replace-resistance-library', () => {
  const st = state();
  const r = P.applyChanges(st, P.prepareProposal({ changes: [CASES['replace-week'][0], CASES['replace-resistance-library'][0]] }, st).changes);
  assert.equal(r.replacedWeek, true);
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].id, 's1');
  assert.equal(r.resistance[0].exercises[0].anchor, 'feet-seated');
});

// ── repair round ──────────────────────────────────────────
test('repair: a failing proposal gets exactly one repair round, which can fix it', async () => {
  let calls = 0, seen;
  const out = await P.resolveProposal({
    proposal: { changes: [CASES['set-duration'][1]] }, state: state(),
    repair: async errors => { calls++; seen = errors; return { changes: [CASES['set-duration'][0]] }; },
  });
  assert.equal(calls, 1);
  assert.match(seen.join(), /duration/);
  assert.equal(out.status, 'ok');
  assert.equal(out.repaired, true);
  assert.equal(out.proposal.changes[0].after.duration, 60);
});

test('repair: still invalid after the repair round → failed, nothing to apply', async () => {
  let calls = 0;
  const out = await P.resolveProposal({
    proposal: { changes: [CASES['set-duration'][1]] }, state: state(),
    repair: async () => { calls++; return { changes: [CASES['set-intensity'][1]] }; },
  });
  assert.equal(calls, 1);
  assert.equal(out.status, 'failed');
  assert.ok(out.errors.length);
  assert.equal(out.proposal, undefined);
});

test('repair: a repair that throws or returns nothing fails cleanly', async () => {
  const a = await P.resolveProposal({ proposal: { changes: [CASES['set-duration'][1]] }, state: state(), repair: async () => { throw new Error('net'); } });
  assert.equal(a.status, 'failed');
  const b = await P.resolveProposal({ proposal: { changes: [CASES['set-duration'][1]] }, state: state(), repair: async () => null });
  assert.equal(b.status, 'failed');
});

test('repair: a valid proposal never calls repair', async () => {
  let calls = 0;
  const out = await P.resolveProposal({ proposal: { changes: [CASES['set-duration'][0]] }, state: state(), repair: async () => { calls++; } });
  assert.equal(out.status, 'ok');
  assert.equal(calls, 0);
});

// ── legacy blocks → proposals ─────────────────────────────
test('legacy schedule_update splits into typed changes and carries why', () => {
  const p = P.proposalFromBlocks({ updates: [{ id: 's2', duration: 60, intensity: 'medium', targets: '220W', why: WHY }] }, state());
  assert.deepEqual(p.changes.map(c => c.type), ['set-duration', 'set-intensity', 'set-target']);
  assert.ok(p.changes.every(c => c.why === WHY));
});

test('legacy rest-day patch becomes add-rest-day; schedule_set → replace-week; schedule_add → add-session', () => {
  const st = state();
  assert.equal(P.proposalFromBlocks({ updates: [{ id: 's2', type: 'Rest Day', duration: 0, intensity: 'rest' }] }, st).changes[0].type, 'add-rest-day');
  assert.equal(P.proposalFromBlocks({ planSet: [{ id: 's1', date: TODAY, type: 'Z2', duration: 60, intensity: 'low' }] }, st).changes[0].type, 'replace-week');
  assert.equal(P.proposalFromBlocks({ planAdd: [{ date: '2026-11-19', type: 'Resistance', duration: 45 }] }, st).changes[0].type, 'add-session');
  assert.equal(P.proposalFromBlocks({ workouts: [{ name: 'A', exercises: [] }] }, st).changes[0].type, 'replace-resistance-library');
  assert.equal(P.proposalFromBlocks({}, st), null);
});

test('legacy blocks without evidence fail validation (and so go to repair)', () => {
  const st = state();
  const p = P.prepareProposal(P.proposalFromBlocks({ updates: [{ id: 's2', duration: 60 }] }, st), st);
  assert.equal(P.validateProposal(p, st).ok, false);
});

test('extractPlanProposal strips the block and parses it', () => {
  const t = 'Easing tomorrow.\n```plan_proposal\n{"summary":"x","changes":[{"type":"set-duration","target":{"sessionId":"s2"},"after":{"duration":60},"why":"recovery 31%"}]}\n```';
  const r = P.extractPlanProposal(t);
  assert.equal(r.clean, 'Easing tomorrow.');
  assert.equal(r.proposal.changes[0].type, 'set-duration');
  assert.equal(r.raw.length, 1);
  assert.equal(P.extractPlanProposal('```plan_proposal\n{bad json\n```').proposal, null);
});

test('parseNoChange recognises a quiet review in its accepted forms', () => {
  assert.equal(P.parseNoChange('{"nochange": true, "reading": "All on track."}').reading, 'All on track.');
  assert.equal(P.parseNoChange('```json\n{"nochange":true,"reading":"Fine"}\n```').nochange, true);
  assert.equal(P.parseNoChange('```plan_proposal\n{"changes":[]}\n```'), null);
  assert.equal(P.parseNoChange('{"nochange": false}'), null);
});

// ── snapshot / undo ───────────────────────────────────────
test('snapshots keep the last 10 and undo pops the newest', () => {
  let list = [];
  for (let i = 1; i <= 12; i++) list = P.pushSnapshot(list, { at: i, plan: [{ id: 's' + i }] });
  assert.equal(list.length, 10);
  assert.equal(list[0].at, 3);
  const { snapshot, list: rest } = P.popSnapshot(list);
  assert.equal(snapshot.at, 12);
  assert.equal(rest.length, 9);
  assert.deepEqual(P.popSnapshot([]), { snapshot: null, list: [] });
});

test('snapshot is a deep copy — later edits do not leak into it', () => {
  const plan = [{ id: 's1', duration: 90 }];
  const list = P.pushSnapshot([], { plan });
  plan[0].duration = 30;
  assert.equal(list[0].plan[0].duration, 90);
});

// ── dismissals ────────────────────────────────────────────
test('dismissal matches same type + after on the same session id or date', () => {
  const st = state();
  const c = P.prepareProposal({ changes: [CASES['set-duration'][0]] }, st).changes[0];
  const list = P.recordDismissals([], [c], 1);
  assert.equal(P.isDismissed({ ...c }, list), true);
  // Same day, different id (week rebuilt) still matches
  assert.equal(P.isDismissed({ ...c, target: { sessionId: 's9', date: '2026-11-16' } }, list), true);
  // Different value is new advice
  assert.equal(P.isDismissed({ ...c, after: { duration: 45 } }, list), false);
  // Different session is new advice
  assert.equal(P.isDismissed({ ...c, target: { sessionId: 's2', date: '2026-11-17' } }, list), false);
  // after key order does not matter
  const d = P.recordDismissals([], [{ type: 'swap-session', target: { sessionId: 's2' }, after: { type: 'Z2', intensity: 'low' } }], 1);
  assert.equal(P.isDismissed({ type: 'swap-session', target: { sessionId: 's2' }, after: { intensity: 'low', type: 'Z2' } }, d), true);
});

test('dismissals dedupe and cap', () => {
  const c = { type: 'set-duration', target: { sessionId: 's1' }, after: { duration: 60 }, why: WHY };
  let list = P.recordDismissals([], [c], 1);
  list = P.recordDismissals(list, [c], 2);
  assert.equal(list.length, 1);
  assert.equal(list[0].at, 2);
  const many = Array.from({ length: 40 }, (_, i) => ({ ...c, after: { duration: i } }));
  assert.equal(P.recordDismissals([], many, 1).length, P.DISMISSALS_MAX);
});
