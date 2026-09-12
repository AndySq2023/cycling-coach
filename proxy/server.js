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
// Response shaping is shared with the hosted functions — see shared/*-core.js.
// This file owns ONLY credential handling (~/.strava-proxy/auth.json) and the HTTP surface.
import { buildStravaSummary } from '../shared/strava-core.js';
import { buildForecast } from '../shared/weather-core.js';
import { buildIntervalsSummary } from '../shared/intervals-core.js';

const PORT = Number(process.env.PORT) || 3002; // env override lets a second copy run for testing

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
// Shaping lives in shared/strava-core.js; here we just supply the access token.
async function getStravaSummary() {
  return buildStravaSummary(await getAccessToken());
}

// ── Weather forecast (Open-Meteo, for ride planning) ──────
// No API key required.
async function getForecast(lat, lon) {
  return buildForecast(lat, lon);
}

// ── HTTP server ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/api/weather') {
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
      console.error('GET /api/weather failed:', err.message);
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

  // intervals.icu needs no OAuth — just the athlete id and a read-only API key.
  // Taken from auth.json (intervals_athlete_id / intervals_api_key) so local dev
  // needs no launchd env-var edit, with env vars as an override.
  if (url.pathname === '/api/intervals') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const auth = readAuth();
      const athleteId = process.env.INTERVALS_ATHLETE_ID || auth.intervals_athlete_id;
      const apiKey = process.env.INTERVALS_API_KEY || auth.intervals_api_key;
      if (!athleteId || !apiKey) {
        throw new Error('Missing intervals.icu credentials — add intervals_athlete_id and intervals_api_key to ~/.strava-proxy/auth.json.');
      }
      res.end(JSON.stringify(await buildIntervalsSummary(athleteId, apiKey)));
    } catch (err) {
      console.error('GET /api/intervals failed:', err.message);
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
  console.log(`  GET /api/weather → 48h point forecast (?lat=&lon=)`);
  console.log(`  GET /api/intervals → intervals.icu fitness/power summary`);
  console.log(`  GET /api/health  → status`);
});
