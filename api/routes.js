// Vercel serverless function — per-user saved route history, so planned routes follow
// the athlete between phone and desktop.
//
//   GET  /api/routes  → { routes: [...] }  (the caller's saved routes, newest first)
//   PUT  /api/routes  → replace the caller's list with the body's `routes`
//
// Deliberately NOT part of the `coach_state` blob (api/state.js). Route geometry is by
// far the biggest thing the app stores — a single 25-mile route is ~56 KB as raw
// [lon,lat,ele] JSON, so 30 of them is ~1.6 MB — and coach_state is pushed on every
// plan/chat/goal change. Two things keep this cheap:
//   1. its own key, written only when routes actually change (rarely), and
//   2. the app stores geometry as an encoded polyline (measured 5.6x smaller with
//      elevation: 56 KB -> 10 KB per route, ~300 KB for 30), so what lands here is
//      metadata plus one compact string per route.
// Which blob is read/written is decided by WHO authenticates, so one athlete can never
// see another's routes. Needs KV; without it GET returns [] and PUT is a silent no-op.
import { requireUser } from './_auth.js';
import { kvGet, kvSet } from './_kv.js';

const MAX_ROUTES = 30;        // mirrors the app's ROUTES_MAX
const MAX_GEOM_CHARS = 60000; // ~25k points encoded — far beyond any real ride, but bounded

// Keep only known fields, coerced and length-capped, so a buggy or hostile client can't
// grow the stored blob without limit.
function sanitize(r) {
  return {
    id: String(r?.id || '').slice(0, 40),
    label: String(r?.label || '').slice(0, 120),
    distance_mi: Number(r?.distance_mi) || 0,
    ascent_ft: Number(r?.ascent_ft) || 0,
    duration_min: Number(r?.duration_min) || 0,
    date: String(r?.date || '').slice(0, 30),
    geom: typeof r?.geom === 'string' ? r.geom.slice(0, MAX_GEOM_CHARS) : '',
  };
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  res.setHeader('Cache-Control', 'no-store');

  const key = `routes:${user.id}`;
  try {
    if (req.method === 'GET') {
      const routes = await kvGet(key);
      res.status(200).json({ routes: Array.isArray(routes) ? routes : [] });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const list = Array.isArray(req.body?.routes) ? req.body.routes : [];
      const clean = list
        .filter(r => r && r.id)
        .slice(0, MAX_ROUTES)
        .map(sanitize);
      await kvSet(key, clean);
      res.status(200).json({ ok: true, count: clean.length });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // { error } over HTTP 200, matching the other api/ endpoints' convention.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
