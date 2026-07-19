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
import { buildSystemPrompt, extractScheduleUpdates, extractRouteRequest, extractHomeSet, applyScheduleBlocks } from './_prompt.js';
import { planRouteCached, geocodePlace } from './route.js';
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

// Execute a route_request block server-side (same planner the web app's /api/route
// calls, cache included) and return the athlete-facing lines for the Telegram message.
// Never throws — a routing failure becomes a ⚠️ line rather than sinking the reply.
async function runRouteRequest(routeRequest, state) {
  const home = typeof state.home === 'string' ? state.home.split(',').map(Number) : null;
  if (!home || home.length !== 2 || !home.every(Number.isFinite)) {
    return "⚠️ I don't have a home location to route from yet — tell me where you live/ride from and I'll set it.";
  }
  try {
    const data = await planRouteCached({ ...routeRequest, lat: home[0], lon: home[1] });
    const r = data.mode === 'loop' ? data.best : data;
    const label = data.mode === 'loop'
      ? `Loop (target ${data.target_mi} mi, tried ${data.candidates_tried} options)`
      : `Out and back${data.destination_name ? ` to ${data.destination_name}` : ''}`;
    const degradedNote = data.fallback === 'sampled'
      ? `\nℹ️ True hill-avoidance isn’t available on the free GraphHopper plan, so I compared ${data.candidates_tried} loop options and picked the flattest.`
      : data.fallback === 'alternatives'
        ? `\nℹ️ Shortest-distance routing isn’t available on the free GraphHopper plan, so I compared ${data.alternatives_tried} road alternatives and picked the best.`
        : data.degraded
          ? '\n⚠️ Custom routing (hill-avoidance / shortest-distance) isn’t available on the free GraphHopper plan and no workaround applied — this is the default route.'
          : '';
    return `📍 ${label}\n${r.distance_mi} mi, ${r.ascent_ft ?? '?'} ft ascent, ~${r.duration_min} min riding.${degradedNote}\n(Ask from the app if you want the GPX download.)`;
  } catch (err) {
    return `⚠️ Couldn't plan that route: ${err?.message || String(err)}`;
  }
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

    // The Telegram bot is master-only (locked to TELEGRAM_CHAT_ID), so it always
    // reads/writes the master's state blob. Per-member Telegram would map chat ids
    // to roster user ids here.
    const state = await getState('master');

    if (cmd === '/plan' || cmd === '/schedule') {
      await tgSend(chatId, renderPlanText(state.plan, state.feedback));
      res.status(200).json({ ok: true });
      return;
    }
    if (cmd === '/reset') {
      await setState('master', { ...state, conversationHistory: [], updatedBy: 'telegram' });
      await tgSend(chatId, '🧹 Conversation cleared. Fresh start — your plan and data are untouched.');
      res.status(200).json({ ok: true });
      return;
    }

    await tgTyping(chatId);

    const ctx = await gatherContext(state);
    const system = buildSystemPrompt({
      whoop: ctx.whoop, strava: ctx.strava, weather: ctx.weather,
      goal: state.goal, plan: state.plan, feedback: state.feedback,
      routes: true, // this path executes route_request/home_set blocks below
    });
    const messages = [...(state.conversationHistory || []), { role: 'user', content: text }];

    const reply = await callClaude(system, messages);
    const { clean: schedClean, updates, planSet } = extractScheduleUpdates(reply);
    const { clean: homeClean, homeSet } = extractHomeSet(schedClean);
    const { clean, routeRequest } = extractRouteRequest(homeClean);

    // Apply any schedule writes to the shared state.
    const applied = applyScheduleBlocks(state, { updates, planSet });
    let finalState = { ...applied.state, updatedBy: 'telegram' };

    // What the athlete actually sees (and what we store as the assistant turn). Guard
    // against an empty string: a reply that was ONLY a schedule block leaves `clean` blank,
    // and an empty assistant turn would make the NEXT Claude call 400.
    let outText = clean;
    if (applied.changed) outText += (outText ? '\n\n' : '') + (planSet ? '🗓 I’ve rebuilt your schedule — check the app.' : '🗓 Schedule updated — check the app.');

    // Home location: geocode the coach's "place" server-side when possible, falling
    // back to its own approximate coordinates. Stored in the same "lat,lon" string
    // form the app writes (gatherContext parses it back).
    if (homeSet) {
      let hLat = parseFloat(homeSet.lat), hLon = parseFloat(homeSet.lon), hLabel = homeSet.label;
      if (homeSet.place) {
        try {
          const hit = await geocodePlace(homeSet.place);
          if (hit) { hLat = hit.lat; hLon = hit.lon; hLabel = hit.name || hLabel; }
        } catch (err) { console.warn('home_set geocoding failed, using coach coords:', err.message); }
      }
      if (Number.isFinite(hLat) && Number.isFinite(hLon)) {
        finalState = { ...finalState, home: `${hLat.toFixed(4)},${hLon.toFixed(4)}` };
        outText += (outText ? '\n\n' : '') + `📍 Home location set${hLabel ? ` — ${hLabel}` : ''}.`;
      }
    }

    // Route planning. The prompt only allows route_request when the athlete explicitly
    // asked; home is read from finalState so a home_set in the same reply counts.
    if (routeRequest) {
      outText += (outText ? '\n\n' : '') + await runRouteRequest(routeRequest, finalState);
    }

    if (!outText) outText = 'Done.';

    // Append this exchange to the shared history so it shows up in the web app on sync
    // (route results included — the coach keeps its memory of what it planned).
    await appendTurns('master', finalState, text, outText);

    await tgSend(chatId, outText);

    res.status(200).json({ ok: true });
  } catch (err) {
    await tgSend(chatId, `⚠️ Coach error: ${err?.message || String(err)}`);
    res.status(200).json({ ok: true, error: err?.message || String(err) });
  }
}
