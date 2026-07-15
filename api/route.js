// Vercel serverless function — cycling route planning via GraphHopper's hosted
// Directions API (a self-hosted instance works too — same request shape, just point
// GRAPHHOPPER_URL at it instead).
//
// Two modes:
//   - "loop": round-trip from home. Target distance is derived from the workout's
//     duration + the athlete's real pace (pass paceKph from Strava zone history, not
//     a guess), biased away from hills via a custom model. For "give me a flat
//     45-minute zone 2 loop" style requests.
//   - "out_and_back": fixed via-point route (home -> destination -> home), optimized
//     for shortest distance rather than fastest time. For "ride to X and back, the
//     shortest way" style requests.
//
// Env: GRAPHHOPPER_URL (required — hosted: "https://graphhopper.com/api/1",
//        self-hosted: your instance's base URL, e.g. https://your-graphhopper.fly.dev),
//      GRAPHHOPPER_API_KEY (your API key on the hosted service; optional/self-hosted
//        instances may not need one),
//      ROUTE_LOOP_SEEDS (optional, default 2 — see note below),
//      ROUTE_CACHE_TTL_SECONDS (optional, default 86400 — see caching note below).
//
// COST NOTE: the hosted Directions API is credit-metered (500 credits/day on the
// current plan — plenty for personal/family use, so no per-user rate limit is
// enforced here). Loop mode used to try 4 round_trip seeds per request to pick the
// flattest; that's 4x the billed requests for one "plan me a route" ask. Defaulted
// down to 2 seeds (ROUTE_LOOP_SEEDS) since each is now a metered call rather than a
// free self-hosted one. KV-backed caching below avoids re-spending credits on
// identical repeat requests (same location/duration/pace/hills).
//
// NOTE ON GRAPHHOPPER API SHAPE: this was written against GraphHopper's documented
// POST /route body (points as [lon,lat] pairs, custom_model for priority/speed/
// distance_influence, ch.disable required alongside custom_model) and the GET-only
// round_trip params (algorithm, round_trip.distance, round_trip.seed). GraphHopper's
// exact accepted keys for round_trip via a POST+custom_model body were not fully
// confirmed against live docs (the reference page is client-rendered and didn't
// return content during research) — verify this against your GraphHopper plan/version
// with one real request before relying on it, and adjust the dot-keys below if
// rejected.
import { requireUser } from './_auth.js';
import { kvGet, kvSet } from './_kv.js';

const DEFAULT_PROFILE = 'bike'; // swap for a custom cycling profile if you define one server-side
const DEFAULT_LOOP_SEEDS = 2; // how many round_trip seeds to try, keep the flattest — each is a billed request on a metered plan
const DEFAULT_CACHE_TTL = 86400; // 1 day — identical route asks reuse the cached result instead of re-spending credits

// Tiny named-place lookup for out_and_back destinations — geocoding isn't wired up
// yet, so either extend this table or pass "lat,lon" directly as the destination.
const KNOWN_PLACES = {
  'box hill': [51.2465, -0.3202],
  'richmond park': [51.4453, -0.2734],
  'leith hill': [51.1763, -0.3659],
};

function resolvePlace(input) {
  if (!input) return null;
  const asCoords = String(input).split(',').map(s => parseFloat(s.trim()));
  if (asCoords.length === 2 && asCoords.every(Number.isFinite)) return asCoords;
  return KNOWN_PLACES[String(input).trim().toLowerCase()] || null;
}

function ghUrl(path) {
  const base = process.env.GRAPHHOPPER_URL;
  if (!base) throw new Error('Missing GRAPHHOPPER_URL — set it in the Vercel project env vars.');
  // IMPORTANT: new URL(path, base) is NOT simple concatenation — a leading "/" on
  // `path` makes it origin-relative per the URL spec, which silently discards the
  // base's own path. new URL('/route', 'https://graphhopper.com/api/1') resolves to
  // 'https://graphhopper.com/route', NOT '.../api/1/route' — this was hitting
  // graphhopper.com's website instead of the API and getting an HTML page back
  // (surfaced as "Unexpected token '<' ... is not valid JSON" once the real
  // GraphHopper error was wired through). Build the full path manually instead.
  const fullPath = base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
  const url = new URL(fullPath);
  const key = process.env.GRAPHHOPPER_API_KEY;
  if (key) url.searchParams.set('key', key);
  return url;
}

// Sum only the positive elevation deltas along a [lon,lat,ele] point list — fallback
// for when GraphHopper doesn't return paths[0].ascend directly.
function totalAscent(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let up = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]?.[2], cur = points[i]?.[2];
    if (prev != null && cur != null && cur > prev) up += (cur - prev);
  }
  return Math.round(up);
}

