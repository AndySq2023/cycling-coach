#!/usr/bin/env node

// Strava proxy for cycling-coach.html
// Calls the Strava REST API directly using your own Strava API application
// credentials (refresh-token flow) and exposes GET /api/strava in the JSON
// shape the app expects. No external dependencies.
//
// Usage: npm start
// Credentials: ~/.strava-proxy/auth.json  { client_id, client_secret, refresh_token }
// The refresh token is rotated by Strava on each refresh and persisted back.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 3002;

// ── Credential persistence ─────────────────────────────────
const AUTH_DIR = path.join(os.homedir(), '.strava-proxy');
fs.mkdirSync(AUTH_DIR, { recursive: true });
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return {}; }
}
function writeAuth(patch) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ ...readAuth(), ...patch }, null, 2));
}

// ── Access token (refresh flow, cached until expiry) ──────
let accessToken = null;
let accessTokenExpiry = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry - 60000) return accessToken;

  const { client_id, client_secret, refresh_token } = readAuth();
  if (!client_id || !client_secret || !refresh_token) {
    throw new Error(`Missing credentials in ${AUTH_FILE} — needs client_id, client_secret, refresh_token`);
  }

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const tok = await res.json();
  accessToken = tok.access_token;
  accessTokenExpiry = (tok.expires_at || 0) * 1000;
  // Strava rotates refresh tokens — persist the new one or the next refresh fails.
  if (tok.refresh_token && tok.refresh_token !== refresh_token) {
    writeAuth({ refresh_token: tok.refresh_token });
  }
  return accessToken;
}

// ── Activity fetch + summary ───────────────────────────────
function num(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function normalizeActivity(a) {
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
    sport_type: a.sport_type || a.type || '',
  };
}

// Compact per-segment lap comparison for one activity. Segments the rider hit
// 2+ times in the ride ARE the laps (park loops) — Strava's own lap array is
// usually a single entry unless the lap button was pressed.
function buildRideDetail(a) {
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

async function getRideDetail(token, activityId) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${activityId}?include_all_efforts=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava activity detail error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return buildRideDetail(await res.json());
}

async function getStravaSummary() {
  const token = await getAccessToken();
  const after = Math.floor((Date.now() - 7 * 86400000) / 1000);
  const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const activities = await res.json();

  const rides = activities
    .map(normalizeActivity)
    .filter(a => /ride/i.test(a.sport_type))
    .sort((x, y) => y.date.localeCompare(x.date));

  const totalKm = rides.reduce((s, r) => s + (r.distance_km || 0), 0);
  const totalElev = rides.reduce((s, r) => s + (r.elevation_m || 0), 0);
  const totalH = rides.reduce((s, r) => s + (r.moving_time_s || 0), 0) / 3600;

  // Segment-level detail for the most recent ride only (one extra API call);
  // a failure here must not take down the whole summary.
  let last_ride_detail = null;
  if (rides.length && rides[0].id != null) {
    try {
      last_ride_detail = await getRideDetail(token, rides[0].id);
    } catch (err) {
      console.error('Strava ride detail failed:', err.message);
    }
  }

  const strip = ({ id, moving_time_s, sport_type, ...keep }) => keep;
  return {
    last_ride: rides.length ? strip(rides[0]) : null,
    last_ride_detail,
    rides_7d: rides.length,
    total_km_7d: +totalKm.toFixed(1),
    total_elevation_7d: Math.round(totalElev),
    total_moving_time_h_7d: +totalH.toFixed(1),
    all_rides: rides.map(strip),
  };
}

// ── Windy point forecast (for ride-planning weather) ──────
// Key: WINDY_API_KEY env var, or windy_key in ~/.strava-proxy/auth.json.
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function windDir(u, v) {
  const deg = (Math.atan2(u, v) * 180 / Math.PI + 180) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}
const wround = (n, d = 0) => (n == null || !Number.isFinite(n)) ? null : +n.toFixed(d);

async function getForecast(lat, lon) {
  const key = process.env.WINDY_API_KEY || readAuth().windy_key;
  if (!key) throw new Error('Missing Windy key — set WINDY_API_KEY or add "windy_key" to ~/.strava-proxy/auth.json');

  const res = await fetch('https://api.windy.com/api/point-forecast/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat, lon, model: 'gfs',
      parameters: ['wind', 'windGust', 'temp', 'precip'],
      levels: ['surface'], key,
    }),
  });
  if (!res.ok) throw new Error(`Windy API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();

  const ts = d.ts || [];
  const U = d['wind_u-surface'] || [], V = d['wind_v-surface'] || [];
  const G = d['gust-surface'] || [], T = d['temp-surface'] || [], P = d['past3hprecip-surface'] || [];
  if (!ts.length) throw new Error('Windy returned no forecast timesteps.');

  const HOURS_AHEAD = 48;
  const now = Date.now(), horizon = now + HOURS_AHEAD * 3600000;
  const hourly = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < now - 3600000 || ts[i] > horizon) continue;
    const u = U[i], v = V[i];
    const speed = (u != null && v != null) ? Math.hypot(u, v) : null;
    hourly.push({
      time: new Date(ts[i]).toISOString(),
      temp_c: wround(T[i] != null ? T[i] - 273.15 : null, 1),
      wind_kph: wround(speed != null ? speed * 3.6 : null),
      gust_kph: wround(G[i] != null ? G[i] * 3.6 : null),
      wind_dir: (u != null && v != null) ? windDir(u, v) : null,
      precip_mm: wround(P[i], 1),
    });
  }
  if (!hourly.length) throw new Error('No forecast points within the next 48h.');

  const nums = (arr) => arr.filter(n => n != null && Number.isFinite(n));
  const winds = nums(hourly.map(h => h.wind_kph)), gusts = nums(hourly.map(h => h.gust_kph));
  const temps = nums(hourly.map(h => h.temp_c));
  const precipTotal = nums(hourly.map(h => h.precip_mm)).reduce((s, n) => s + n, 0);
  return {
    location: { lat: wround(lat, 3), lon: wround(lon, 3) }, model: 'gfs',
    now: hourly[0], hourly,
    summary: {
      hours: HOURS_AHEAD,
      wind_kph_min: winds.length ? Math.min(...winds) : null,
      wind_kph_max: winds.length ? Math.max(...winds) : null,
      gust_kph_max: gusts.length ? Math.max(...gusts) : null,
      temp_c_min: temps.length ? Math.min(...temps) : null,
      temp_c_max: temps.length ? Math.max(...temps) : null,
      precip_mm_total: wround(precipTotal, 1),
    },
  };
}

// ── HTTP server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/api/windy') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        res.end(JSON.stringify({ error: 'Missing or invalid lat/lon.' }));
        return;
      }
      res.end(JSON.stringify(await getForecast(lat, lon)));
    } catch (err) {
      console.error('GET /api/windy failed:', err.message);
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
    return;
  }

  if (url.pathname === '/api/strava') {
    res.setHeader('Content-Type', 'application/json');
    try {
      res.end(JSON.stringify(await getStravaSummary()));
    } catch (err) {
      console.error('GET /api/strava failed:', err.message);
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
    return;
  }

  if (url.pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    const auth = readAuth();
    res.end(JSON.stringify({ ok: true, credentials: !!(auth.client_id && auth.refresh_token) }));
    return;
  }

  res.statusCode = 404;
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Strava proxy listening on http://localhost:${PORT}`);
  console.log(`  GET /api/strava  → 7-day ride summary for cycling-coach.html`);
  console.log(`  GET /api/windy   → 48h point forecast (?lat=&lon=)`);
  console.log(`  GET /api/health  → status`);
});
