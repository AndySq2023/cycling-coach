// Shared Vercel KV (Upstash Redis) helpers. Every store-backed function imports these
// so there is one place that knows how to talk to KV and how to degrade when it is not
// configured (KV_REST_API_URL unset → reads return null, writes are silent no-ops).
export async function kvGet(key) {
  if (!process.env.KV_REST_API_URL) return null;
  try { const { kv } = await import('@vercel/kv'); return await kv.get(key); }
  catch { return null; }
}

// opts is passed through to @vercel/kv, e.g. { ex: 600 } for a 10-minute TTL.
export async function kvSet(key, value, opts) {
  if (!process.env.KV_REST_API_URL) return;
  try { const { kv } = await import('@vercel/kv'); await kv.set(key, value, opts); }
  catch { /* non-fatal: value just won't persist this time */ }
}

export async function kvDel(key) {
  if (!process.env.KV_REST_API_URL) return;
  try { const { kv } = await import('@vercel/kv'); await kv.del(key); }
  catch { /* non-fatal */ }
}

// Read-through cache for expensive upstream fetches (WHOOP/Strava summaries). Without
// this, every app load, every sync tap and every morning briefing re-runs the full
// provider fan-out — for Strava that's up to 3 pages of 90-day history plus a ride-detail
// call, per request. TTLs are short (minutes), so data still feels live.
//
// Never caches a failure or an { error } payload: a transient upstream blip must not be
// served for the rest of the TTL. `force` bypasses the read for an explicit refresh.
// Degrades to a plain call when KV is unconfigured (kvGet returns null, kvSet no-ops).
export async function cached(key, ttlSeconds, fn, force = false) {
  if (!force) {
    const hit = await kvGet(key);
    if (hit != null) return hit;
  }
  const value = await fn();
  if (value && !value.error) await kvSet(key, value, { ex: ttlSeconds });
  return value;
}

// Atomic counter (used for per-user daily chat quotas). Returns the new count, or
// null when KV is unavailable — callers should NOT enforce limits on null, otherwise
// a KV outage would lock everyone out of the coach.
export async function kvIncr(key, ttlSeconds) {
  if (!process.env.KV_REST_API_URL) return null;
  try {
    const { kv } = await import('@vercel/kv');
    const n = await kv.incr(key);
    if (n === 1 && ttlSeconds) await kv.expire(key, ttlSeconds);
    return n;
  } catch { return null; }
}
