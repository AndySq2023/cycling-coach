// Coach state — the bridge between the web app (browser localStorage) and the
// server. The athlete's schedule, training plan, goal and conversation history live
// in one KV blob, `coach_state`.
import { kvGet, kvSetStrict, envKey, isProductionEnv } from './_kv.js';

const BASE_KEY = 'coach_state';
// Resolved per call (not at import) so tests can flip VERCEL_ENV.
const stateKey = () => envKey(BASE_KEY);
export const STATE_BASE_KEY = BASE_KEY;
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
    strengthLog: [],     // [{date, name, exercises:[{name,band,sets:[{reps,rir}]}], ...}]
    pendingProposal: null, // coach proposal awaiting approval (shared/proposal-core.js)
    snapshots: [],       // last 10 pre-apply snapshots, for "Undo last coach change"
    dismissals: [],      // last 30 dismissed changes, fed back to the coach
    review: null,        // { date, text, source } — last quiet "no change" review
    conversationHistory: [], // [{ role:'user'|'assistant', content }]
    briefing: null,       // { date, text, whoopSig } — today's morning briefing, shared
                           // across devices so only one is ever generated per day
    updatedAt: null,
    updatedBy: null,     // 'app'
  };
}

// Read the state blob for the current environment. `io` is injectable so tests can
// prove the preview never writes an unprefixed key.
export async function readState(io = { get: kvGet, set: kvSetStrict }, env = process.env.VERCEL_ENV) {
  const key = envKey(BASE_KEY, env);
  let s = await io.get(key);
  // Preview seeding: the first time a preview deployment reads an empty state, copy the
  // production blob in ONCE so the athlete sees their real plan and history. Strictly
  // read-only towards production — the copy is written to the preview: key only.
  if (s == null && !isProductionEnv(env)) {
    const prod = await io.get(BASE_KEY);
    if (prod && typeof prod === 'object') {
      s = { ...prod, seededFromProductionAt: new Date().toISOString() };
      try { await io.set(key, s); } catch { /* serve the seed anyway */ }
    }
  }
  return { ...emptyState(), ...(s && typeof s === 'object' ? s : {}) };
}

export async function getState() { return readState(); }

export async function setState(state) {
  const next = { ...emptyState(), ...state };
  if (Array.isArray(next.conversationHistory) && next.conversationHistory.length > MAX_HISTORY) {
    next.conversationHistory = next.conversationHistory.slice(-MAX_HISTORY);
  }
  next.updatedAt = new Date().toISOString();
  await kvSetStrict(stateKey(), next); // throws on failure → api/state.js returns { error }
  return next;
}
