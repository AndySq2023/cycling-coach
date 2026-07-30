// Vercel serverless function — weather forecast for ride planning.
// Proxies the Windy Point Forecast API (https://api.windy.com/api/point-forecast/v2)
// so the WINDY_API_KEY stays server-side and CORS is never an issue.
//
// Request:  GET /api/windy?lat=<deg>&lon=<deg>   (behind the x-app-password gate)
// Response: compact, ride-relevant forecast JSON the app injects into the coach prompt.
//
// Env: WINDY_API_KEY (set in the Vercel project env vars). Same APP_PASSWORD gate as
// the other functions, so this can't be left open to the public by accident.
import { requireUser } from './_auth.js';
import { buildForecast } from '../shared/weather-core.js';

// Forecast shaping is shared with the local proxy — see shared/weather-core.js.
// This file owns ONLY the API key and the HTTP surface.
export async function getForecast(lat, lon) {
  const key = process.env.WINDY_API_KEY;
  if (!key) throw new Error('Missing WINDY_API_KEY — set it in the Vercel project env vars.');
  return buildForecast(lat, lon, key);
}

export default async function handler(req, res) {
  if (!(await requireUser(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const lat = parseFloat(req.query?.lat);
    const lon = parseFloat(req.query?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(200).json({ error: 'Missing or invalid lat/lon.' });
    }
    res.status(200).json(await getForecast(lat, lon));
  } catch (err) {
    // Return { error } (HTTP 200) so the app's existing handler surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
