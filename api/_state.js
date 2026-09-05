// Coach state — the bridge between the web app (browser localStorage) and the
// server. The athlete's schedule, training plan, goal and conversation history live
// in one KV blob, `coach_state`.
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
    ftp: null,           // functional threshold power in watts, manually set
    ftpLog: [],          // [{ date, ftp }] — every value it's been set to, for the tracker
    home: null,          // "lat,lon" for weather, or null
    coachNotes: [],      // durable facts the coach remembers about the athlete
    resistance: [],      // coach-authored strength sessions (Resistance tab)
    conversationHistory: [], // [{ role:'user'|'assistant', content }]
    briefing: null,       // { date, text, whoopSig } — today's morning briefing, shared
                           // across devices so only one is ever generated per day
    updatedAt: null,
    updatedBy: null,     // 'app'
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
