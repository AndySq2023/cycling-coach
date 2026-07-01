// Shared Vercel KV (Upstash Redis) helpers. Every store-backed function imports these
// so there is one place that knows how to talk to KV and how to degrade when it is not
// configured (KV_REST_API_URL unset → reads return null, writes are silent no-ops).
export async function kvGet(key) {
  if (!process.env.KV_REST_API_URL) return null;
  try { const { kv } = await import('@vercel/kv'); return await kv.get(key); }
  catch { return null; }
}

export async function kvSet(key, value) {
  if (!process.env.KV_REST_API_URL) return;
  try { const { kv } = await import('@vercel/kv'); await kv.set(key, value); }
  catch { /* non-fatal: value just won't persist this time */ }
}
