// Vercel serverless function — cycling route planning via GraphHopper's hosted
// Directions API (a self-hosted instance works too — same request shape, just point
// GRAPHHOPPER_URL at it instead).
//
// Three modes:
//   - "loop": round-trip from home. Target distance is derived from the workout's
//     duration + the athlete's real pace (pass paceMph from Strava history — the app
//     surfaces all speeds in mph — not a guess), biased away from hills via a custom
//     model. For "give me a flat 45-minute zone 2 loop" style requests.
//   - "out_and_back": fixed via-point route (home -> destination -> home), optimized
//     for shortest distance rather than fastest time. For "ride to X and back, the
//     shortest way" style requests. Destinations are geocoded via GraphHopper's
//     Geocoding API (same key) when they're not coordinates or a KNOWN_PLACES hit.
//   - "geocode": resolve a place name/postcode to { lat, lon, name } — used by the
//     app to resolve a home_set block's "place" field server-side instead of trusting
//     the LLM's approximate geography.
//
// UNITS: requests take paceMph; responses carry both metric (distance_km, ascent_m —
// GraphHopper's native units) and the imperial fields the app displays (distance_mi,
// target_mi, ascent_ft). Athlete-facing output is always miles/mph/feet.
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
// FREE-PLAN EMULATION: the free package rejects flexible mode (ch.disable +
// custom_model) outright, which is what real hill-avoidance and shortest-distance
// biasing need. But it DOES allow algorithm=round_trip and algorithm=alternative_route
// (proven live), so when flexible mode is rejected this module emulates instead of
// just serving the default route:
//   - loop + avoidHills: widen the seed pool to EMULATED_LOOP_SEEDS and keep the
//     flattest candidate (~4 credits per uncached ask);
//   - out_and_back: fetch up to ALT_MAX_PATHS alternatives per leg and keep the
//     shortest (2 credits per uncached ask — alternative_route only takes 2 points,
//     hence one call per leg).
// Results carry `degraded` (flexible mode unavailable) plus `fallback` describing
// which emulation applied ('sampled' | 'alternatives' | null), so the app/Telegram
// can word the caveat honestly. Road-level slope avoidance still needs a paid or
// self-hosted GraphHopper.
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
const EMULATED_LOOP_SEEDS = 4; // seed pool when emulating hill-avoidance on the free plan — flattest-of-N is the only lever there, so give the ranking a real choice
const ALT_MAX_PATHS = 3; // alternatives per leg when emulating shortest-distance via algorithm=alternative_route
const DEFAULT_CACHE_TTL = 86400; // 1 day — identical route asks reuse the cached result instead of re-spending credits

// Fast-path lookup for common destinations — skips a geocoding call (and its credit)
// for the places that actually get asked for. Anything else falls through to
// GraphHopper's Geocoding API in geocodePlace().
const KNOWN_PLACES = {
  'box hill': [51.2465, -0.3202],
  'richmond park': [51.4453, -0.2734],
  'leith hill': [51.1763, -0.3659],
};

// Resolve a place name/postcode to { lat, lon, name } via GraphHopper's Geocoding API
// (hosted service, same key as routing; NOT part of the self-hosted OSS engine — on a
// self-hosted GRAPHHOPPER_URL this 404s and the caller's fallback handles it).
// Results are KV-cached for 30 days: place names don't move, and geocode calls are
// metered like everything else.
export async function geocodePlace(q, near) {
  q = String(q || '').trim();
  if (!q) return null;
  const cacheK = `route_geocode:v1:${q.toLowerCase()}`;
  const cached = await kvGet(cacheK);
  if (cached) return cached;

  const url = ghUrl('geocode');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '1');
  if (Array.isArray(near) && near.length === 2) url.searchParams.set('point', `${near[0]},${near[1]}`); // bias results toward home
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `Geocoding failed (${res.status})`);
  const hit = data?.hits?.[0];
  if (!hit?.point) return null;
  const out = {
    lat: hit.point.lat,
    lon: hit.point.lng,
    name: [hit.name, hit.city || hit.state, hit.country].filter(Boolean).join(', '),
  };
  await kvSet(cacheK, out, { ex: 30 * 86400 });
  return out;
}

