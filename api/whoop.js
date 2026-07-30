// Vercel serverless function — hosted port of the local whoop-mcp bridge
// (localhost:3001 /api/whoop). Calls the WHOOP v2 API with a refresh-token flow
// and returns the same JSON shape the app expects. Multi-user:
//   master  → refresh token at KV 'whoop_refresh_token' (seeded once from the
//             WHOOP_REFRESH_TOKEN env var — the original single-user path)
//   members → per-user tokens at KV 'whoop_tokens:<userId>', created by the
//             OAuth connect flow in api/oauth.js. Not connected → { not_connected }.
//
// IMPORTANT — WHOOP rotates the refresh token on EVERY refresh and immediately
// invalidates the old one. Vercel's filesystem is read-only, so the rotated token
// MUST be persisted in Vercel KV. KV is effectively required for this function.
import { requireUser } from './_auth.js';
import { kvGet, kvSet, cached } from './_kv.js';

const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v2';

function notConnectedError(msg) {
  const e = new Error(msg);
  e.notConnected = true;
  return e;
}

// Exchange the stored refresh token for a fresh access token, persisting the
// rotated refresh token back to KV. Returns the access token.
async function getAccessToken(userId = 'master') {
  const client_id = process.env.WHOOP_CLIENT_ID;
  const client_secret = process.env.WHOOP_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    throw new Error('Missing WHOOP credentials — set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET.');
  }

  let refresh_token;
  const tokenKey = userId === 'master' ? 'whoop_refresh_token' : `whoop_tokens:${userId}`;
  if (userId === 'master') {
    refresh_token = (await kvGet(tokenKey)) || process.env.WHOOP_REFRESH_TOKEN;
    if (!refresh_token) {
      throw new Error('Missing WHOOP refresh token — seed KV key "whoop_refresh_token" or set WHOOP_REFRESH_TOKEN.');
    }
  } else {
    const stored = await kvGet(tokenKey);
    refresh_token = stored?.refresh_token;
    if (!refresh_token) throw notConnectedError('WHOOP not connected for this athlete yet.');
  }

  const res = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' }),
  });
  if (!res.ok) throw new Error(`WHOOP token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);

  const tok = await res.json();
  // WHOOP rotates the refresh token on every refresh — persist it or the next call fails.
  if (tok.refresh_token) {
    // Master's key stores the bare token (legacy shape); member keys store an object.
    await kvSet(tokenKey, userId === 'master' ? tok.refresh_token : { refresh_token: tok.refresh_token });
  }
  return tok.access_token;
}

async function whoopGet(token, pathAndQuery) {
  const res = await fetch(`${WHOOP_API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`WHOOP API error on ${pathAndQuery} (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Recovery/sleep are computed once when you wake, so they barely move during the day —
// but each uncached call is 3 WHOOP requests plus a token refresh. 5 minutes keeps it
// live-feeling while collapsing repeat loads.
const SUMMARY_TTL_S = 300;

// Cached entry point — what every caller should use. `force` skips the cache read.
export async function getWhoopSummary(userId = 'master', force = false) {
  return cached(`whoop_sum:${userId}`, SUMMARY_TTL_S, () => fetchWhoopSummary(userId), force);
}

async function fetchWhoopSummary(userId = 'master') {
  const token = await getAccessToken(userId);
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
  const user = await requireUser(req, res);
  if (!user) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await getWhoopSummary(user.id, req.query?.fresh === '1'));
  } catch (err) {
    // { not_connected } tells the app to show the Connect button instead of an error;
    // otherwise return { error } (HTTP 200) so the existing handler surfaces it cleanly.
    if (err?.notConnected) {
      res.status(200).json({ not_connected: 'whoop', error: err.message });
      return;
    }
    res.status(200).json({ error: err?.message || String(err) });
  }
}
