// Vercel serverless function — Telegram webhook for the cycling coach.
// Lets the athlete chat with the same Claude-backed coach over Telegram, with full
// context: live WHOOP + Strava + weather (fetched server-side per message), the active
// training plan and goal, and the recent conversation history shared with the web app
// (api/_state.js). The coach can also WRITE the schedule from Telegram via the same
// schedule_set / schedule_update blocks the web chat uses.
//
// Register the webhook once (see DEPLOY.md):
//   https://api.telegram.org/bot<TOKEN>/setWebhook
//     ?url=https://<app>.vercel.app/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
//
// Env vars (Vercel project):
//   TELEGRAM_BOT_TOKEN       — from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  — random string, also passed to setWebhook's secret_token
//   TELEGRAM_CHAT_ID         — the ONLY chat id allowed to talk to the bot (your own)
//   ANTHROPIC_API_KEY, plus the WHOOP/STRAVA/WINDY creds the data functions need.
import { getState, setState, appendTurns } from './_state.js';
import { kvGet, kvSet } from './_kv.js';
import { buildSystemPrompt, extractScheduleUpdates, applyScheduleBlocks } from './_prompt.js';
import { getStravaSummary } from './strava.js';
import { getWhoopSummary } from './whoop.js';
import { getForecast } from './windy.js';

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';
const TG_LIMIT = 4096; // Telegram per-message character cap

const tgApi = (method) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

async function tgSend(chatId, text) {
  // Telegram rejects messages over 4096 chars — split on paragraph/line boundaries.
  for (const chunk of chunkText(text, TG_LIMIT)) {
    await fetch(tgApi('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Plain text (no parse_mode): the coach's free-form Markdown would otherwise trip
      // Telegram's strict entity parser and 400 the whole message.
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
    }).catch(() => {});
  }
}