// Destination resolution cascade: "lat,lon" string -> KNOWN_PLACES -> geocoding.
// Always returns { lat, lon, name? } or null.
async function resolvePlace(input, near) {
  if (!input) return null;
  const asCoords = String(input).split(',').map(s => parseFloat(s.trim()));
  if (asCoords.length === 2 && asCoords.every(Number.isFinite)) return { lat: asCoords[0], lon: asCoords[1] };
  const known = KNOWN_PLACES[String(input).trim().toLowerCase()];
  if (known) return { lat: known[0], lon: known[1], name: String(input).trim() };
  return geocodePlace(input, near);
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
// route (or requiring an upgrade), detect this specific rejection and fall back to
// the free-plan emulation paths (seed sampling / alternative_route) so the athlete
// still gets something close to what they asked for.
function isFlexibleModeError(err) {
  return /flexible mode/i.test(err?.message || '');
}
function stripFlexible(body) {
  const { custom_model, ['ch.disable']: _chDisable, ...rest } = body;
  return rest;
}
// Whether the GraphHopper host accepts flexible mode. null = not yet known; learned
// from the first flexible request's outcome. Module-level so a warm lambda stops
// re-spending a doomed request per route ask once the plan's answer is known (resets
// on cold start, which is also how an upgraded plan gets picked up again).
let hostSupportsFlexible = null;

// Returns { data, degraded }. degraded=true means the plan doesn't support flexible
// mode and this came back from the plain-routing fallback instead of the requested
// (hill-avoiding / shortest-distance) version.
async function ghPostWithDegrade(body) {
  const usesFlexible = body.custom_model !== undefined || body['ch.disable'] === true;
  if (!usesFlexible) return { data: await ghPost(body), degraded: false };
  if (hostSupportsFlexible === false) return { data: await ghPost(stripFlexible(body)), degraded: true };
  try {
    const data = await ghPost(body);
    hostSupportsFlexible = true;
    return { data, degraded: false };
  } catch (err) {
    if (!isFlexibleModeError(err)) throw err;
    hostSupportsFlexible = false;
    console.warn('GraphHopper plan does not support flexible mode — falling back to free-plan emulation:', err.message);
    return { data: await ghPost(stripFlexible(body)), degraded: true };
  }
}

const KM_PER_MI = 1.60934;
const FT_PER_M = 3.28084;

function summarize(path, mode) {
  const pts = path.points?.coordinates || path.points || [];
  const km = Math.round((path.distance / 1000) * 10) / 10;
  const ascentM = path.ascend != null ? Math.round(path.ascend) : totalAscent(pts);
  return {
    mode,
    distance_km: km,
    distance_mi: Math.round((km / KM_PER_MI) * 10) / 10,
    duration_min: Math.round(path.time / 60000),
    ascent_m: ascentM,
    ascent_ft: ascentM != null ? Math.round(ascentM * FT_PER_M) : null,
    descent_m: path.descend != null ? Math.round(path.descend) : null,
    points: pts, // [lon, lat, elevation][] (points_encoded:false)
    bbox: path.bbox || null,
  };
}

// mode "loop": round trip from [lat,lon]. Target distance = paceMph * (durationMin/60),
// converted to metres for GraphHopper. paceMph should come from the athlete's real
// Strava average (which the app already surfaces in mph), not a guess.
async function planLoop({ lat, lon, durationMin, paceMph, avoidHills = true, seeds }) {
  seeds = seeds || Math.max(1, parseInt(process.env.ROUTE_LOOP_SEEDS, 10) || DEFAULT_LOOP_SEEDS);
  if (!durationMin || !paceMph) throw new Error('Loop mode needs durationMin and paceMph to size the route.');
  const targetMi = paceMph * (durationMin / 60);
  const targetKm = targetMi * KM_PER_MI;
  const targetM = Math.max(1000, Math.round(targetKm * 1000));

  const candidates = [];
  const seedErrors = [];
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
    // ch.disable exists only to carry the custom_model — sending it bare would flag
    // the request as flexible mode (and get a no-hills loop needlessly "degraded"
    // on the free plan) for zero routing benefit.
    const cm = slopeCustomModel({ avoidHills });
    if (cm) { body['ch.disable'] = true; body.custom_model = cm; }
    try {
      const { data, degraded: wasDegraded } = await ghPostWithDegrade(body);
      if (wasDegraded && !degraded) {
        degraded = true;
        // Free-plan emulation: custom_model is off the table, so flattest-of-N
        // sampling is the only hill-avoidance we have — widen the pool mid-loop
        // (the for-condition re-reads `seeds`) to give the ranking a real choice.
        if (avoidHills) seeds = Math.max(seeds, EMULATED_LOOP_SEEDS);
      }
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
    target_mi: Math.round(targetMi * 10) / 10,
    best: candidates[0],
    candidates_tried: candidates.length,
    // degraded: the plan doesn't support flexible mode (custom_model), so no
    // road-level slope biasing was applied. fallback says what was done about it:
    // 'sampled' = flattest of a widened seed pool (only claimable with >1 candidate
    // to actually choose between); null = nothing, this is just the default loop.
    degraded,
    fallback: degraded && avoidHills && candidates.length > 1 ? 'sampled' : null,
  };
}

// One leg of the free-plan shortest-distance emulation: algorithm=alternative_route
// works without flexible mode but only accepts exactly 2 points, so out-and-back
// becomes one call per leg. Returns the best of up to ALT_MAX_PATHS paths — shortest
// by default, flattest when avoidHills.
async function bestAlternativeLeg(from, to, avoidHills) {
  const data = await ghPost({
    points: [from, to],
    profile: DEFAULT_PROFILE,
    algorithm: 'alternative_route',
    'alternative_route.max_paths': ALT_MAX_PATHS,
    elevation: true,
    instructions: false,
    points_encoded: false,
  });
  const paths = data.paths || [];
  if (!paths.length) throw new Error('GraphHopper returned no alternative paths for a leg.');
  const score = p => avoidHills ? (p.ascend ?? totalAscent(p.points?.coordinates) ?? Infinity) : p.distance;
  paths.sort((a, b) => score(a) - score(b));
  return { best: paths[0], tried: paths.length };
}

function unionBbox(a, b) {
  if (!Array.isArray(a) || a.length !== 4) return Array.isArray(b) && b.length === 4 ? b : null;
  if (!Array.isArray(b) || b.length !== 4) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

// Join two leg paths into one pseudo-path shaped like GraphHopper's own, so
// summarize() works on it unchanged. Drops the second leg's first point — it
// duplicates the first leg's last (the shared turnaround).
function stitchLegs(a, b) {
  const ptsA = a.points?.coordinates || [], ptsB = b.points?.coordinates || [];
  return {
    distance: a.distance + b.distance,
    time: a.time + b.time,
    ascend: (a.ascend ?? totalAscent(ptsA) ?? 0) + (b.ascend ?? totalAscent(ptsB) ?? 0),
    descend: (a.descend ?? 0) + (b.descend ?? 0),
    points: { coordinates: ptsA.concat(ptsB.slice(1)) },
    bbox: unionBbox(a.bbox, b.bbox),
  };
}

// mode "out_and_back": home -> destination -> home, optimized for shortest distance.
async function planOutAndBack({ lat, lon, destination, avoidHills = false }) {
  const dest = await resolvePlace(destination, [lat, lon]);
  if (!dest) throw new Error(`Could not find "${destination}" — try a more specific place name, or pass "lat,lon" directly.`);
  const home = [lon, lat], turnaround = [dest.lon, dest.lat];

  const flexBody = {
    points: [home, turnaround, home],
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

  let path = null, degraded = false, fallback = null, alternativesTried = 0;
  if (hostSupportsFlexible !== false) {
    try {
      path = (await ghPost(flexBody)).paths?.[0];
      hostSupportsFlexible = true;
    } catch (err) {
      if (!isFlexibleModeError(err)) throw err;
      hostSupportsFlexible = false;
      console.warn('GraphHopper plan does not support flexible mode — emulating shortest-distance via alternative_route:', err.message);
    }
  }
  if (!path) {
    degraded = true;
    try {
      const out = await bestAlternativeLeg(home, turnaround, avoidHills);
      const back = await bestAlternativeLeg(turnaround, home, avoidHills);
      path = stitchLegs(out.best, back.best);
      fallback = 'alternatives';
      alternativesTried = out.tried + back.tried;
    } catch (err) {
      // alternative_route not available either (or no alternatives here) — last
      // resort is the plain default-weighted route, honestly labelled as such.
      console.warn('alternative_route emulation failed — serving the default route:', err.message);
      path = (await ghPost(stripFlexible(flexBody))).paths?.[0];
    }
  }
  if (!path) throw new Error('GraphHopper returned no route to that destination.');
  const result = summarize(path, 'out_and_back');
  if (dest.name) result.destination_name = dest.name; // geocoder's idea of where it sent you — surface so the athlete can catch a bad match
  // degraded: the plan doesn't support flexible mode, so no distance_influence /
  // slope biasing was applied. fallback 'alternatives' = shortest (or flattest) of
  // the sampled road alternatives each way; null = plain default route.
  result.degraded = degraded;
  result.fallback = fallback;
  if (alternativesTried) result.alternatives_tried = alternativesTried;
  return result;
}

export async function planRoute(params) {
  if (params.mode === 'loop') return planLoop(params);
  if (params.mode === 'out_and_back') return planOutAndBack(params);
  throw new Error(`Unknown route mode "${params.mode}" — expected "loop" or "out_and_back".`);
}

// planRoute with the KV cache in front, so repeat asks for the same route don't
// re-spend GraphHopper credits.
export async function planRouteCached(params) {
  const key = cacheKey(params);
  const cached = await kvGet(key);
  if (cached) return { ...cached, cached: true };
  const result = await planRoute(params);
  const ttl = Math.max(60, parseInt(process.env.ROUTE_CACHE_TTL_SECONDS, 10) || DEFAULT_CACHE_TTL);
  await kvSet(key, result, { ex: ttl }); // no-ops silently if KV isn't configured
  return result;
}

// Cache key covers only the inputs that change the physical route — shared across
// users/devices asking for the same thing, not per-user. Coordinates rounded to 3dp
// (~110m) since home location is otherwise a fixed value per request anyway.
function cacheKey(p) {
  const r3 = (n) => Number.isFinite(n) ? n.toFixed(3) : 'x';
  // v3: free-plan emulation added (sampled/alternatives fallbacks) — don't serve v2
  // results cached from before it existed.
  return `route_cache:v3:${p.mode}:${r3(p.lat)}:${r3(p.lon)}:${p.durationMin ?? ''}:${p.paceMph ?? ''}:${!!p.avoidHills}:${(p.destination || '').toLowerCase().trim()}`;
}

export default async function handler(req, res) {
  if (!(await requireUser(req, res))) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const lat = parseFloat(q.lat);
    const lon = parseFloat(q.lon);

    // Geocode mode has no home-location requirement — it's how the app resolves the
    // home location in the first place (home_set blocks with a "place" field). lat/lon
    // are only an optional result bias here. geocodePlace does its own KV caching.
    if (q.mode === 'geocode') {
      const hit = await geocodePlace(q.q, Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : undefined);
      return res.status(200).json(hit || { error: `Could not find "${q.q}" — try a more specific place name.` });
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(200).json({ error: 'Missing or invalid lat/lon (home location).' });
    }
    const params = {
      mode: q.mode,
      lat, lon,
      durationMin: q.durationMin != null ? parseFloat(q.durationMin) : undefined,
      // The protocol is mph (all athlete-facing speeds are), but accept a stray
      // paceKph and convert rather than failing the request over units.
      paceMph: q.paceMph != null ? parseFloat(q.paceMph)
             : q.paceKph != null ? parseFloat(q.paceKph) / KM_PER_MI
             : undefined,
      destination: q.destination,
      avoidHills: q.avoidHills === true || q.avoidHills === 'true',
    };

    res.status(200).json(await planRouteCached(params));
  } catch (err) {
    // { error } over HTTP 200, matching the other api/ endpoints' convention so the
    // app's existing `if (d.error)` handling surfaces it cleanly.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