// Mild, deliberately non-absolute penalties — this biases the route toward flatter
// roads, it does not forbid hills outright. Tune the thresholds/multipliers once you
// see real output for your area.
function slopeCustomModel({ avoidHills, distanceInfluence }) {
  const cm = {};
  if (distanceInfluence != null) cm.distance_influence = distanceInfluence;
  if (avoidHills) {
    cm.priority = [
      { if: 'average_slope > 4', multiply_by: '0.6' },
      { if: 'average_slope > 8', multiply_by: '0.3' },
      { if: 'max_slope > 12', multiply_by: '0.2' },
    ];
  }
  return Object.keys(cm).length ? cm : undefined;
}

async function ghPost(body) {
  const res = await fetch(ghUrl('/route'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    // Surface as much of GraphHopper's own error detail as it gives us — its 400
    // responses put the useful part in `message` and sometimes more specifics in
    // `hints[].message` (e.g. point-not-found, invalid custom_model field). Swallowing
    // this down to a generic "GraphHopper error (400)" is exactly what made the first
    // real failure here hard to diagnose without digging through server logs.
    const mainMsg = data?.message || '';
    const hintMsgs = Array.isArray(data?.hints) ? data.hints.map(h => h.message).filter(m => m && m !== mainMsg) : [];
    const hint = hintMsgs.length ? ` (${hintMsgs.join('; ')})` : '';
    throw new Error(`${data?.message || `GraphHopper error (${res.status})`}${hint}`);
  }
  return data;
}

// "Flexible mode" (ch.disable + custom_model) is a paid-tier-only feature on
// GraphHopper's hosted API — free/basic packages reject it outright with a message
// like "Free packages cannot use flexible mode". Rather than hard-failing the whole
// route (or requiring an upgrade), detect this specific rejection and retry once
// without custom_model/ch.disable so the athlete still gets a route — just without
// the hill-avoidance/shortest-distance biasing those enable.
function isFlexibleModeError(err) {
  return /flexible mode/i.test(err?.message || '');
}
function stripFlexible(body) {
  const { custom_model, ['ch.disable']: _chDisable, ...rest } = body;
  return rest;
}
// Returns { data, degraded }. degraded=true means the plan doesn't support flexible
// mode and this came back from the plain-routing fallback instead of the requested
// (hill-avoiding / shortest-distance) version.
async function ghPostWithDegrade(body) {
  const usesFlexible = body.custom_model !== undefined || body['ch.disable'] === true;
  if (!usesFlexible) return { data: await ghPost(body), degraded: false };
  try {
    return { data: await ghPost(body), degraded: false };
  } catch (err) {
    if (!isFlexibleModeError(err)) throw err;
    console.warn('GraphHopper plan does not support flexible mode — retrying without custom_model/ch.disable:', err.message);
    return { data: await ghPost(stripFlexible(body)), degraded: true };
  }
}

function summarize(path, mode) {
  const pts = path.points?.coordinates || path.points || [];
  return {
    mode,
    distance_km: Math.round((path.distance / 1000) * 10) / 10,
    duration_min: Math.round(path.time / 60000),
    ascent_m: path.ascend != null ? Math.round(path.ascend) : totalAscent(pts),
    descent_m: path.descend != null ? Math.round(path.descend) : null,
    points: pts, // [lon, lat, elevation][] (points_encoded:false)
    bbox: path.bbox || null,
  };
}

// mode "loop": round trip from [lat,lon]. Target distance = paceKph * (durationMin/60).
// paceKph should come from the athlete's real Strava zone-2 average, not a guess.
async function planLoop({ lat, lon, durationMin, paceKph, avoidHills = true, seeds }) {
  seeds = seeds || Math.max(1, parseInt(process.env.ROUTE_LOOP_SEEDS, 10) || DEFAULT_LOOP_SEEDS);
  if (!durationMin || !paceKph) throw new Error('Loop mode needs durationMin and paceKph to size the route.');
  const targetKm = paceKph * (durationMin / 60);
  const targetM = Math.max(1000, Math.round(targetKm * 1000));

  const candidates = [];
  const seedErrors = [];
  // Once we learn the plan doesn't support flexible mode (from any seed), stop
  // attempting it on subsequent seeds — no point re-spending a credit on a request
  // we already know will be rejected the same way every time.
  let flexibleSupported = true;
  let degraded = false;
  for (let seed = 0; seed < seeds; seed++) {
    const body = {
      points: [[lon, lat]],
      profile: DEFAULT_PROFILE,
      algorithm: 'round_trip',
      'round_trip.distance': targetM,
      'round_trip.seed': seed,
      elevation: true,
      instructions: false,
      points_encoded: false,
    };
    if (flexibleSupported) {
      body['ch.disable'] = true;
      const cm = slopeCustomModel({ avoidHills });
      if (cm) body.custom_model = cm;
    }
    try {
      const { data, degraded: wasDegraded } = await ghPostWithDegrade(body);
      if (wasDegraded) { flexibleSupported = false; degraded = true; }
      const path = data.paths?.[0];
      if (path) candidates.push(summarize(path, 'loop'));
    } catch (err) {
      // One bad seed shouldn't sink the whole request — just try the next. Still keep
      // the real message so we can surface it if every seed fails, instead of a
      // generic error that hides what GraphHopper actually said.
      console.warn(`round_trip seed ${seed} failed:`, err.message);
      seedErrors.push(err.message);
    }
  }
  if (!candidates.length) {
    const detail = seedErrors.length ? ` GraphHopper said: "${seedErrors[seedErrors.length - 1]}"` : '';
    throw new Error(`GraphHopper returned no viable loop for this area/distance.${detail}`);
  }

  candidates.sort((a, b) => (a.ascent_m ?? Infinity) - (b.ascent_m ?? Infinity));
  return {
    mode: 'loop',
    target_km: Math.round(targetKm * 10) / 10,
    best: candidates[0],
    candidates_tried: candidates.length,
    // true when the GraphHopper plan doesn't support flexible mode (custom_model),
    // meaning this is a plain round-trip rather than one biased away from hills.
    degraded,
  };
}

// mode "out_and_back": home -> destination -> home, optimized for shortest distance.
async function planOutAndBack({ lat, lon, destination, avoidHills = false }) {
  const dest = resolvePlace(destination);
  if (!dest) throw new Error(`Could not resolve destination "${destination}" — pass a known place name (see KNOWN_PLACES) or "lat,lon".`);

  const body = {
    points: [[lon, lat], [dest[1], dest[0]], [lon, lat]],
    profile: DEFAULT_PROFILE,
    elevation: true,
    instructions: false,
    points_encoded: false,
    'ch.disable': true,
    // Push hard toward the physically shortest path rather than the fastest one.
    // Sanity-check the result — pure shortest-distance can surface A-roads/dual
    // carriageways the default bike profile would otherwise avoid.
    custom_model: slopeCustomModel({ avoidHills, distanceInfluence: 200 }),
  };
  const { data, degraded } = await ghPostWithDegrade(body);
  const path = data.paths?.[0];
  if (!path) throw new Error('GraphHopper returned no route to that destination.');
  const result = summarize(path, 'out_and_back');
  // true when the plan doesn't support flexible mode: this is the default-weighted
  // route (fastest-ish), not the shortest-distance-biased one that was requested.
  result.degraded = degraded;
  return result;
}

export async function planRoute(params) {
  if (params.mode === 'loop') return planLoop(params);
  if (params.mode === 'out_and_back') return planOutAndBack(params);
  throw new Error(`Unknown route mode "${params.mode}" — expected "loop" or "out_and_back".`);
}

// Cache key covers only the inputs that change the physical route — shared across
// users/devices asking for the same thing, not per-user. Coordinates rounded to 3dp
// (~110m) since home location is otherwise a fixed value per request anyway.
function cacheKey(p) {
  const r3 = (n) => Number.isFinite(n) ? n.toFixed(3) : 'x';
  return `route_cache:v1:${p.mode}:${r3(p.lat)}:${r3(p.lon)}:${p.durationMin ?? ''}:${p.paceKph ?? ''}:${!!p.avoidHills}:${(p.destination || '').toLowerCase().trim()}`;
}

export default async function handler(req, res) {
  if (!(await requireUser(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const lat = parseFloat(q.lat);
    const lon = parseFloat(q.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(200).json({ error: 'Missing or invalid lat/lon (home location).' });
    }
    const params = {
      mode: q.mode,
      lat, lon,
      durationMin: q.durationMin != null ? parseFloat(q.durationMin) : undefined,
      paceKph: q.paceKph != null ? parseFloat(q.paceKph) : undefined,
      destination: q.destination,
      avoidHills: q.avoidHills === true || q.avoidHills === 'true',
    };

    const key = cacheKey(params);
    const cached = await kvGet(key);
    if (cached) {
      res.status(200).json({ ...cached, cached: true });
      return;
    }

    const result = await planRoute(params);
    const ttl = Math.max(60, parseInt(process.env.ROUTE_CACHE_TTL_SECONDS, 10) || DEFAULT_CACHE_TTL);
    await kvSet(key, result, { ex: ttl }); // no-ops silently if KV isn't configured

    res.status(200).json(result);
  } catch (err) {
    // { error } over HTTP 200, matching the other api/ endpoints' convention so the
    // app's existing `if (d.error)` handling surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
