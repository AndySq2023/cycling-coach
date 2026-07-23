// Plan-date sanity helpers, shared conceptually with the app (app/cycling-coach.html
// has the same logic client-side). Used by api/state.js to heal a plan at the KV door.
//
// This file is all that remains of the old api/_prompt.js — a server-side mirror of the
// app's whole coach prompt + schedule-block parsers that existed only so the Telegram
// bot and the daily cron briefing could run the coach without a browser. Both were
// removed (the briefing now runs in-app, on first open of the day), so the coach's
// "brain" lives in exactly one place again: app/cycling-coach.html. The only thing the
// server still needs is date-repair on the state it stores.

// ── MODEL-WRITTEN DATES ARE NEVER TRUSTED ───────────────────────────────────────
// The coach LLM's day-of-week arithmetic is anchored to its training-era calendar —
// it once wrote an entire week dated 2025 while the ground-truth prompt said 2026.
// Every date arriving in a plan passes through here: implausible dates are re-derived
// from the day name, and the day name is always recomputed from the final date so the
// pair can never disagree.
function parsePlanDate(ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds || '')) return null;
  const d = new Date(ds + 'T12:00:00');
  return isNaN(d) ? null : d;
}
function isoPlanDate(d) { return d.toISOString().slice(0, 10); }
function weekdayName(d) { return d.toLocaleDateString('en-GB', { weekday: 'long' }); }
// Yesterday..today+13: wide enough to log yesterday's ride or lay out two weeks,
// narrow enough to reject a wrong-year date outright.
function plausiblePlanDate(d) {
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const diff = Math.round((d - noon) / 86400000);
  return diff >= -1 && diff <= 13;
}
function normalizePlanDates(plan) {
  const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  let prev = null;
  return plan.map(s => {
    let d = parsePlanDate(s.date);
    if (!d || !plausiblePlanDate(d)) {
      // Re-derive from the day name: the next occurrence of that weekday after the
      // previous session (or from yesterday for the first session).
      const target = WEEKDAYS.indexOf(String(s.day || '').trim());
      d = prev ? new Date(prev.getTime() + 86400000) : new Date(noon.getTime() - 86400000);
      if (target >= 0) while (d.getDay() !== target) d = new Date(d.getTime() + 86400000);
    }
    prev = d;
    return { ...s, date: isoPlanDate(d), day: weekdayName(d) };
  });
}
// Heal a plan that already carries wrong-year dates (written by an older code path
// that predates the write-time guard). >60 days off is never a real training week —
// plans roll weekly — only model-calendar corruption, so a stale-but-real past week
// is left untouched. Returns the same array reference when nothing needed fixing.
export function repairPlanDates(plan) {
  if (!Array.isArray(plan) || !plan.length) return plan;
  const bad = plan.some(s => {
    const d = parsePlanDate(s.date);
    return !d || Math.abs(Math.round((d - Date.now()) / 86400000)) > 60;
  });
  return bad ? normalizePlanDates(plan) : plan;
}
