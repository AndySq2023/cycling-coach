// Vercel serverless function — port of proxy/server.js (localhost:3002/api/strava).
// Calls the Strava REST API with a refresh-token flow and returns the same JSON
// shape the app expects. Multi-user:
//   master  → credentials from env vars (STRAVA_REFRESH_TOKEN seed, rotated token
//             persisted at KV 'strava_refresh_token' — the original single-user path)
//   members → per-user tokens at KV 'strava_tokens:<userId>', created by the
//             OAuth connect flow in api/oauth.js. Not connected → { not_connected }.
// All users share the one Strava API application (STRAVA_CLIENT_ID/SECRET) — note
// Strava caps an app at 1 connected athlete until you request a capacity increase.
import { requireUser } from './_auth.js';
import { kvGet, kvSet, cached } from './_kv.js';
// Response shaping is shared with the local proxy — see shared/strava-core.js.
// This file owns ONLY credential handling (KV/env) and the HTTP surface.
import { buildStravaSummary } from '../shared/strava-core.js';

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

function notConnectedError(msg) {
  const e = new Error(msg);
  e.notConnected = true;
  return e;
}

async function getAccessToken(userId = 'master') {
  const client_id = process.env.STRAVA_CLIENT_ID;
  const client_secret = process.env.STRAVA_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    throw new Error('Missing Strava credentials — set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.');
  }

  let refresh_token;
  const tokenKey = userId === 'master' ? 'strava_refresh_token' : `strava_tokens:${userId}`;
  if (userId === 'master') {
    refresh_token = (await kvGet(tokenKey)) || process.env.STRAVA_REFRESH_TOKEN;
    if (!refresh_token) throw new Error('Missing STRAVA_REFRESH_TOKEN for the master account.');
  } else {
    const stored = await kvGet(tokenKey);
    refresh_token = stored?.refresh_token;
    if (!refresh_token) throw notConnectedError('Strava not connected for this athlete yet.');
  }

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const tok = await res.json();
  if (tok.refresh_token && tok.refresh_token !== refresh_token) {
    // Master's key stores the bare token (legacy shape); member keys store an object.
    await kvSet(tokenKey, userId === 'master' ? tok.refresh_token : { refresh_token: tok.refresh_token });
  }
  return tok.access_token;
}

// How long a built summary stays warm. Rides don't appear on Strava the instant you
// stop pedalling, so a few minutes costs nothing in freshness and removes the repeated
// 90-day refetch on every app load / sync tap / briefing.
const SUMMARY_TTL_S = 180;

// Cached entry point — what every caller should use. `force` (the app's explicit
// "⚡ Sync" and ?fresh=1) skips the cache read and rebuilds.
export async function getStravaSummary(userId = 'master', force = false) {
  return cached(`strava_sum:${userId}`, SUMMARY_TTL_S, () => fetchStravaSummary(userId), force);
}

async function fetchStravaSummary(userId = 'master') {
  return buildStravaSummary(await getAccessToken(userId));
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await getStravaSummary(user.id, req.query?.fresh === '1'));
  } catch (err) {
    // { not_connected } tells the app to show the Connect button instead of an error;
    // otherwise return { error } (HTTP 200) so the existing handler surfaces it cleanly.
    if (err?.notConnected) {
      res.status(200).json({ not_connected: 'strava', error: err.message });
      return;
    }
    res.status(200).json({ error: err?.message || String(err) });
  }
}
