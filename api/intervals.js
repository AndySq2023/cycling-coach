// Vercel serverless function — intervals.icu fitness/power summary.
//
// Mirrors api/strava.js, but much thinner: intervals.icu authenticates with plain
// HTTP Basic ("API_KEY" as the username, the athlete's key as the password), so
// there is no OAuth dance, no rotating refresh token and no KV write path. KV is
// used only as a read-through cache, and the endpoint works without it.
//
// Response shaping lives in shared/intervals-core.js so the local proxy serves the
// identical payload — this file owns ONLY credentials and the HTTP surface.
import { requireAuth } from './_auth.js';
import { cached } from './_kv.js';
import { buildIntervalsSummary } from '../shared/intervals-core.js';

// CTL/ATL move once a day and the power curve is a 90-day window, so a 10-minute
// cache is generous freshness. Strava's is 180s because rides land continuously.
const SUMMARY_TTL_S = 600;

export async function getIntervalsSummary(force = false) {
  const athleteId = process.env.INTERVALS_ATHLETE_ID;
  const apiKey = process.env.INTERVALS_API_KEY;
  if (!athleteId || !apiKey) {
    throw new Error('Missing intervals.icu credentials — set INTERVALS_ATHLETE_ID and INTERVALS_API_KEY.');
  }
  return cached('intervals_sum', SUMMARY_TTL_S, () => buildIntervalsSummary(athleteId, apiKey), force);
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.status(200).json(await getIntervalsSummary(req.query?.fresh === '1'));
  } catch (err) {
    // { error } over HTTP 200 so the app's existing error path surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
