// Vercel serverless function — replaces the local Claude Desktop bridge (localhost:3001/api/chat).
// Thin proxy to the Anthropic Messages API using a server-side key. Takes the same
// { system, messages } the app already sends and returns the same Anthropic response
// shape ({ content: [{ type: 'text', text }], ... }), so the front-end is unchanged.
//
// Cost control: every Claude call spends the master's API credits, so members get a
// per-day message quota (CHAT_DAILY_LIMIT env var, default 40). The master is exempt.
// The counter lives in KV; if KV is down the limit is NOT enforced (fail-open) so a
// KV outage can't lock the team out of the coach.
import { requireUser } from './_auth.js';
import { kvIncr } from './_kv.js';

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_DAILY_LIMIT = 40;

// ── COST GUARDS ───────────────────────────────────────────────────────────────
// The daily quota caps how MANY messages a member sends, not how BIG they are —
// so on its own it bounds nothing: one request can carry a book. These cap the
// size of a single call, and the daily quota then bounds the day. Deliberately
// generous: the app's own system prompt (live data + plan + memory) runs ~8-12k
// chars and a long conversation adds more, so this only stops genuine abuse and
// runaway loops, never normal coaching use.
const MAX_SYSTEM_CHARS = 60000;   // ~15k tokens — the app's prompt is well under
const MAX_MESSAGES_CHARS = 400000; // ~100k tokens of history
const MAX_MESSAGES = 400;          // entries; the app rolls at 60

const charCount = (messages) => messages.reduce(
  (n, m) => n + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length), 0);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const user = await requireUser(req, res);
  if (!user) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(503).json({ error: 'Server missing ANTHROPIC_API_KEY.' }); return; }

  const { system, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Request needs a non-empty messages[] array.' });
    return;
  }

  // Size guards run BEFORE the quota is spent and before the upstream call, so an
  // oversized request costs nothing — neither credits nor one of the day's messages.
  // { error } over HTTP 200 so the app's existing error path surfaces it in the chat.
  if (typeof system === 'string' && system.length > MAX_SYSTEM_CHARS) {
    res.status(200).json({ error: 'That request is too large to send (system prompt). Try clearing some chat history.' });
    return;
  }
  if (messages.length > MAX_MESSAGES || charCount(messages) > MAX_MESSAGES_CHARS) {
    res.status(200).json({ error: 'That conversation is too long to send. Clear some chat history and try again.' });
    return;
  }

  if (user.role !== 'master') {
    const limit = Math.max(1, parseInt(process.env.CHAT_DAILY_LIMIT, 10) || DEFAULT_DAILY_LIMIT);
    const day = new Date().toISOString().slice(0, 10);
    const used = await kvIncr(`chat_uses:${user.id}:${day}`, 2 * 86400);
    if (used != null && used > limit) {
      // { error } over HTTP 200 so the app's existing error path shows it in the chat.
      res.status(200).json({ error: `Daily coach-message limit reached (${limit}/day). It resets at midnight UTC — see you tomorrow!` });
      return;
    }
  }

  try {
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
    if (!r.ok) {
      // Surface as { error } (HTTP 200) so the app's existing `if (data.error)` path shows it.
      res.status(200).json({ error: data?.error?.message || `Anthropic error ${r.status}` });
      return;
    }
    res.status(200).json(data);
  } catch (err) {
    res.status(200).json({ error: err?.message || String(err) });
  }
}
