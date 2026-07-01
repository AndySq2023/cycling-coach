// Single-user shared state for the cycling coach — the bridge between the web app
// (browser localStorage) and the Telegram bot (server-side). Both read and write the
// same KV blob so the schedule, training plan, goal and conversation history are
// visible from either surface.
//
// This is deliberately single-user: one KV key holds everything. The hosted app is
// already gated behind a single APP_PASSWORD and the bot behind a single chat id, so
// there is exactly one athlete. Multi-user would key these by athlete id.
import { kvGet, kvSet } from './_kv.js';

const STATE_KEY = 'coach_state';
const MAX_HISTORY = 120; // entries (≈60 exchanges) — mirrors the app's localStorage cap

// Default-shaped empty state so callers never have to null-check every field.
function emptyState() {
  return {
    plan: [],            // trainingPlan — array of session objects
    feedback: {},        // sessionFeedback keyed by session id
    adaptations: {},     // adaptationNotes keyed by session id
    goal: null,          // free-text athlete goal
    home: null,          // "lat,lon" for weather, or null
    conversationHistory: [], // [{ role:'user'|'assistant', content }]
    updatedAt: null,
    updatedBy: null,     // 'app' | 'telegram'
  };
}

export async function getState() {
  const s = await kvGet(STATE_KEY);
  return { ...emptyState(), ...(s && typeof s === 'object' ? s : {}) };
}

export async function setState(state) {
  const next = { ...emptyState(), ...state };
  if (Array.isArray(next.conversationHistory) && next.conversationHistory.length > MAX_HISTORY) {
    next.conversationHistory = next.conversationHistory.slice(-MAX_HISTORY);
  }
  next.updatedAt = new Date().toISOString();
  await kvSet(STATE_KEY, next);
  return next;
}

// Append a user turn and the coach's reply to the shared history, persisting the result.
// Used by the Telegram webhook so its exchanges show up in the app on next sync.
export async function appendTurns(state, userText, assistantText) {
  const history = Array.isArray(state.conversationHistory) ? state.conversationHistory.slice() : [];
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });
  return setState({ ...state, conversationHistory: history });
}
