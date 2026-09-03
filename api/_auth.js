// Shared auth for the hosted (Vercel) API functions. Single athlete: the
// `x-app-password` header must match the APP_PASSWORD env var.
// The local launchd proxy does NOT use this — it's only reachable on your machine.
// If APP_PASSWORD is unset the API refuses to run, so /api/chat can never be left
// open to the public by accident.
import crypto from 'node:crypto';

// Constant-time equality that tolerates different lengths (hash both sides first —
// timingSafeEqual throws on length mismatch, which would itself leak length).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Replies 503/401 and returns false when unauthenticated.
export function requireAuth(req, res) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    res.status(503).json({ error: 'Server not configured: set APP_PASSWORD in the Vercel project env vars.' });
    return false;
  }
  const pw = req.headers['x-app-password'];
  if (pw && safeEqual(pw, expected)) return true;
  res.status(401).json({ error: 'Unauthorized — wrong app password.' });
  return false;
}
