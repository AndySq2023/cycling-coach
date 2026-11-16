// The coach-data allowlist: only named fields get through, nested objects are never
// spread, and history is capped at 12 weeks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppFunctions } from './_load-app.mjs';

const { pickAllowed, describeAllowlist, COACH_DATA_ALLOWLIST: A } = loadAppFunctions(
  ['pickAllowed', 'describeAllowlist'], ['COACH_WINDOW_DAYS', 'RIDE_FIELDS', 'COACH_DATA_ALLOWLIST']);
const TODAY = '2026-11-16';

test('unknown top-level fields do not get through', () => {
  const w = pickAllowed(A.whoop, { recovery_score: 41, hrv: 47, access_token: 'secret', user: { email: 'x@y' }, spo2: 96 }, TODAY);
  assert.deepEqual(w, { recovery_score: 41, hrv: 47 });
});

test('an object where a leaf is expected is dropped, never spread', () => {
  assert.deepEqual(pickAllowed(A.whoop, { hrv: { raw: [1, 2, 3] } }, TODAY), {});
});

test('nested and array fields are filtered item by item', () => {
  const s = pickAllowed(A.strava, {
    rides_7d: 2,
    last_ride: { name: 'Loop', date: '2026-11-15', id: 99, polyline: 'abc', avg_hr: 140 },
    all_rides: [{ name: 'Loop', date: '2026-11-15', id: 99, map: { x: 1 } }],
    raw: { anything: true },
  }, TODAY);
  assert.deepEqual(s, { rides_7d: 2, last_ride: { name: 'Loop', date: '2026-11-15', avg_hr: 140 }, all_rides: [{ name: 'Loop', date: '2026-11-15' }] });
});

test('history is capped at 12 weeks', () => {
  const history = [
    { date: '2026-08-01', avg_watts: 200 }, // > 84 days ago
    { date: '2026-08-24', avg_watts: 210 }, // exactly 84 days
    { date: '2026-11-10', avg_watts: 220 },
  ];
  const s = pickAllowed(A.strava, { history }, TODAY);
  assert.deepEqual(s.history.map(r => r.date), ['2026-08-24', '2026-11-10']);
  const w = pickAllowed(A.weight, [{ date: '2026-01-01', kg: 95 }, { date: '2026-11-01', kg: 88, src: 'whoop' }], TODAY);
  assert.deepEqual(w, [{ date: '2026-11-01', kg: 88 }]);
});

test('strength log: last 6 sessions, known fields only', () => {
  const log = Array.from({ length: 9 }, (_, i) => ({ date: `2026-11-0${i + 1}`, name: 'A', secret: 1,
    exercises: [{ name: 'Row', band: 'black', sets: [{ reps: 12, rir: 2, hidden: 1 }], junk: 1 }] }));
  const out = pickAllowed(A.strength, log, TODAY);
  assert.equal(out.length, 6);
  assert.equal(out[0].date, '2026-11-04');
  assert.deepEqual(out[0].exercises, [{ name: 'Row', band: 'black', sets: [{ reps: 12, rir: 2 }] }]);
  assert.equal('secret' in out[0], false);
});

test('coach notes are strings only, capped', () => {
  assert.deepEqual(pickAllowed(A.coachNotes, ['a', { evil: 1 }, 'b'], TODAY), ['a', 'b']);
});

test('missing sources come back undefined, not empty objects', () => {
  assert.equal(pickAllowed(A.whoop, null, TODAY), undefined);
  assert.equal(pickAllowed(A.bodycomp, undefined, TODAY), undefined);
});

test('the My Data list is rendered from the same table', () => {
  const d = describeAllowlist(A);
  assert.deepEqual(d.map(c => c.label), Object.values(A).map(c => c.label));
  assert.ok(d.find(c => c.label === 'WHOOP').fields.includes('HRV'));
});
