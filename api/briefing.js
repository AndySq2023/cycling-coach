// Vercel serverless function — the coach's automated daily Telegram briefing.
// Triggered by Vercel Cron (see vercel.json: 07:20 UTC = 8:20am UK summer time).
// Gathers the same live context as the Telegram webhook (WHOOP recovery, Strava,
// weather, the active plan from KV), asks Claude to write a short morning briefing,
// and sends it to the athlete's Telegram chat. The coach may adapt today's session
// (schedule_update) if recovery warrants — same write path as the webhook.
//
// The exchange is appended to the shared conversation history, so the briefing also
// shows up in the web app's chat and the coach remembers what it told you.
//
// State access goes through kvGet/kvSet on the master blob directly (not _state.js):
// the briefing is master-only, the master key is stable ('coach_state'), and this
// keeps the function independent of the _state.js signature (which is changing for
// multi-user support).
//
// Auth: Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when the CRON_SECRET
// env var is set. Set it (any random string) or this endpoint refuses to run — it
// spends API credits and messages you, so it must not be publicly triggerable.
// Manual test: curl -H "Authorization: Bearer <CRON_SECRET>" https://<app>/api/briefing
import { kvGet, kvSet } from './_kv.js';
import { buildSystemPrompt, extractScheduleUpdates, applyScheduleBlocks } from './_prompt.js';
import { tgSend, gatherContext, callClaude } from './_coach.js';

const STATE_KEY = 'coach_state'; // the master athlete's blob — same key _state.js uses
const MAX_HISTORY = 120;         // mirrors _state.js / the app's localStorage cap

// What we "say" to the coach on the athlete's behalf. Stored in the shared history,
// so keep the visible part short and clearly machine-sent.
const BRIEFING_ASK = `(Automated 8:20am daily briefing — the athlete did not type this.)
Write my morning briefing. Cover, briefly:
1. Recovery read — today's WHOOP numbers and what they mean for training.
2. Today's session — what's on the schedule. If recovery clearly warrants changing it, adapt it (you can emit a schedule_update) and say why. If there's no plan, suggest what today should be.
3. Ride window — if you have the weather, the best time slot to ride and any kit notes.
Keep it tight and phone-skimmable: this is a morning nudge, not an essay. Don't ask questions — the athlete may not reply.

Hard rules for this briefing:
- Ground every number and every claim in the data above. If WHOOP data is absent, open with "(No WHOOP data this morning)" and do NOT invent, estimate, or infer a recovery status. Same for missing Strava or weather — say it's unavailable rather than guessing.
- The ACTIVE TRAINING SCHEDULE is authoritative. If today is a Rest Day, the briefing protects the rest day — do not prescribe a ride. Never describe a workout that contradicts today's scheduled session; if you believe it should change, change it via schedule_update and explain.
- The most recent ride and its date come from the GROUND TRUTH block — restate them exactly, never from memory of the conversation.
- The athlete has NO power meter: never give wattage targets or power zones. Use heart rate, RPE, and duration only.`;

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    res.status(200).json({ error: 'Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).' });
    return;
  }

  try {
    const state = (await kvGet(STATE_KEY)) || {};
    const ctx = await gatherContext(state);
    // Which sources made it into the prompt — shows up in Vercel logs, so a bad
    // briefing can be traced to the data that was (or wasn't) behind it.
    const sources = {
      whoop: !!ctx.whoop, strava: !!ctx.strava, weather: !!ctx.weather,
      planSessions: Array.isArray(state.plan) ? state.plan.length : 0,
      historyTurns: Array.isArray(state.conversationHistory) ? state.conversationHistory.length : 0,
    };
    console.log('briefing sources:', JSON.stringify(sources));
    const system = buildSystemPrompt({
      whoop: ctx.whoop, strava: ctx.strava, weather: ctx.weather,
      goal: state.goal, plan: state.plan, feedback: state.feedback,
    });
    const messages = [...(state.conversationHistory || []), { role: 'user', content: BRIEFING_ASK }];

    const reply = await callClaude(system, messages);
    const { clean, updates, planSet } = extractScheduleUpdates(reply);
    const applied = applyScheduleBlocks(state, { updates, planSet });

    let outText = clean;
    if (applied.changed) outText += (outText ? '\n\n' : '') + '🗓 Schedule updated — check the app.';
    if (!outText) outText = 'Morning! No briefing today — data sources were quiet.';
    outText = '☀️ ' + outText;

    // Append the exchange to the shared history (short marker as the "user" turn so
    // the web app's chat reads sensibly) and persist the whole blob back.
    const history = [...(applied.state.conversationHistory || []),
      { role: 'user', content: '(automated) ☀️ Morning briefing' },
      { role: 'assistant', content: outText },
    ].slice(-MAX_HISTORY);
    await kvSet(STATE_KEY, {
      ...applied.state,
      conversationHistory: history,
      updatedAt: new Date().toISOString(),
      updatedBy: 'telegram',
    });

    await tgSend(chatId, outText);
    res.status(200).json({ ok: true, sent: true, scheduleChanged: !!applied.changed, sources });
  } catch (err) {
    // Surface the failure in Telegram too — a silent missing briefing is invisible.
    await tgSend(chatId, `⚠️ Morning briefing failed: ${err?.message || String(err)}`);
    res.status(200).json({ ok: false, error: err?.message || String(err) });
  }
}
