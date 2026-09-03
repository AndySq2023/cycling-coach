// Vercel serverless function — port of proxy/server.js (localhost:3002/api/strava).
// Calls the Strava REST API with a refresh-token flow and returns the same JSON
// shape the app expects. Credentials come from env vars (STRAVA_REFRESH_TOKEN seed),
// with the rotated token persisted at KV 'strava_refresh_token'.
import { requireAuth } from './_auth.js';
import { kvGet, kvSet, cached } from './_kv.js';
// Response shaping is shared with the local proxy — see shared/strava-core.js.
// This file owns ONLY credential handling (KV/env) and the HTTP surface.
import { buildStravaSummary } from '../shared/strava-core.js';

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const TOKEN_KEY = 'strava_refresh_token';

async function getAccessToken() {
  const client_id = process.env.STRAVA_CLIENT_ID;
  const client_secret = process.env.STRAVA_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    throw new Error('Missing Strava credentials — set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.');
  }

  const refresh_token = (await kvGet(TOKEN_KEY)) || process.env.STRAVA_REFRESH_TOKEN;
  if (!refresh_token) throw new Error('Missing STRAVA_REFRESH_TOKEN.');

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const tok = await res.json();
  if (tok.refresh_token && tok.refresh_token !== refresh_token) {
    await kvSet(TOKEN_KEY, tok.refresh_token);
  }
  return tok.access_token;
}

// How long a built summary stays warm. Rides don't appear on Strava the instant you
// stop pedalling, so a few minutes costs nothing in freshness and removes the repeated
// 90-day refetch on every app load / sync tap / briefing.
const SUMMARY_TTL_S = 180;

// Cached entry point — what every caller should use. `force` (the app's explicit
// "⚡ Sync" and ?fresh=1) skips the cache read and rebuilds.
export async function getStravaSummary(force = false) {
  return cached('strava_sum', SUMMARY_TTL_S, async () => buildStravaSummary(await getAccessToken()), force);
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await getStravaSummary(req.query?.fresh === '1'));
  } catch (err) {
    // { error } over HTTP 200 so the existing handler surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
