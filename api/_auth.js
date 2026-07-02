// Shared auth for the hosted (Vercel) API functions. Multi-user: the same
// `x-app-password` header now identifies WHO is calling —
//   APP_PASSWORD env var        → the master user (role 'master', sees all athletes)
//   a roster member's password  → that member    (role 'member', sees own data only)
// The local launchd proxy does NOT use this — it's only reachable on your machine.
// If APP_PASSWORD is unset the API refuses to run, so /api/chat can never be left
// open to the public by accident.
import { getRoster, findMemberByPassword, safeEqual } from './_users.js';

export const MASTER_ID = 'master';

// Resolve the caller. Replies 503/401 and returns null when unauthenticated;
// on success returns { id, name, role: 'master' | 'member' }.
export async function requireUser(req, res) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    res.status(503).json({ error: 'Server not configured: set APP_PASSWORD in the Vercel project env vars.' });
    return null;
  }
  const pw = req.headers['x-app-password'];
  if (pw && safeEqual(pw, expected)) {
    return { id: MASTER_ID, name: process.env.MASTER_NAME || 'Coach', role: 'master' };
  }
  if (pw) {
    const member = findMemberByPassword(await getRoster(), pw);
    if (member) return { id: member.id, name: member.name, role: 'member' };
  }
  res.status(401).json({ error: 'Unauthorized — wrong app password.' });
  return null;
}

// Master-only gate for team management and the team report.
export async function requireMaster(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'master') {
    res.status(403).json({ error: 'Master user only.' });
    return null;
  }
  return user;
}
