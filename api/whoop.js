// Vercel serverless function — hosted port of the local whoop-mcp bridge
// (localhost:3001 /api/whoop). Calls the WHOOP v2 API with a refresh-token flow
// and returns the same JSON shape the app expects. Credentials come from env vars.
//
// IMPORTANT — WHOOP rotates the refresh token on EVERY refresh and immediately
// invalidates the old one. Vercel's filesystem is read-only, so the rotated token
// MUST be persisted in Vercel KV. Unlike Strava, the WHOOP_REFRESH_TOKEN env seed
// is single-use: the first refresh on Vercel burns it, so KV is effectively
// required for this function to keep working past the first request.
import { requirePassword } from './_auth.js';

const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';
const KV_KEY = 'whoop_refresh_token';

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

// Exchange the stored refresh token for a fresh access token, persisting the
// rotated refresh token back to KV. Returns the access token.
async function getAccessToken() {
  const client_id = process.env.WHOOP_CLIENT_ID;
  const client_secret = process.env.WHOOP_CLIENT_SECRET;
  const refresh_token = (await kvGet(KV_KEY)) || process.env.WHOOP_REFRESH_TOKEN;
  if (!client_id || !client_secret || !refresh_token) {
    throw new Error('Missing WHOOP credentials — set WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, and seed the refresh token (Vercel KV key "whoop_refresh_token" or WHOOP_REFRESH_TOKEN).');
  }

  const res = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`WHOOP token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const tok = await res.json();
  // WHOOP rotates the refresh token on every refresh — persist it or the next call fails.
  if (tok.refresh_token) await kvSet(KV_KEY, tok.refresh_token);
  return tok.access_token;
}

async function whoopGet(token, pathAndQuery) {
  const res = await fetch(`${WHOOP_API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`WHOOP API error on ${pathAndQuery} (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function getWhoopSummary() {
  const token = await getAccessToken();
  const [profile, recovery, sleep] = await Promise.all([
    whoopGet(token, '/user/profile/basic'),
    whoopGet(token, '/recovery?limit=1'),
    whoopGet(token, '/activity/sleep?limit=1'),
  ]);

  const rec = recovery.records?.[0]?.score ?? {};
  const slpScore = sleep.records?.[0]?.score ?? {};
  const durationMs = slpScore.stage_summary?.total_in_bed_time_milli ?? null;

  return {
    name: profile.first_name?.trim() ?? null,
    recovery_score: rec.recovery_score ?? null,
    hrv: rec.hrv_rmssd_milli != null ? Math.round(rec.hrv_rmssd_milli) : null,
    rhr: rec.resting_heart_rate ?? null,
    spo2: rec.spo2_percentage != null ? +(+rec.spo2_percentage).toFixed(1) : null,
    sleep_efficiency: slpScore.sleep_efficiency_percentage != null ? Math.round(slpScore.sleep_efficiency_percentage) : null,
    sleep_duration_h: durationMs != null ? +(durationMs / 3600000).toFixed(1) : null,
    strain: rec.strain ?? null,
  };
}

export default async function handler(req, res) {
  if (!requirePassword(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await getWhoopSummary());
  } catch (err) {
    // Return { error } (HTTP 200) so the app's existing handler surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
