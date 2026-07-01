// Vercel serverless function — weather forecast for ride planning.
// Proxies the Windy Point Forecast API (https://api.windy.com/api/point-forecast/v2)
// so the WINDY_API_KEY stays server-side and CORS is never an issue.
//
// Request:  GET /api/windy?lat=<deg>&lon=<deg>   (behind the x-app-password gate)
// Response: compact, ride-relevant forecast JSON the app injects into the coach prompt.
//
// Env: WINDY_API_KEY (set in the Vercel project env vars). Same APP_PASSWORD gate as
// the other functions, so this can't be left open to the public by accident.
import { requirePassword } from './_auth.js';

const WINDY_URL = 'https://api.windy.com/api/point-forecast/v2';
const HOURS_AHEAD = 48; // how far forward to summarise

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function windDir(u, v) {
  // Meteorological "from" direction of a (u east, v north) wind vector, m/s.
  const deg = (Math.atan2(u, v) * 180 / Math.PI + 180) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}
const round = (n, d = 0) => (n == null || !Number.isFinite(n)) ? null : +n.toFixed(d);

export async function getForecast(lat, lon) {
  const key = process.env.WINDY_API_KEY;
  if (!key) throw new Error('Missing WINDY_API_KEY — set it in the Vercel project env vars.');

  const res = await fetch(WINDY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat, lon,
      model: 'gfs',
      parameters: ['wind', 'windGust', 'temp', 'precip'],
      levels: ['surface'],
      key,
    }),
  });
  if (!res.ok) throw new Error(`Windy API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();

  const ts = d.ts || [];
  const U = d['wind_u-surface'] || [];
  const V = d['wind_v-surface'] || [];
  const G = d['gust-surface'] || [];
  const T = d['temp-surface'] || [];
  const P = d['past3hprecip-surface'] || [];
  if (!ts.length) throw new Error('Windy returned no forecast timesteps.');

  const now = Date.now();
  const horizon = now + HOURS_AHEAD * 3600_000;
  const hourly = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < now - 3600_000 || ts[i] > horizon) continue;
    const u = U[i], v = V[i];
    const speed = (u != null && v != null) ? Math.hypot(u, v) : null;
    hourly.push({
      time: new Date(ts[i]).toISOString(),
      temp_c: round(T[i] != null ? T[i] - 273.15 : null, 1),
      wind_kph: round(speed != null ? speed * 3.6 : null),
      gust_kph: round(G[i] != null ? G[i] * 3.6 : null),
      wind_dir: (u != null && v != null) ? windDir(u, v) : null,
      precip_mm: round(P[i], 1), // mm over preceding ~3h
    });
  }
  if (!hourly.length) throw new Error('No forecast points within the next 48h.');

  const nums = (arr) => arr.filter(n => n != null && Number.isFinite(n));
  const winds = nums(hourly.map(h => h.wind_kph));
  const gusts = nums(hourly.map(h => h.gust_kph));
  const temps = nums(hourly.map(h => h.temp_c));
  const precipTotal = nums(hourly.map(h => h.precip_mm)).reduce((s, n) => s + n, 0);

  return {
    location: { lat: round(lat, 3), lon: round(lon, 3) },
    model: 'gfs',
    now: hourly[0],
    hourly,
    summary: {
      hours: HOURS_AHEAD,
      wind_kph_min: winds.length ? Math.min(...winds) : null,
      wind_kph_max: winds.length ? Math.max(...winds) : null,
      gust_kph_max: gusts.length ? Math.max(...gusts) : null,
      temp_c_min: temps.length ? Math.min(...temps) : null,
      temp_c_max: temps.length ? Math.max(...temps) : null,
      precip_mm_total: round(precipTotal, 1),
    },
  };
}

export default async function handler(req, res) {
  if (!requirePassword(req, res)) return;
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
