// Shared password gate for the hosted (Vercel) API functions.
// The local launchd proxy does NOT use this — it's only reachable on your machine.
//
// Set APP_PASSWORD in the Vercel project's Environment Variables. Every /api call
// must send a matching `x-app-password` header (the front-end does this for you).
// If APP_PASSWORD is unset the API refuses to run, so /api/chat can never be left
// open to the public by accident.
export function requirePassword(req, res) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    res.status(503).json({ error: 'Server not configured: set APP_PASSWORD in the Vercel project env vars.' });
    return false;
  }
  if (req.headers['x-app-password'] !== expected) {
    res.status(401).json({ error: 'Unauthorized — wrong app password.' });
    return false;
  }
  return true;
}
