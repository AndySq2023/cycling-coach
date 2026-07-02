// Coach plumbing for api/briefing.js (the daily-briefing cron): sending Telegram
// messages, gathering live athlete context, and calling Claude. Copied from
// api/telegram.js (which keeps its own private copies — it had in-flight multi-user
// changes when this was added). If the two drift, telegram.js is the source of truth.
import { getStravaSummary } from './strava.js';
import { getWhoopSummary } from './whoop.js';
import { getForecast } from './windy.js';

export const MODEL = 'claude-opus-4-8';
export const MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';
const TG_LIMIT = 4096; // Telegram per-message character cap

const tgApi = (method) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

export async function tgSend(chatId, text) {
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

export async function tgTyping(chatId) {
  await fetch(tgApi('sendChatAction'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}

export function chunkText(text, max) {
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

// Fetch live context the same way the app does, tolerating individual failures so one
// dead data source never blocks the coach from replying.
export async function gatherContext(state) {
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

export async function callClaude(system, messages) {
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
