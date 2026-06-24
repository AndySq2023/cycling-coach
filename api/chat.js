// Vercel serverless function — replaces the local Claude Desktop bridge (localhost:3001/api/chat).
// Thin proxy to the Anthropic Messages API using a server-side key. Takes the same
// { system, messages } the app already sends and returns the same Anthropic response
// shape ({ content: [{ type: 'text', text }], ... }), so the front-end is unchanged.
import { requirePassword } from './_auth.js';

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!requirePassword(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(503).json({ error: 'Server missing ANTHROPIC_API_KEY.' }); return; }

  const { system, messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Request needs a non-empty messages[] array.' });
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
