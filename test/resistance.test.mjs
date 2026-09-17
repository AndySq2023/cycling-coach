// The resistance schema guard. normalizeResistanceWorkout() is the door every
// coach-authored session comes through, and the coach is an LLM emitting JSON — so
// the interesting cases are all the ways a prescription can be subtly wrong rather
// than malformed. A workout naming kit the athlete doesn't own is worse than no
// workout at all: it reads as authoritative and can't be performed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppFunctions } from './_load-app.mjs';

const { normalizeResistanceWorkout } = loadAppFunctions(
  ['normalizeResistanceWorkout'],
  ['BAND_INVENTORY', 'BAND_IDS', 'BAND_CHOKES', 'BAND_ANCHORS', 'ANCHOR_IDS'],
);

const ex = (over = {}) => ({
  name: 'Seated row', sets: 3, reps: '12-15',
  band: 'black', choke: 'full', anchor: 'feet-seated', rir: 2,
  tempo: '3s down', cue: 'Ribs down.', ...over,
});

test('a well-formed exercise survives untouched', () => {
  const w = normalizeResistanceWorkout({ name: 'A', exercises: [ex()] }, 0);
  assert.deepEqual(w.exercises[0], {
    name: 'Seated row', sets: 3, reps: '12-15', band: 'black',
    choke: 'full', anchor: 'feet-seated', rir: 2, tempo: '3s down', cue: 'Ribs down.',
  });
});

test('every band the athlete owns is accepted', () => {
  for (const id of ['yellow', 'red', 'black', 'purple', 'green']) {
    const w = normalizeResistanceWorkout({ exercises: [ex({ band: id })] }, 0);
    assert.equal(w.exercises[0].band, id, `${id} should round-trip`);
  }
});

test('a band that is not in the kit falls back to the LIGHTEST, not the middle', () => {
  // The old schema coerced anything unknown to 'Medium'. Guessing heavy on a
  // detrained shoulder costs weeks; guessing light costs one wasted set.
  for (const bad of ['Medium', 'Heavy', 'blue', '', null, undefined, 42]) {
    const w = normalizeResistanceWorkout({ exercises: [ex({ band: bad })] }, 0);
    assert.equal(w.exercises[0].band, 'yellow');
  }
});

test('an anchor the athlete cannot rig falls back to none', () => {
  // There is no door anchor and no pull-up bar — a prescription that assumes one
  // is unperformable, so it must degrade to something doable rather than persist.
  for (const bad of ['door', 'pull-up-bar', 'ceiling', '', null]) {
    const w = normalizeResistanceWorkout({ exercises: [ex({ anchor: bad })] }, 0);
    assert.equal(w.exercises[0].anchor, 'none');
  }
  const ok = normalizeResistanceWorkout({ exercises: [ex({ anchor: 'peloton-high' })] }, 0);
  assert.equal(ok.exercises[0].anchor, 'peloton-high');
});

test('choke is constrained to the three real options', () => {
  assert.equal(normalizeResistanceWorkout({ exercises: [ex({ choke: 'doubled' })] }, 0).exercises[0].choke, 'doubled');
  assert.equal(normalizeResistanceWorkout({ exercises: [ex({ choke: 'triple' })] }, 0).exercises[0].choke, 'full');
});

test('RIR is clamped to 0-5 and defaults to 2', () => {
  assert.equal(normalizeResistanceWorkout({ exercises: [ex({ rir: 9 })] }, 0).exercises[0].rir, 5);
  assert.equal(normalizeResistanceWorkout({ exercises: [ex({ rir: -3 })] }, 0).exercises[0].rir, 0);
  assert.equal(normalizeResistanceWorkout({ exercises: [ex({ rir: 0 })] }, 0).exercises[0].rir, 0);
  assert.equal(normalizeResistanceWorkout({ exercises: [ex({ rir: 'hard' })] }, 0).exercises[0].rir, 2);
  assert.equal(normalizeResistanceWorkout({ exercises: [ex({ rir: 2.4 })] }, 0).exercises[0].rir, 2);
});

test('a workout with no exercises still normalizes rather than throwing', () => {
  const w = normalizeResistanceWorkout({ name: 'Empty' }, 0);
  assert.deepEqual(w.exercises, []);
  assert.equal(w.name, 'Empty');
});

test('missing fields get sane defaults instead of undefined', () => {
  const w = normalizeResistanceWorkout({ exercises: [{ name: 'Pull-apart' }] }, 0);
  const e = w.exercises[0];
  assert.equal(e.band, 'yellow');
  assert.equal(e.choke, 'full');
  assert.equal(e.anchor, 'none');
  assert.equal(e.rir, 2);
  assert.equal(e.tempo, '');
  assert.equal(e.cue, '');
});

test('duration falls back to a rough estimate from the exercise count', () => {
  const w = normalizeResistanceWorkout({ exercises: [ex(), ex(), ex()] }, 0);
  assert.equal(w.duration, 12);
});

test('long strings are truncated so a bad block cannot bloat the synced blob', () => {
  const w = normalizeResistanceWorkout({
    name: 'n'.repeat(500),
    focus: 'f'.repeat(500),
    exercises: [ex({ name: 'x'.repeat(500), cue: 'c'.repeat(500), tempo: 't'.repeat(500) })],
  }, 0);
  assert.equal(w.name.length, 80);
  assert.equal(w.focus.length, 240);
  assert.equal(w.exercises[0].name.length, 80);
  assert.equal(w.exercises[0].cue.length, 200);
  assert.equal(w.exercises[0].tempo.length, 20);
});
