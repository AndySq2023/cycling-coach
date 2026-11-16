// Muscle normalisation and the hard-sets-per-muscle counter (Strength hub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../shared/muscle-core.js';

const M = globalThis.MuscleCore;
const TODAY = '2026-11-19'; // a Thursday; the week starts Mon 2026-11-16

test('~18 canonical muscles, and every dataset name maps onto one', () => {
  assert.equal(M.MUSCLES.length, 18);
  for (const n of ['pectorals', 'latissimus dorsi', 'rear deltoids', 'trapezius', 'spine', 'quadriceps', 'inner thighs', 'soleus', 'brachialis', 'serratus anterior']) {
    assert.ok(M.MUSCLES.includes(M.normalizeMuscle(n)), n);
  }
  assert.equal(M.normalizeMuscle('cardiovascular system'), null);
  assert.deepEqual(M.normalizeMuscles(['Lats', 'latissimus dorsi', 'feet']), ['lats']);
});

test('every exercise in the starter programme gets at least one primary muscle', () => {
  const html = readFileSync(new URL('../app/cycling-coach.html', import.meta.url), 'utf8');
  const block = html.slice(html.indexOf('const STARTER_PROGRAMME'), html.indexOf('function installStarterProgramme'));
  const names = [...block.matchAll(/\{ name: '([^']+)', sets/g)].map(m => m[1]);
  assert.ok(names.length >= 16);
  for (const n of names) assert.ok(M.musclesForExercise(n).primary.length, `untagged: ${n}`);
});

test('name rules: specific before general', () => {
  assert.deepEqual(M.musclesForExercise('C2 · Hammer curl').primary, ['biceps', 'forearms']);
  assert.deepEqual(M.musclesForExercise('Biceps curl').primary, ['biceps']);
  assert.deepEqual(M.musclesForExercise('A1 · Kneeling lat pulldown').primary, ['lats']);
  assert.deepEqual(M.musclesForExercise('Band pull-apart (warm-up)').primary, ['delts', 'upper back']);
  assert.deepEqual(M.musclesForExercise('Pallof press').primary, ['obliques', 'abs']);
  assert.deepEqual(M.musclesForExercise('Mystery move').primary, []);
});

test('the exercise library tags win over name rules when the name matches', () => {
  const lib = { exercises: [{ name: 'band shrug', target: 'traps', secondary: ['upper back'] }] };
  assert.deepEqual(M.musclesForExercise('Band shrug', lib), { primary: ['traps'], secondary: ['upper back'] });
});

const entry = (date, exercises, sessionRpe = null) => ({ date, sessionRpe, exercises });
const row = (sets, muscles) => ({ name: 'Seated row', muscles, sets });

test('a set is hard at RIR ≤ 3; RIR 4 is not', () => {
  const r = M.hardSetsByMuscle([entry('2026-11-17', [row([{ reps: 12, rir: 3 }, { reps: 12, rir: 4 }])])]);
  assert.equal(r.ratedSets, 2);
  assert.equal(r.hardSets, 1);
  assert.equal(r.counts['upper back'], 1);
  assert.equal(r.counts.biceps, 0.5, 'secondary counts half');
});

test('no per-set RIR: session RPE ≥ 7 decides', () => {
  const sets = [{ reps: 12 }, { reps: 10 }];
  assert.equal(M.hardSetsByMuscle([entry('2026-11-17', [row(sets)], 7)]).hardSets, 2);
  assert.equal(M.hardSetsByMuscle([entry('2026-11-17', [row(sets)], 6)]).hardSets, 0);
  const unrated = M.hardSetsByMuscle([entry('2026-11-17', [row(sets)])]);
  assert.equal(unrated.ratedSets, 0);
  assert.equal(unrated.totalSets, 2);
});

test('per-set RIR beats session RPE', () => {
  const r = M.hardSetsByMuscle([entry('2026-11-17', [row([{ reps: 12, rir: 5 }])], 9)]);
  assert.equal(r.hardSets, 0);
});

test('stored muscle tags beat name rules; a muscle in both lists is not double-counted', () => {
  const r = M.hardSetsByMuscle([entry('2026-11-17', [row([{ reps: 10, rir: 1 }], { primary: ['lats'], secondary: ['lats', 'biceps'] })])]);
  assert.equal(r.counts.lats, 1);
  assert.equal(r.counts.biceps, 0.5);
  assert.equal(r.counts['upper back'], 0);
});

test('weekly view: this week from Monday, averages hidden under 5 rated sets', () => {
  const few = M.weeklyHardSets([entry('2026-11-17', [row([{ reps: 12, rir: 2 }, { reps: 12, rir: 2 }])])], TODAY);
  assert.equal(few.weekStart, '2026-11-16');
  assert.equal(few.week['upper back'], 2);
  assert.equal(few.showAverages, false);
  assert.deepEqual(few.neglected, []);
  assert.equal(few.avg['upper back'], 0);
});

test('weekly view: 4-week average and the neglected list once there is enough data', () => {
  const log = [];
  for (let w = 1; w <= 4; w++) {
    const d = new Date(Date.UTC(2026, 10, 17 - 7 * w)).toISOString().slice(0, 10); // Tuesdays of the 4 previous weeks
    log.push(entry(d, [row([{ reps: 12, rir: 2 }, { reps: 12, rir: 2 }, { reps: 12, rir: 2 }])]));
  }
  const hs = M.weeklyHardSets(log, TODAY);
  assert.equal(hs.showAverages, true);
  assert.equal(hs.avg['upper back'], 3);
  assert.equal(hs.avg.biceps, 1.5);
  assert.ok(hs.neglected.includes('chest'));
  assert.ok(hs.neglected.includes('biceps'), '1.5 a week is under 2');
  assert.ok(!hs.neglected.includes('upper back'));
  assert.ok(!hs.neglected.includes('quads'), 'legs are not judged — riding covers them');
});

test('sessions older than the 5-week window are ignored', () => {
  const hs = M.weeklyHardSets([entry('2026-09-01', [row([{ reps: 12, rir: 1 }])])], TODAY);
  assert.equal(hs.ratedSets, 0);
});
