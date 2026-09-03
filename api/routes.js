// Vercel serverless function — saved route history, so planned routes follow the
// athlete between phone and desktop.
//
//   GET  /api/routes  → { routes: [...] }  (saved routes, newest first)
//   PUT  /api/routes  → replace the stored list with the body's `routes`
//
// Deliberately NOT part of the `coach_state` blob (api/state.js). Route geometry is by
// far the biggest thing the app stores — a single 25-mile route is ~56 KB as raw
// [lon,lat,ele] JSON, so 30 of them is ~1.6 MB — and coach_state is pushed on every
// plan/chat/goal change. Two things keep this cheap:
//   1. its own key, written only when routes actually change (rarely), and
//   2. the app stores geometry as an encoded polyline (measured 5.6x smaller with
//      elevation: 56 KB -> 10 KB per route, ~300 KB for 30), so what lands here is
//      metadata plus one compact string per route.
// Needs KV; without it GET returns [] and PUT is a silent no-op.
import { requireAuth } from './_auth.js';
import { kvGet, kvSet } from './_kv.js';

const ROUTES_KEY = 'routes:master'; // historical key name, kept so saved routes survive
const MAX_ROUTES = 30;         // mirrors the app's ROUTES_MAX
const MAX_GEOM_CHARS = 60000;  // ~25k points encoded — far beyond any real ride, but bounded
const MAX_TOMBSTONES = 200;    // mirrors the app's ROUTES_TOMBSTONE_MAX

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

// Tombstones (id -> deletion timestamp ms) let a delete on one device propagate instead of
// being undone by another device that still holds the route. Coerce, drop junk, cap to the
// newest N so a client can't grow the blob without limit.
function sanitizeDeleted(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
  const entries = Object.entries(d)
    .map(([id, ts]) => [String(id).slice(0, 40), Number(ts) || 0])
    .filter(([id, ts]) => id && ts > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOMBSTONES);
  return Object.fromEntries(entries);
}

// KV historically held a bare routes array; it now holds { routes, deleted }. Read both.
function unpack(stored) {
  if (Array.isArray(stored)) return { routes: stored, deleted: {} };
  return { routes: Array.isArray(stored?.routes) ? stored.routes : [], deleted: stored?.deleted || {} };
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const { routes, deleted } = unpack(await kvGet(ROUTES_KEY));
      res.status(200).json({ routes: Array.isArray(routes) ? routes : [], deleted: sanitizeDeleted(deleted) });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const list = Array.isArray(req.body?.routes) ? req.body.routes : [];
      const deleted = sanitizeDeleted(req.body?.deleted);
      const clean = list
        .filter(r => r && r.id && !(r.id in deleted)) // never store a route that's tombstoned
        .slice(0, MAX_ROUTES)
        .map(sanitize);
      await kvSet(ROUTES_KEY, { routes: clean, deleted });
      res.status(200).json({ ok: true, count: clean.length, tombstones: Object.keys(deleted).length });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // { error } over HTTP 200, matching the other api/ endpoints' convention.
    res.status(200).json({ error: err?.message || String(err) });
  }
}
