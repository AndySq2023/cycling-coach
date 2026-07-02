// Vercel serverless function — the web app's sync endpoint for per-user coach state.
// GET  → returns the caller's { plan, feedback, adaptations, goal, home,
//        conversationHistory } PLUS a `user: { id, name, role }` field so the app
//        knows who it is (the app shows the Team tab only to role 'master').
// PUT  → replaces the caller's state with the body (a full localStorage snapshot).
//
// Which blob is read/written is decided by WHO authenticates (requireUser), so a
// member can never see or overwrite another athlete's plan or conversation.
// Needs KV configured (KV_REST_API_URL); without it, GET returns empty state and
// PUT is a silent no-op.
import { requireUser } from './_auth.js';
import { getState, setState } from './_state.js';

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const state = await getState(user.id);
      res.status(200).json({ ...state, user: { id: user.id, name: user.name, role: user.role } });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const b = req.body || {};
      const saved = await setState(user.id, {
        plan: Array.isArray(b.plan) ? b.plan : [],
        feedback: b.feedback && typeof b.feedback === 'object' ? b.feedback : {},
        adaptations: b.adaptations && typeof b.adaptations === 'object' ? b.adaptations : {},
        goal: b.goal || null,
        home: b.home || null,
        conversationHistory: Array.isArray(b.conversationHistory) ? b.conversationHistory : [],
        updatedBy: 'app',
      });
      res.status(200).json({ ok: true, updatedAt: saved.updatedAt });
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(200).json({ error: err?.message || String(err) });
  }
}
