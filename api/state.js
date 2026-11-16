// Vercel serverless function — the web app's sync endpoint for coach state.
// GET  → returns { plan, feedback, adaptations, goal, ftp, ftpLog, weightLog, home, conversationHistory, briefing }
// PUT  → replaces the stored state with the body (a full localStorage snapshot).
//
// Needs KV configured (KV_REST_API_URL); without it, GET returns empty state and
// PUT is a silent no-op.
import { requireAuth } from './_auth.js';
import { getState, setState } from './_state.js';
import { repairPlanDates } from './_dates.js';

// JSON size guard for the coach-proposal fields: they hold plan/library copies, so a
// buggy client could otherwise grow the blob every device pulls.
const fits = (v, max) => { try { return JSON.stringify(v).length <= max; } catch { return false; } };

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      // env lets the app badge a preview deployment (its KV is namespaced — see _kv.js envKey).
      res.status(200).json({ ...(await getState()), env: process.env.VERCEL_ENV || 'development' });
      return;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const b = req.body || {};
      const saved = await setState({
        // repairPlanDates: an old app bundle can still push a wrong-year plan —
        // heal it at the door so every device pulls corrected dates.
        plan: repairPlanDates(Array.isArray(b.plan) ? b.plan : []),
        feedback: b.feedback && typeof b.feedback === 'object' ? b.feedback : {},
        adaptations: b.adaptations && typeof b.adaptations === 'object' ? b.adaptations : {},
        goal: b.goal || null,
        // FTP in watts. Bounded to a plausible human range so a bad client can't
        // poison the zones every session intensity is derived from.
        ftp: (Number.isFinite(+b.ftp) && +b.ftp >= 60 && +b.ftp <= 600) ? Math.round(+b.ftp) : null,
        // Every value FTP has been set to — the 3-month tracker on Insights plots it.
        ftpLog: Array.isArray(b.ftpLog)
          ? b.ftpLog
              .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(+e.ftp) && +e.ftp >= 60 && +e.ftp <= 600)
              .map(e => ({ date: e.date, ftp: Math.round(+e.ftp) }))
              .slice(-60)
          : [],
        // Daily weight — the weight tracker on Insights plots it against the target.
        // Bounded here too: WHOOP can auto-log one point a day indefinitely, so an
        // unbounded array would grow the blob every device pulls on every focus.
        weightLog: Array.isArray(b.weightLog)
          ? b.weightLog
              .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number.isFinite(+e.kg) && +e.kg >= 30 && +e.kg <= 300)
              .map(e => ({ date: e.date, kg: +(+e.kg).toFixed(1) }))
              .slice(-200)
          : [],
        home: b.home || null,
        // Durable coach memory. Bounded here too so a bad client can't grow the blob.
        coachNotes: Array.isArray(b.coachNotes)
          ? b.coachNotes.filter(n => typeof n === 'string' && n.trim()).slice(0, 40).map(n => n.slice(0, 220))
          : [],
        // Coach-authored resistance sessions (Resistance tab). Bounded so a bad client
        // can't grow the blob; the app re-normalizes shape on read.
        resistance: Array.isArray(b.resistance) ? b.resistance.slice(0, 20) : [],
        // Logged strength sessions. Two sessions a week means ~100 a year, so the
        // 200 cap is roughly two years of history — bounded because, unlike the
        // library, this only ever grows, and every device pulls the whole blob.
        strengthLog: Array.isArray(b.strengthLog)
          ? b.strengthLog
              .filter(e => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
              .slice(-200)
          : [],
        // Coach proposals (see shared/proposal-core.js). A pending proposal, the last 10
        // undo snapshots, the last 30 dismissals and the last quiet review.
        pendingProposal: (b.pendingProposal && typeof b.pendingProposal === 'object' && Array.isArray(b.pendingProposal.changes)
          && b.pendingProposal.changes.length <= 20 && fits(b.pendingProposal, 60000)) ? b.pendingProposal : null,
        snapshots: Array.isArray(b.snapshots)
          ? b.snapshots.filter(x => x && typeof x === 'object' && Array.isArray(x.plan) && fits(x, 80000)).slice(-10)
          : [],
        dismissals: Array.isArray(b.dismissals)
          ? b.dismissals.filter(d => d && typeof d.type === 'string' && fits(d, 4000)).slice(-30)
          : [],
        review: (b.review && typeof b.review === 'object' && typeof b.review.text === 'string')
          ? { date: String(b.review.date || '').slice(0, 10), text: b.review.text.slice(0, 600), source: String(b.review.source || '').slice(0, 20) }
          : null,
        conversationHistory: Array.isArray(b.conversationHistory) ? b.conversationHistory : [],
        // Today's morning briefing — shared across devices so it's generated once and
        // every device shows the same weather read and plan, not a fresh AI call each.
        briefing: (b.briefing && typeof b.briefing === 'object' && typeof b.briefing.text === 'string')
          ? { date: String(b.briefing.date || ''), text: b.briefing.text.slice(0, 4000), whoopSig: String(b.briefing.whoopSig || '') }
          : null,
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
