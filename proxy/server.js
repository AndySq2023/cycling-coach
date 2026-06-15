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
    name: a.name || 'Ride',
    date: String(a.start_date_local || a.start_date || '').slice(0, 10),
    distance_km: a.distance != null ? +(a.distance / 1000).toFixed(1) : null,
    moving_time_min: a.moving_time != null ? Math.round(a.moving_time / 60) : null,
    moving_time_s: num(a.moving_time),
    elevation_m: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null,
    avg_speed_kph: a.average_speed != null ? +(a.average_speed * 3.6).toFixed(1) : null,
    avg_watts: num(a.average_watts),
    suffer_score: num(a.suffer_score),
    sport_type: a.sport_type || a.type || '',
  };
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

  const strip = ({ moving_time_s, sport_type, ...keep }) => keep;
  return {
    last_ride: rides.length ? strip(rides[0]) : null,
    rides_7d: rides.length,
    total_km_7d: +totalKm.toFixed(1),
    total_elevation_7d: Math.round(totalElev),
    total_moving_time_h_7d: +totalH.toFixed(1),
    all_rides: rides.map(strip),
  };
}

// ── HTTP server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

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
  console.log(`  GET /api/health  → status`);
});
