// Per-user coach state — the bridge between the web app (browser localStorage) and
// the server (Telegram bot, team report). Each athlete's schedule, training plan,
// goal and conversation history live in their own KV blob:
//   master  → 'coach_state'          (the original single-user key, kept for
//                                     backward compatibility with existing deploys)
//   members → 'coach_state:<userId>'
import { kvGet, kvSet } from './_kv.js';

const STATE_KEY = 'coach_state';
const MAX_HISTORY = 120; // entries (≈60 exchanges) — mirrors the app's localStorage cap

export function stateKey(userId = 'master') {
  return userId === 'master' ? STATE_KEY : `${STATE_KEY}:${userId}`;
}

// Default-shaped empty state so callers never have to null-check every field.
function emptyState() {
  return {
    plan: [],            // trainingPlan — array of session objects
    feedback: {},        // sessionFeedback keyed by session id
    adaptations: {},     // adaptationNotes keyed by session id
    goal: null,          // free-text athlete goal
    home: null,          // "lat,lon" for weather, or null
    coachNotes: [],      // durable facts the coach remembers about the athlete
    resistance: [],      // coach-authored strength sessions (Resistance tab)
    conversationHistory: [], // [{ role:'user'|'assistant', content }]
    briefing: null,       // { date, text, whoopSig } — today's morning briefing, shared
                           // across devices so only one is ever generated per day
    updatedAt: null,
    updatedBy: null,     // 'app' | 'telegram'
  };
}

export async function getState(userId = 'master') {
  const s = await kvGet(stateKey(userId));
  return { ...emptyState(), ...(s && typeof s === 'object' ? s : {}) };
}

export async function setState(userId, state) {
  const next = { ...emptyState(), ...state };
  if (Array.isArray(next.conversationHistory) && next.conversationHistory.length > MAX_HISTORY) {
    next.conversationHistory = next.conversationHistory.slice(-MAX_HISTORY);
  }
  next.updatedAt = new Date().toISOString();
  await kvSet(stateKey(userId), next);
  return next;
}

// Append a user turn and the coach's reply to that user's history, persisting the result.
// Used by the Telegram webhook so its exchanges show up in the app on next sync.
export async function appendTurns(userId, state, userText, assistantText) {
  const history = Array.isArray(state.conversationHistory) ? state.conversationHistory.slice() : [];
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });
  return setState(userId, { ...state, conversationHistory: history });
}
