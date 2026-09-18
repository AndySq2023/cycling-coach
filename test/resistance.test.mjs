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
  assert.equal(w.exercises[0].tempo.length, 40);
});


// The starting programme is data, not code, so what's worth pinning down is that it
// only ever names kit that exists. A typo'd band id degrades silently to yellow and
// nobody notices until a session feels far too easy; a bad anchor degrades to "none",
// which turns a lat pulldown into a movement you can't perform at all.
const { STARTER_PROGRAMME, BAND_IDS, ANCHOR_IDS } = loadAppFunctions(
  [], ['STARTER_PROGRAMME', 'BAND_INVENTORY', 'BAND_IDS', 'BAND_CHOKES', 'BAND_ANCHORS', 'ANCHOR_IDS'],
);

test('the starter programme is two sessions of 45 minutes', () => {
  assert.equal(STARTER_PROGRAMME.length, 2);
  STARTER_PROGRAMME.forEach(w => {
    assert.equal(w.duration, 45);
    assert.equal(w.category, 'upper');
    assert.ok(w.exercises.length >= 6, `${w.name} should be a full session`);
  });
});

test('every prescribed band and anchor actually exists', () => {
  STARTER_PROGRAMME.forEach(w => w.exercises.forEach(ex => {
    assert.ok(BAND_IDS.includes(ex.band), `${w.name} / ${ex.name}: unknown band "${ex.band}"`);
    assert.ok(ANCHOR_IDS.includes(ex.anchor), `${w.name} / ${ex.name}: unknown anchor "${ex.anchor}"`);
  }));
});

test('the programme survives the normalizer unchanged', () => {
  // If normalization alters anything, the prescription as written isn't the
  // prescription that gets saved — which is exactly the silent-degradation bug.
  STARTER_PROGRAMME.forEach((w, i) => {
    const out = normalizeResistanceWorkout(w, i);
    w.exercises.forEach((ex, j) => {
      assert.equal(out.exercises[j].band, ex.band);
      assert.equal(out.exercises[j].anchor, ex.anchor);
      assert.equal(out.exercises[j].choke, ex.choke);
      assert.equal(out.exercises[j].rir, ex.rir);
      assert.equal(out.exercises[j].name, ex.name, 'name should not be truncated');
      assert.equal(out.exercises[j].cue, ex.cue, 'cue should not be truncated');
      assert.equal(out.exercises[j].tempo, ex.tempo, 'tempo should not be truncated');
    });
  });
});

test('both sessions train the whole upper body, not a push/pull split', () => {
  // Two sessions a week means each muscle needs to appear in BOTH, or it gets one
  // exposure a week — not enough to hold mass in a deficit. This is the single
  // design decision most likely to get "tidied" into a split later.
  const groups = {
    pull:    /row|pulldown|pullover|pull-apart|face pull/i,
    press:   /press-up|chest press|overhead press/i,
    delts:   /lateral raise|face pull|overhead press/i,
    arms:    /curl|triceps/i,
    core:    /pallof|dead bug|crunch|side plank/i,
  };
  STARTER_PROGRAMME.forEach(w => {
    const names = w.exercises.map(e => e.name).join(' | ');
    Object.entries(groups).forEach(([group, re]) => {
      assert.ok(re.test(names), `${w.name} has no ${group} work`);
    });
  });
});

test('no session prescribes a band heavier than purple for an isolation move', () => {
  // Green (22-56kg) on a lateral raise isn't a lateral raise any more. Guards the
  // one place a well-meaning progression could quietly break the exercise.
  const isolation = /lateral raise|curl|pull-apart|dead bug/i;
  STARTER_PROGRAMME.forEach(w => w.exercises.filter(e => isolation.test(e.name)).forEach(ex => {
    assert.ok(['yellow', 'red'].includes(ex.band), `${ex.name} on ${ex.band} is too heavy to be that exercise`);
  }));
});
