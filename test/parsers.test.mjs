// The coach writes to the athlete's training plan, long-term memory and home location
// by emitting fenced JSON blocks that these parsers pull out of its reply. They are the
// highest-consequence pure code in the project: a parser that mis-fires can silently
// rewrite a training week, forget a fact, or leak raw JSON into the chat.
//
// Run: npm test   (node:test, no dependencies — keeps the zero-build promise)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppFunctions } from './_load-app.mjs';

const {
  extractScheduleUpdates, extractCoachNotes, extractRouteRequest,
  extractHomeSet, stripFakeRouteMarkers,
} = loadAppFunctions([
  'extractScheduleUpdates', 'extractCoachNotes', 'extractRouteRequest',
  'extractHomeSet', 'stripFakeRouteMarkers',
]);

test('schedule_update: parses a patch and strips it from what the athlete sees', () => {
  const reply = 'Easing Tuesday back.\n```schedule_update\n{"id":"s3","type":"Rest Day","duration":0}\n```';
  const { clean, updates, planSet } = extractScheduleUpdates(reply);
  assert.equal(clean, 'Easing Tuesday back.');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 's3');
  assert.equal(planSet, null);
});

test('schedule_update: multiple patches in one reply all apply', () => {
  const reply = 'Two changes.\n```schedule_update\n{"id":"s1","duration":45}\n```\n' +
                'And.\n```schedule_update\n{"id":"s2","duration":60}\n```';
  const { updates } = extractScheduleUpdates(reply);
  assert.deepEqual(updates.map(u => u.id), ['s1', 's2']);
});

test('schedule_set: last block wins, and an empty array is ignored', () => {
  const reply = '```schedule_set\n[{"id":"s1","type":"A"}]\n```\n```schedule_set\n[{"id":"s1","type":"B"}]\n```';
  assert.equal(extractScheduleUpdates(reply).planSet[0].type, 'B');
  assert.equal(extractScheduleUpdates('```schedule_set\n[]\n```').planSet, null,
    'an empty plan must not wipe the athlete\'s week');
});

test('malformed JSON is skipped, never thrown — and never shown to the athlete', () => {
  const reply = 'Here you go.\n```schedule_update\n{"id":"s1", oops}\n```';
  const { clean, updates } = extractScheduleUpdates(reply);
  assert.deepEqual(updates, [], 'a broken block must not become a bogus patch');
  assert.equal(clean, 'Here you go.', 'the raw block must still be stripped from the reply');
});

test('coach_notes: adds and removes parse, and merge across blocks', () => {
  const reply = 'Noted.\n```coach_notes\n{"add":["Left knee niggle on long climbs"],"remove":["Old goal"]}\n```';
  const { clean, notes } = extractCoachNotes(reply);
  assert.equal(clean, 'Noted.');
  assert.deepEqual(notes.add, ['Left knee niggle on long climbs']);
  assert.deepEqual(notes.remove, ['Old goal']);

  const two = '```coach_notes\n{"add":["one"]}\n```\ntext\n```coach_notes\n{"add":["two"]}\n```';
  assert.deepEqual(extractCoachNotes(two).notes.add, ['one', 'two']);
});

test('coach_notes: absent block yields null, not an empty write', () => {
  const { notes, clean } = extractCoachNotes('Just a normal reply.');
  assert.equal(notes, null, 'no block must mean "no change", not "clear memory"');
  assert.equal(clean, 'Just a normal reply.');
});

test('route_request: parsed and stripped', () => {
  const reply = 'Here is a loop.\n```route_request\n{"mode":"loop","durationMin":60,"paceMph":15}\n```';
  const { clean, routeRequest } = extractRouteRequest(reply);
  assert.equal(clean, 'Here is a loop.');
  assert.equal(routeRequest.mode, 'loop');
  assert.equal(routeRequest.durationMin, 60);
});

test('home_set: parsed and stripped', () => {
  const reply = 'Setting that now.\n```home_set\n{"place":"SW13, London","lat":51.4713,"lon":-0.2317}\n```';
  const { clean, homeSet } = extractHomeSet(reply);
  assert.equal(clean, 'Setting that now.');
  assert.equal(homeSet.place, 'SW13, London');
});

// The model sometimes imitates the "[Route planned: ...]" result markers it sees in
// replayed history instead of emitting a real route_request — inventing distances and
// leaving the athlete with no GPX. This guard is what stops a fake passing as real.
test('fake route markers are detected and removed', () => {
  const faked = stripFakeRouteMarkers('Nice one. [Route planned: 24.3 mi, 1200 ft]');
  assert.equal(faked.faked, true, 'a claimed route result must be flagged');
  assert.ok(!faked.clean.includes('Route planned'), 'the invented result must not reach the athlete');

  const honest = stripFakeRouteMarkers('Recovery is 62% today, take it steady.');
  assert.equal(honest.faked, false);
  assert.equal(honest.clean, 'Recovery is 62% today, take it steady.');
});

test('a reply with no blocks passes through untouched', () => {
  const plain = 'Recovery is 62% — steady Zone 2 today, 60 minutes.';
  const { clean, updates, planSet } = extractScheduleUpdates(plain);
  assert.equal(clean, plain);
  assert.deepEqual(updates, []);
  assert.equal(planSet, null);
});
