// shared/strava-core.js is the single source of truth for Strava shaping, imported by
// BOTH api/strava.js (hosted) and proxy/server.js (local) — see that file's header for
// why. A regression here breaks ride data on every surface at once, so it gets its own
// direct tests (no HTML-extraction needed; this file already imports as a real module).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActivity, buildRideDetail } from '../shared/strava-core.js';

test('normalizeActivity: converts units and keeps only the fields the app expects', () => {
  const raw = {
    id: 123, name: 'Evening spin',
    start_date_local: '2026-07-20T18:30:00Z',
    distance: 40234, moving_time: 5400,
    total_elevation_gain: 312.7,
    average_speed: 7.45, average_heartrate: 138.2, max_heartrate: 171,
    suffer_score: 62, sport_type: 'Ride',
  };
  const out = normalizeActivity(raw);
  assert.equal(out.date, '2026-07-20');
  assert.equal(out.distance_km, 40.2);
  assert.equal(out.moving_time_min, 90);
  assert.equal(out.elevation_m, 313);
  assert.equal(out.avg_speed_kph, 26.8);
  assert.equal(out.avg_hr, 138);
  assert.equal(out.max_hr, 171);
  assert.equal(out.suffer_score, 62);
});

test('normalizeActivity: missing optional fields become null, never throw', () => {
  const out = normalizeActivity({ id: 1, sport_type: 'Ride' });
  assert.equal(out.distance_km, null);
  assert.equal(out.avg_hr, null);
  assert.equal(out.suffer_score, null);
  assert.equal(out.name, 'Ride', 'falls back to a default name');
});

test('buildRideDetail: repeated segments (a park loop) become pass-by-pass splits', () => {
  const activity = {
    average_heartrate: 140, max_heartrate: 165,
    laps: [{}], // single lap entry = "lap button never pressed", so laps[] stays empty
    segment_efforts: [
      { segment: { id: 1, name: 'Big Loop' }, distance: 8000, moving_time: 1200, average_heartrate: 138, start_index: 0 },
      { segment: { id: 1, name: 'Big Loop' }, distance: 8000, moving_time: 1150, average_heartrate: 142, start_index: 500 },
      { segment: { id: 2, name: 'Short climb' }, distance: 300, moving_time: 90, average_heartrate: 155, start_index: 100 },
    ],
  };
  const d = buildRideDetail(activity);
  assert.equal(d.laps.length, 0, 'a single-lap array means no manual laps were pressed');
  assert.equal(d.repeated_segments.length, 1, 'the sub-400m segment must be filtered out');
  assert.equal(d.repeated_segments[0].name, 'Big Loop');
  assert.equal(d.repeated_segments[0].efforts.length, 2);
  // efforts ordered by start_index (ride order), not by input order
  assert.equal(d.repeated_segments[0].efforts[0].time_s, 1200);
  assert.equal(d.repeated_segments[0].efforts[1].time_s, 1150);
});

test('buildRideDetail: a ride with no segments at all is handled cleanly', () => {
  const d = buildRideDetail({ average_heartrate: 130, max_heartrate: 160 });
  assert.deepEqual(d.laps, []);
  assert.deepEqual(d.repeated_segments, []);
  assert.equal(d.avg_hr, 130);
});
