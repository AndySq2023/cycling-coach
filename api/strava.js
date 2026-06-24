// Vercel serverless function — port of proxy/server.js (localhost:3002/api/strava).
// Calls the Strava REST API with a refresh-token flow and returns the same JSON
// shape the app expects. Credentials come from env vars (set in Vercel), NOT a file.
//
// Strava can hand back a rotated refresh token. Vercel's filesystem is read-only, so
// if a Vercel KV store is linked (KV_REST_API_URL present) we persist the rotated
// token there; otherwise we fall back to the STRAVA_REFRESH_TOKEN seed (works until
// Strava actually rotates it).
import { requirePassword } from './_auth.js';

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';

async function kvGet(key) {
  if (!process.env.KV_REST_API_URL) return null;
  try { const { kv } = await import('@vercel/kv'); return await kv.get(key); }
  catch { return null; }
}
async function kvSet(key, value) {
  if (!process.env.KV_REST_API_URL) return;
  try { const { kv } = await import('@vercel/kv'); await kv.set(key, value); }
  catch { /* non-fatal: token just won't persist this time */ }
}

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
    suffer_score: num(a.suffer_score),
    sport_type: a.sport_type || a.type || '',
  };
}

async function getAccessToken() {
  const client_id = process.env.STRAVA_CLIENT_ID;
  const client_secret = process.env.STRAVA_CLIENT_SECRET;
  const refresh_token = (await kvGet('strava_refresh_token')) || process.env.STRAVA_REFRESH_TOKEN;
  if (!client_id || !client_secret || !refresh_token) {
    throw new Error('Missing Strava credentials — set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN.');
  }

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const tok = await res.json();
  if (tok.refresh_token && tok.refresh_token !== refresh_token) {
    await kvSet('strava_refresh_token', tok.refresh_token);
  }
  return tok.access_token;
}

async function getStravaSummary() {
  const token = await getAccessToken();
  const after = Math.floor((Date.now() - 7 * 86400000) / 1000);
  const res = await fetch(`${STRAVA_ACTIVITIES_URL}?after=${after}&per_page=50`, {
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

export default async function handler(req, res) {
  if (!requirePassword(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await getStravaSummary());
  } catch (err) {
    // Return { error } (HTTP 200) so the app's existing handler surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