async function tgTyping(chatId) {
  await fetch(tgApi('sendChatAction'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}

function chunkText(text, max) {
  const t = (text || '').trim() || '(no reply)';
  if (t.length <= max) return [t];
  const out = [];
  let buf = '';
  for (const para of t.split(/\n\n+/)) {
    if ((buf + '\n\n' + para).length > max) {
      if (buf) out.push(buf);
      if (para.length > max) { // a single huge paragraph — hard-split
        for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max));
        buf = '';
      } else buf = para;
    } else {
      buf = buf ? buf + '\n\n' + para : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Render the current plan as a plain-text schedule for the /plan command (no Claude call).
function renderPlanText(plan, feedback) {
  if (!plan?.length) return 'No training plan yet. Just ask me to build you a week.';
  const today = new Date().toISOString().slice(0, 10);
  const lines = plan.map(s => {
    const tag = s.date === today ? ' ← TODAY' : '';
    const done = feedback?.[s.id] ? ` ✓ (RPE ${feedback[s.id].rpe})` : '';
    const dur = s.duration > 0 ? ` · ${s.duration}min` : '';
    return `${s.day} ${s.date}${tag}\n  ${s.type}${dur}${s.targets ? ` · ${s.targets}` : ''}${done}`;
  });
  return '🗓 Your week:\n\n' + lines.join('\n');
}

// Fetch live context the same way the app does, tolerating individual failures so one
// dead data source never blocks the coach from replying.
async function gatherContext(state) {
  const home = typeof state.home === 'string' ? state.home.split(',').map(Number) : null;
  const wantWeather = home && home.length === 2 && home.every(Number.isFinite);

  const [whoopR, stravaR, weatherR] = await Promise.allSettled([
    getWhoopSummary(),
    getStravaSummary(),
    wantWeather ? getForecast(home[0], home[1]) : Promise.resolve(null),
  ]);
  const ok = (r) => r.status === 'fulfilled' && r.value && !r.value.error ? r.value : null;
  return { whoop: ok(whoopR), strava: ok(stravaR), weather: ok(weatherR) };
}

async function callClaude(system, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Server missing ANTHROPIC_API_KEY.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Anthropic error ${r.status}`);
  return data?.content?.[0]?.text || '';
}

export default async function handler(req, res) {
  // Always 200 to Telegram unless auth fails — a non-200 makes Telegram retry the same
  // update, which would double-charge the API. Errors are reported to the user instead.
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Verify the secret Telegram echoes back, so only Telegram can drive this endpoint.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const update = req.body || {};
  const msg = update.message || update.edited_message;
  const chatId = msg?.chat?.id;
  const text = (msg?.text || '').trim();

  // Lock to the single allowed athlete. Anyone else is silently ignored (no reply, so
  // the bot is not a spam/credit-burn vector for strangers who find it).
  if (!chatId || String(chatId) !== String(process.env.TELEGRAM_CHAT_ID)) {
    res.status(200).json({ ok: true, ignored: 'unauthorized chat' });
    return;
  }

  // Dedupe: Telegram resends the SAME update_id on retry. Mark it processed up-front
  // (before the slow Claude call) so a retry mid-processing is skipped, not re-run.
  const updateId = update.update_id;
  if (updateId != null) {
    const last = await kvGet('telegram_last_update');
    if (last != null && updateId <= last) { res.status(200).json({ ok: true, deduped: true }); return; }
    await kvSet('telegram_last_update', updateId);
  }

  // Ack Telegram immediately is not possible on Vercel (function ends at response), so we
  // do the work then 200. Send a typing indicator for UX while Claude thinks.
  try {
    if (!text) { await tgSend(chatId, 'Send me a message and I’ll coach you through it. /plan shows your week, /reset clears our chat.'); res.status(200).json({ ok: true }); return; }

    const cmd = text.toLowerCase();
    if (cmd === '/start' || cmd === '/help') {
      await tgSend(chatId, '🚴 I’m your cycling coach. I can see your WHOOP recovery, Strava rides, weather, and your training plan — and I can update your schedule. Just talk to me.\n\n/plan — show this week\n/reset — clear our conversation');
      res.status(200).json({ ok: true });
      return;
    }

    const state = await getState();

    if (cmd === '/plan' || cmd === '/schedule') {
      await tgSend(chatId, renderPlanText(state.plan, state.feedback));
      res.status(200).json({ ok: true });
      return;
    }
    if (cmd === '/reset') {
      await setState({ ...state, conversationHistory: [], updatedBy: 'telegram' });
      await tgSend(chatId, '🧹 Conversation cleared. Fresh start — your plan and data are untouched.');
      res.status(200).json({ ok: true });
      return;
    }

    await tgTyping(chatId);

    const ctx = await gatherContext(state);
    const system = buildSystemPrompt({
      whoop: ctx.whoop, strava: ctx.strava, weather: ctx.weather,
      goal: state.goal, plan: state.plan, feedback: state.feedback,
    });
    const messages = [...(state.conversationHistory || []), { role: 'user', content: text }];

    const reply = await callClaude(system, messages);
    const { clean, updates, planSet } = extractScheduleUpdates(reply);

    // Apply any schedule writes to the shared state.
    const applied = applyScheduleBlocks(state, { updates, planSet });

    // What the athlete actually sees (and what we store as the assistant turn). Guard
    // against an empty string: a reply that was ONLY a schedule block leaves `clean` blank,
    // and an empty assistant turn would make the NEXT Claude call 400.
    let outText = clean;
    if (applied.changed) outText += (outText ? '\n\n' : '') + (planSet ? '🗓 I’ve rebuilt your schedule — check the app.' : '🗓 Schedule updated — check the app.');
    if (!outText) outText = 'Done.';

    // Append this exchange to the shared history so it shows up in the web app on sync.
    const finalState = { ...applied.state, updatedBy: 'telegram' };
    await appendTurns(finalState, text, outText);

    await tgSend(chatId, outText);

    res.status(200).json({ ok: true });
  } catch (err) {
    await tgSend(chatId, `⚠️ Coach error: ${err?.message || String(err)}`);
    res.status(200).json({ ok: true, error: err?.message || String(err) });
  }
}
