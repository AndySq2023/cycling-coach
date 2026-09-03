// Vercel serverless function — replaces the local Claude Desktop bridge (localhost:3001/api/chat).
// Thin proxy to the Anthropic Messages API using a server-side key. Takes the same
// { system, messages } the app already sends and returns the same Anthropic response
// shape ({ content: [{ type: 'text', text }], ... }), so the front-end is unchanged.
import { requireAuth } from './_auth.js';

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

// ── COST GUARDS ───────────────────────────────────────────────────────────────
// Cap the size of a single call. Deliberately generous: the app's own system prompt
// (live data + plan + memory) runs ~8-12k chars and a long conversation adds more,
// so this only stops genuine abuse and runaway loops, never normal coaching use.
const MAX_SYSTEM_CHARS = 60000;   // ~15k tokens — the app's prompt is well under
const MAX_MESSAGES_CHARS = 400000; // ~100k tokens of history
const MAX_MESSAGES = 400;          // entries; the app rolls at 60

const charCount = (messages) => messages.reduce(
  (n, m) => n + (typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length), 0);

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!requireAuth(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(503).json({ error: 'Server missing ANTHROPIC_API_KEY.' }); return; }

  const { system, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Request needs a non-empty messages[] array.' });
    return;
  }

  // Size guards run BEFORE the upstream call, so an oversized request costs nothing.
  // { error } over HTTP 200 so the app's existing error path surfaces it in the chat.
  if (typeof system === 'string' && system.length > MAX_SYSTEM_CHARS) {
    res.status(200).json({ error: 'That request is too large to send (system prompt). Try clearing some chat history.' });
    return;
  }
  if (messages.length > MAX_MESSAGES || charCount(messages) > MAX_MESSAGES_CHARS) {
    res.status(200).json({ error: 'That conversation is too long to send. Clear some chat history and try again.' });
    return;
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
