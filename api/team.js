// Vercel serverless function — master-only team management + team report.
//
//   GET  /api/team                → the team report: one row per athlete (master +
//                                   members) with live WHOOP recovery/strain, last
//                                   Strava ride, weekly volume, plan adherence, goal
//                                   and last-active. Cached in KV for 5 minutes;
//                                   ?fresh=1 forces a rebuild.
//   GET  /api/team?mode=roster    → just the member list + connection flags (cheap,
//                                   no external API calls) for the management UI.
//   POST /api/team { action }     → 'add' { name }        → { member, password }
//                                                            (password shown ONCE)
//                                   'remove' { id }        → also deletes the member's
//                                                            state + provider tokens
//                                   'reset-password' { id }→ { member, password }
//
// Every route is behind requireMaster — members get a 403.
import { requireMaster, MASTER_ID } from './_auth.js';
import { getRoster, addMember, removeMember, resetPassword, MAX_MEMBERS } from './_users.js';
import { getState, stateKey } from './_state.js';
import { kvGet, kvSet, kvDel } from './_kv.js';
import { getWhoopSummary } from './whoop.js';
import { getStravaSummary } from './strava.js';

const REPORT_CACHE_KEY = 'team_report_cache';
const REPORT_TTL_S = 300;       // report freshness window
const SOURCE_TIMEOUT_MS = 8000; // per data source per athlete — one slow API can't stall the report

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

// Adherence = logged feedback on this plan's non-rest sessions. The plan is always
// the athlete's current 7-day week, so no date-window filtering is needed.
function weekAdherence(plan, feedback) {
  const sessions = (plan || []).filter(s => s && s.intensity !== 'rest' && !/rest/i.test(s.type || ''));
  const done = sessions.filter(s => feedback && feedback[s.id]).length;
  return { done, total: sessions.length };
}

async function athleteRow(user) {
  const state = await getState(user.id);
  const [whoopR, stravaR] = await Promise.allSettled([
    withTimeout(getWhoopSummary(user.id), SOURCE_TIMEOUT_MS),
    withTimeout(getStravaSummary(user.id), SOURCE_TIMEOUT_MS),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);
  const reason = (r) => (r.reason?.notConnected ? 'not_connected' : 'error');
  const whoop = val(whoopR);
  const strava = val(stravaR);

  return {
    id: user.id,
    name: user.name,
    role: user.role,
    goal: state.goal || null,
    lastActive: state.updatedAt || null,
    adherence: weekAdherence(state.plan, state.feedback),
    hasPlan: Array.isArray(state.plan) && state.plan.length > 0,
    whoop: whoop
      ? {
          connected: true,
          recovery_score: whoop.recovery_score,
          strain: whoop.strain,
          hrv: whoop.hrv,
          rhr: whoop.rhr,
          sleep_duration_h: whoop.sleep_duration_h,
        }
      : { connected: false, reason: reason(whoopR) },
    strava: strava
      ? {
          connected: true,
          last_ride: strava.last_ride,
          rides_7d: strava.rides_7d,
          total_km_7d: strava.total_km_7d,
          total_moving_time_h_7d: strava.total_moving_time_h_7d,
        }
      : { connected: false, reason: reason(stravaR) },
  };
}

async function buildReport() {
  const roster = await getRoster();
  const users = [
    { id: MASTER_ID, name: process.env.MASTER_NAME || 'Coach', role: 'master' },
    ...roster.members.map(m => ({ id: m.id, name: m.name, role: 'member' })),
  ];
  const rows = await Promise.all(users.map(athleteRow));
  return {
    generatedAt: new Date().toISOString(),
    memberCount: roster.members.length,
    maxMembers: MAX_MEMBERS,
    rows,
  };
}

async function handleGet(req, res) {
  if (req.query?.mode === 'roster') {
    const roster = await getRoster();
    const members = await Promise.all(roster.members.map(async m => ({
      id: m.id,
      name: m.name,
      createdAt: m.createdAt,
      whoopConnected: !!((await kvGet(`whoop_tokens:${m.id}`))?.refresh_token),
      stravaConnected: !!((await kvGet(`strava_tokens:${m.id}`))?.refresh_token),
    })));
    res.status(200).json({ members, memberCount: members.length, maxMembers: MAX_MEMBERS });
    return;
  }

  if (req.query?.fresh !== '1') {
    const cached = await kvGet(REPORT_CACHE_KEY);
    if (cached?.generatedAt && Date.now() - Date.parse(cached.generatedAt) < REPORT_TTL_S * 1000) {
      res.status(200).json({ ...cached, cached: true });
      return;
    }
  }

  const report = await buildReport();
  await kvSet(REPORT_CACHE_KEY, report, { ex: REPORT_TTL_S });
  res.status(200).json(report);
}

async function handlePost(req, res) {
  const { action, name, id } = req.body || {};

  if (action === 'add') {
    const { member, password } = await addMember(name);
    await kvDel(REPORT_CACHE_KEY);
    res.status(200).json({ ok: true, member: { id: member.id, name: member.name }, password });
    return;
  }

  if (action === 'remove') {
    if (!id || id === MASTER_ID) { res.status(400).json({ error: 'Cannot remove the master user.' }); return; }
    await removeMember(id);
    // Offboarding: delete everything the member owned (state, tokens). Usage counters
    // expire on their own TTL.
    await Promise.all([
      kvDel(stateKey(id)),
      kvDel(`strava_tokens:${id}`),
      kvDel(`whoop_tokens:${id}`),
      kvDel(REPORT_CACHE_KEY),
    ]);
    res.status(200).json({ ok: true });
    return;
  }

  if (action === 'reset-password') {
    const { member, password } = await resetPassword(id);
    res.status(200).json({ ok: true, member: { id: member.id, name: member.name }, password });
    return;
  }

  res.status(400).json({ error: "action must be 'add', 'remove' or 'reset-password'." });
}

export default async function handler(req, res) {
  const master = await requireMaster(req, res);
  if (!master) return;
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.KV_REST_API_URL) {
    res.status(200).json({ error: 'Team features need the KV store — link Upstash Redis to the Vercel project first.' });
    return;
  }

  try {
    if (req.method === 'GET') { await handleGet(req, res); return; }
    if (req.method === 'POST') { await handlePost(req, res); return; }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(200).json({ error: err?.message || String(err) });
  }
}
