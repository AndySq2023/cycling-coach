// Vercel serverless function — the web app's sync endpoint for the shared coach state.
// GET  → returns the current { plan, feedback, adaptations, goal, home, conversationHistory }.
// PUT  → replaces it with the body (the app pushes a full snapshot of its localStorage).
//
// This is what lets the Telegram bot "see" the schedule, plan and recent conversations:
// the app mirrors its localStorage here, the bot reads/writes the same blob. Password-
// gated like every other hosted function. Needs KV configured (KV_REST_API_URL); without
// it, GET returns empty state and PUT is a silent no-op.
import { requirePassword } from './_auth.js';
import { getState, setState } from './_state.js';

export default async function handler(req, res) {
  if (!requirePassword(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      res.status(200).json(await getState());
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const b = req.body || {};
      const saved = await setState({
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
