// Windy point-forecast shaping — the single source of truth, imported by BOTH backends:
//   api/windy.js     (hosted, Vercel; key from WINDY_API_KEY)
//   proxy/server.js  (local proxy; key from WINDY_API_KEY or ~/.strava-proxy/auth.json)
//
// As with strava-core.js, these two carried near-identical copies where only the key
// lookup differed. The caller resolves its own key and passes it in.

const WINDY_URL = 'https://api.windy.com/api/point-forecast/v2';
export const HOURS_AHEAD = 48; // how far forward to summarise

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function windDir(u, v) {
  // Meteorological "from" direction of a (u east, v north) wind vector, m/s.
  const deg = (Math.atan2(u, v) * 180 / Math.PI + 180) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}
const round = (n, d = 0) => (n == null || !Number.isFinite(n)) ? null : +n.toFixed(d);

// Compact, ride-relevant forecast for one point. `key` is the Windy API key.
export async function buildForecast(lat, lon, key) {
  if (!key) throw new Error('Missing Windy API key.');

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
  const horizon = now + HOURS_AHEAD * 3600000;
  const hourly = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] < now - 3600000 || ts[i] > horizon) continue;
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
