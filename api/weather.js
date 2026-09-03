// Vercel serverless function — weather forecast for ride planning.
// Proxies the Open-Meteo forecast API (https://open-meteo.com), which is free, keyless,
// and returns real forecast data — unlike the Windy Point Forecast API this replaced,
// whose free tier deliberately randomizes/shuffles its data.
//
// Request:  GET /api/weather?lat=<deg>&lon=<deg>   (behind the x-app-password gate)
// Response: compact, ride-relevant forecast JSON the app injects into the coach prompt.
import { requireAuth } from './_auth.js';
import { buildForecast } from '../shared/weather-core.js';

// Forecast shaping is shared with the local proxy — see shared/weather-core.js.
// This file owns ONLY the HTTP surface.
export async function getForecast(lat, lon) {
  return buildForecast(lat, lon);
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
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
