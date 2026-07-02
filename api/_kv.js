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
