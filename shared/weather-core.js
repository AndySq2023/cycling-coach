// Open-Meteo forecast shaping — the single source of truth, imported by BOTH backends:
//   api/weather.js   (hosted, Vercel)
//   proxy/server.js  (local proxy)
//
// Open-Meteo (https://open-meteo.com) is free, keyless, and returns real (unshuffled)
// forecast data blended from open models (NOAA GFS, DWD ICON, etc.) — switched to it
// after finding the Windy Point Forecast API's free tier deliberately randomizes data
// ("testing API version... data is randomly shuffled and slightly modified"); real
// Windy data requires a €990/year Professional plan.

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const HOURS_AHEAD = 48; // how far forward to summarise
const STEP_HOURS = 3; // sampling cadence for the hourly outlook (prompt stays compact)

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function windDir(deg) {
  // Open-Meteo reports degrees the wind is blowing FROM (meteorological convention).
  if (deg == null || !Number.isFinite(deg)) return null;
  return COMPASS[Math.round(deg / 45) % 8];
}
const round = (n, d = 0) => (n == null || !Number.isFinite(n)) ? null : +n.toFixed(d);

// Compact, ride-relevant forecast for one point. No API key required.
export async function buildForecast(lat, lon) {
  const url = `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,windspeed_10m,winddirection_10m,windgusts_10m,precipitation` +
    `&timezone=UTC&forecast_days=3`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo API error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();

  const h = d.hourly || {};
  const times = h.time || [];
  if (!times.length) throw new Error('Open-Meteo returned no forecast timesteps.');

  // timezone=UTC gives naive "YYYY-MM-DDTHH:mm" strings representing UTC instants.
  const ts = times.map(t => Date.parse(t + 'Z'));
  const T = h.temperature_2m || [];
  const W = h.windspeed_10m || [];
  const G = h.windgusts_10m || [];
  const D = h.winddirection_10m || [];
  const P = h.precipitation || [];

  const now = Date.now();
  const horizon = now + HOURS_AHEAD * 3600000;

  let start = ts.findIndex(t => t >= now - 3600000);
  if (start === -1) start = 0;

  const hourly = [];
  for (let i = start; i < ts.length && ts[i] <= horizon; i += STEP_HOURS) {
    // Sum precipitation over the preceding (up to) 3h, matching the old "last 3h" semantics.
    let precip = 0, sawPrecip = false;
    for (let j = Math.max(0, i - (STEP_HOURS - 1)); j <= i; j++) {
      if (P[j] != null && Number.isFinite(P[j])) { precip += P[j]; sawPrecip = true; }
    }
    hourly.push({
      time: new Date(ts[i]).toISOString(),
      temp_c: round(T[i]),
      wind_kph: round(W[i]),
      gust_kph: round(G[i]),
      wind_dir: windDir(D[i]),
      precip_mm: sawPrecip ? round(precip, 1) : null,
    });
  }
  if (!hourly.length) throw new Error('No forecast points within the next 48h.');

  const nums = (arr) => arr.filter(n => n != null && Number.isFinite(n));
  const winds = nums(hourly.map(x => x.wind_kph));
  const gusts = nums(hourly.map(x => x.gust_kph));
  const temps = nums(hourly.map(x => x.temp_c));
  const precipTotal = nums(hourly.map(x => x.precip_mm)).reduce((s, n) => s + n, 0);

  return {
    location: { lat: round(lat, 3), lon: round(lon, 3) },
    model: 'open-meteo',
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
