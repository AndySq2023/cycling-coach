// Strava response shaping — the single source of truth, imported by BOTH backends:
//   api/strava.js    (hosted, Vercel; tokens from KV/env)
//   proxy/server.js  (local launchd proxy; tokens from ~/.strava-proxy/auth.json)
//
// These two used to carry byte-identical copies of every function below (~150 lines),
// with only the credential lookup differing. That is the split this module removes:
// each caller now owns ONLY its own token acquisition and passes the access token in.
// If you change the shape the app consumes, you change it here, once.
//
// Everything is pure over Strava's API payloads plus a bearer token — no env vars, no
// filesystem, no KV — so it runs unchanged in both environments.

export const STRAVA_ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';

// 90 days of history feeds the dashboard charts (the London→Brighton readiness cards
// look back 12 weeks). The prompt-facing fields below stay 7-day so the system prompt
// doesn't grow with the wider fetch.
export const HISTORY_DAYS = 90;

export function num(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

export function normalizeActivity(a) {
  return {
    id: a.id,
    name: a.name || 'Ride',
    date: String(a.start_date_local || a.start_date || '').slice(0, 10),
    distance_km: a.distance != null ? +(a.distance / 1000).toFixed(1) : null,
    moving_time_min: a.moving_time != null ? Math.round(a.moving_time / 60) : null,
    moving_time_s: num(a.moving_time),
    elevation_m: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null,
    avg_speed_kph: a.average_speed != null ? +(a.average_speed * 3.6).toFixed(1) : null,
    avg_hr: a.average_heartrate != null ? Math.round(a.average_heartrate) : null,
    max_hr: a.max_heartrate != null ? Math.round(a.max_heartrate) : null,
    suffer_score: num(a.suffer_score),
    // Power, ONLY from a real power meter. Strava also estimates watts (and kJ) from
    // speed/gradient for every ride, but those read ~50W low and aren't comparable
    // with metered rides — so they're dropped here rather than gated downstream.
    // Non-null watts therefore means "measured"; the history simply starts at the
    // first metered ride (2026-09-03).
    ...(a.device_watts === true ? {
      avg_watts: num(a.average_watts),
      weighted_avg_watts: num(a.weighted_average_watts),
      max_watts: num(a.max_watts),
      kilojoules: num(a.kilojoules),
    } : { avg_watts: null, weighted_avg_watts: null, max_watts: null, kilojoules: null }),
    sport_type: a.sport_type || a.type || '',
  };
}

// Compact per-segment lap comparison for one activity. Segments the rider hit
// 2+ times in the ride ARE the laps (park loops) — Strava's own lap array is
// usually a single entry unless the lap button was pressed.
export function buildRideDetail(a) {
  const hr = (v) => (v != null && Number.isFinite(v)) ? Math.round(v) : null;
  const secs = (e) => num(e.moving_time, e.elapsed_time);

  const laps = (a.laps || []).length > 1
    ? a.laps.map((l, i) => ({
        lap: i + 1,
        distance_km: l.distance != null ? +(l.distance / 1000).toFixed(1) : null,
        time_s: secs(l),
        avg_hr: hr(l.average_heartrate),
        max_hr: hr(l.max_heartrate),
      }))
    : [];

  const bySeg = new Map();
  for (const e of a.segment_efforts || []) {
    const id = e.segment?.id;
    if (id == null) continue;
    if (!bySeg.has(id)) bySeg.set(id, []);
    bySeg.get(id).push(e);
  }
  // Overlapping segment definitions abound (a park loop has ~10 "full lap"
  // variants) — after sorting by length, only keep a segment if it's meaningfully
  // shorter (<80%) than the last one kept, so the list spans lap → climbs.
  const candidates = [...bySeg.values()]
    .filter(v => v.length >= 2 && (v[0].distance || 0) >= 400)
    .sort((x, y) => (y[0].distance || 0) - (x[0].distance || 0));
  const kept = [];
  for (const v of candidates) {
    if (kept.length >= 10) break;
    const last = kept[kept.length - 1];
    if (!last || (v[0].distance || 0) < 0.8 * (last[0].distance || 0)) kept.push(v);
  }
  const repeated_segments = kept
    .map(v => ({
      name: v[0].name || v[0].segment?.name || 'segment',
      distance_km: +((v[0].distance || 0) / 1000).toFixed(1),
      efforts: v
        .sort((x, y) => (x.start_index ?? 0) - (y.start_index ?? 0))
        .map(e => ({ time_s: secs(e), avg_hr: hr(e.average_heartrate) })),
    }));

  return {
    avg_hr: hr(a.average_heartrate),
    max_hr: hr(a.max_heartrate),
    laps,
    repeated_segments,
  };
}

export async function getRideDetail(token, activityId) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}?include_all_efforts=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava activity detail error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return buildRideDetail(await res.json());
}

// Fetch + shape the whole summary for an already-authenticated athlete. Callers supply
// the access token (that is the ONLY thing that differs between the hosted function and
// the local proxy).
export async function buildStravaSummary(token) {
  const after = Math.floor((Date.now() - HISTORY_DAYS * 86400000) / 1000);
  let activities = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`${STRAVA_ACTIVITIES_URL}?after=${after}&per_page=200&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Strava API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const batch = await res.json();
    activities = activities.concat(batch);
    if (batch.length < 200) break;
  }

  const rides = activities
    .map(normalizeActivity)
    .filter(a => /ride/i.test(a.sport_type))
    .sort((x, y) => y.date.localeCompare(x.date));

  const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const rides7 = rides.filter(r => r.date >= sevenAgo);

  const totalKm = rides7.reduce((s, r) => s + (r.distance_km || 0), 0);
  const totalElev = rides7.reduce((s, r) => s + (r.elevation_m || 0), 0);
  const totalH = rides7.reduce((s, r) => s + (r.moving_time_s || 0), 0) / 3600;

  // Segment-level detail for the most recent ride only (one extra API call);
  // a failure here must not take down the whole summary.
  let last_ride_detail = null;
  if (rides7.length && rides7[0].id != null) {
    try {
      last_ride_detail = await getRideDetail(token, rides7[0].id);
    } catch (err) {
      console.error('Strava ride detail failed:', err.message);
    }
  }

  const strip = ({ id, moving_time_s, sport_type, ...keep }) => keep;
  // Chart-only series, oldest → newest. Never inject this into a prompt.
  const lean = ({ date, distance_km, moving_time_min, elevation_m, avg_speed_kph, avg_hr, max_hr, suffer_score,
                 avg_watts, weighted_avg_watts, max_watts, kilojoules }) =>
    ({ date, distance_km, moving_time_min, elevation_m, avg_speed_kph, avg_hr, max_hr, suffer_score,
       avg_watts, weighted_avg_watts, max_watts, kilojoules });
  return {
    last_ride: rides7.length ? strip(rides7[0]) : null,
    last_ride_detail,
    rides_7d: rides7.length,
    total_km_7d: +totalKm.toFixed(1),
    total_elevation_7d: Math.round(totalElev),
    total_moving_time_h_7d: +totalH.toFixed(1),
    all_rides: rides7.map(strip),
    history_days: HISTORY_DAYS,
    history: [...rides].reverse().map(lean),
  };
}
