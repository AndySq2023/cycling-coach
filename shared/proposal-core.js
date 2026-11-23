// Coach proposals — the safety layer between what the coach SAYS it wants to change and
// what actually changes in the athlete's plan.
//
// Before this, a schedule_set / schedule_update / resistance_set block in a coach reply
// was applied the moment it arrived. Now every plan-changing block becomes a PROPOSAL:
// a list of typed changes, each with the evidence behind it, that the athlete ticks and
// approves. Nothing reaches the plan until then, and every apply is snapshotted so it
// can be undone.
//
// The validator here is the safety check. Prompt wording alone is not enough: a model
// that has been told "duration 0–600" will still occasionally write 900, invent a band,
// or target a session that no longer exists.
//
// Pure: no DOM, no fetch, no globals beyond what it defines. It has to load in two
// places that can't share a module system:
//   - the app, as a classic <script> (the app is build-free and opens from file://,
//     where ES module imports are blocked), and
//   - the tests, as an ES module import (package.json is "type":"module").
// So it attaches to globalThis instead of using `export`; `import '../shared/…'` in a
// test runs it for that side effect, then reads globalThis.ProposalCore.
(function (root) {
  'use strict';

  // The fixed list of change types. Anything else is rejected outright.
  const CHANGE_TYPES = [
    'move-session',             // same session, new date
    'swap-session',             // same slot, different session type (and its detail)
    'set-duration',             // minutes, 0–600
    'set-intensity',            // low / medium / high / rest
    'set-target',               // the targets line (watts / HR / interval target)
    'add-rest-day',             // turn a session (or an empty date) into a rest day
    'add-session',              // a new session alongside the existing plan (was schedule_add)
    'remove-session',           // drop a session entirely
    'replace-week',             // full rebuild (was schedule_set) — clears logged feedback
    'replace-resistance-library', // the whole Resistance tab (was resistance_set)
  ];
  const SESSION_TYPES = ['move-session', 'swap-session', 'set-duration', 'set-intensity', 'set-target', 'remove-session'];
  const INTENSITIES = ['low', 'medium', 'high', 'rest'];
  const CHOKES = ['full', 'choked', 'doubled'];
  const DURATION_MIN = 0, DURATION_MAX = 600;
  const MAX_CHANGES = 8;          // the prompt asks for ≤5; this is the hard ceiling
  const WHY_MIN = 8, WHY_MAX = 300;
  const SNAPSHOTS_MAX = 10;
  const DISMISSALS_MAX = 30;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  // ── small helpers ─────────────────────────────────────────
  function addDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // Yesterday..today+28 — the same window the app's plan-date guard accepts.
  function planWindow(today) { return { start: addDays(today, -1), end: addDays(today, 28) }; }
  function inWindow(date, today) {
    if (!ISO.test(String(date || ''))) return false;
    const w = planWindow(today);
    return date >= w.start && date <= w.end;
  }
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const str = v => (v == null ? '' : String(v));
  const isInt = v => Number.isFinite(+v) && v !== '' && v !== null && Math.round(+v) === +v;

  // Stable stringify (sorted keys) — dismissal matching must not depend on key order.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  // djb2 — short fingerprint for "the week / library as it was". Not security.
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }
  function planSignature(plan) {
    return hash((plan || []).map(s => [s.id, s.date, s.type, s.duration, s.intensity, s.targets || ''].join('|')).join(';'));
  }
  function librarySignature(lib) {
    return hash(stable((lib || []).map(w => ({ n: w.name, e: (w.exercises || []).map(e => [e.name, e.band, e.sets, e.reps]) }))));
  }

  function findSession(plan, target) {
    if (!isObj(target)) return null;
    if (target.sessionId != null) return (plan || []).find(s => String(s.id) === String(target.sessionId)) || null;
    if (target.date) {
      const onDay = (plan || []).filter(s => s.date === target.date);
      return onDay.length === 1 ? onDay[0] : null;
    }
    return null;
  }

  // What `before` is RIGHT NOW for this change. Used to fill a missing `before` when a
  // proposal is created, and to detect staleness when it is applied.
  function currentBefore(c, state) {
    const plan = state.plan || [];
    const s = findSession(plan, c.target);
    switch (c.type) {
      case 'move-session':   return s ? { date: s.date } : undefined;
      case 'swap-session':   return s ? { type: s.type } : undefined;
      case 'set-duration':   return s ? { duration: Number(s.duration) || 0 } : undefined;
      case 'set-intensity':  return s ? { intensity: s.intensity } : undefined;
      case 'set-target':     return s ? { targets: str(s.targets) } : undefined;
      case 'remove-session': return s ? { type: s.type, date: s.date } : undefined;
      case 'add-rest-day':   return s ? { type: s.type, duration: Number(s.duration) || 0, intensity: s.intensity } : null;
      case 'add-session':    return null;
      case 'replace-week':   return { signature: planSignature(plan) };
      case 'replace-resistance-library': return { signature: librarySignature(state.resistance) };
      default: return undefined;
    }
  }

  function sameValue(a, b) {
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return str(a).trim().toLowerCase() === str(b).trim().toLowerCase();
  }
  // A change is stale when the state it was written against has moved on: the session
  // was edited by hand, Strava rewrote it, another device applied something, or it no
  // longer exists. Stale changes are shown greyed out and are NEVER applied.
  function isStale(c, state) {
    const now = currentBefore(c, state);
    if (now === undefined) return true;              // target is gone
    const before = c.before;
    if (before == null) return now != null;          // expected empty, now occupied
    if (now == null) return true;                    // expected something, now empty
    return Object.keys(before).some(k => !sameValue(before[k], now[k]));
  }

  // ── validation ────────────────────────────────────────────
  function sessionShapeErrors(x, label) {
    const e = [];
    if (!str(x.type).trim()) e.push(`${label}: type is required`);
    else if (str(x.type).length > 80) e.push(`${label}: type is longer than 80 characters`);
    if (x.duration != null && !(isInt(x.duration) && +x.duration >= DURATION_MIN && +x.duration <= DURATION_MAX)) {
      e.push(`${label}: duration ${x.duration} must be a whole number of minutes from ${DURATION_MIN} to ${DURATION_MAX}`);
    }
    if (x.intensity != null && !INTENSITIES.includes(x.intensity)) {
      e.push(`${label}: intensity "${x.intensity}" must be one of ${INTENSITIES.join('/')}`);
    }
    if (x.targets != null && str(x.targets).length > 200) e.push(`${label}: targets longer than 200 characters`);
    if (x.description != null && str(x.description).length > 400) e.push(`${label}: description longer than 400 characters`);
    if (x.tips != null && !Array.isArray(x.tips)) e.push(`${label}: tips must be an array`);
    return e;
  }

  function validateChange(c, state, label) {
    const e = [];
    const today = state.today;
    if (!isObj(c)) return [`${label}: not an object`];
    if (!CHANGE_TYPES.includes(c.type)) return [`${label}: unknown change type "${c.type}" — must be one of ${CHANGE_TYPES.join(', ')}`];
    const why = str(c.why).trim();
    if (why.length < WHY_MIN) e.push(`${label}: "why" must name the evidence (e.g. "HRV 18% below 7-day baseline, recovery 31%")`);
    else if (why.length > WHY_MAX) e.push(`${label}: "why" is longer than ${WHY_MAX} characters`);
    const t = c.target, a = c.after;

    if (SESSION_TYPES.includes(c.type)) {
      if (!isObj(t) || (t.sessionId == null && !t.date)) e.push(`${label}: target.sessionId is required`);
      else if (!findSession(state.plan, t)) e.push(`${label}: no session matches target ${stable(t)}`);
    }
    switch (c.type) {
      case 'move-session':
        if (!isObj(a) || !inWindow(a.date, today)) e.push(`${label}: after.date must be a YYYY-MM-DD date inside the plan window ${planWindow(today).start}…${planWindow(today).end}`);
        break;
      case 'swap-session':
        if (!isObj(a)) { e.push(`${label}: after must be an object with at least a type`); break; }
        e.push(...sessionShapeErrors(a, label));
        break;
      case 'set-duration':
        if (!isObj(a) || !(isInt(a.duration) && +a.duration >= DURATION_MIN && +a.duration <= DURATION_MAX)) {
          e.push(`${label}: after.duration must be a whole number of minutes from ${DURATION_MIN} to ${DURATION_MAX}`);
        }
        break;
      case 'set-intensity':
        if (!isObj(a) || !INTENSITIES.includes(a.intensity)) e.push(`${label}: after.intensity must be one of ${INTENSITIES.join('/')}`);
        break;
      case 'set-target':
        if (!isObj(a) || typeof a.targets !== 'string' || a.targets.length > 200) e.push(`${label}: after.targets must be a string of at most 200 characters`);
        break;
      case 'remove-session':
        if (a != null && !(isObj(a) && !Object.keys(a).length)) e.push(`${label}: remove-session takes no "after"`);
        break;
      case 'add-rest-day':
        if (!isObj(t) || (t.sessionId == null && !t.date)) e.push(`${label}: target needs a sessionId or a date`);
        else if (t.sessionId != null && !findSession(state.plan, t)) e.push(`${label}: no session matches target ${stable(t)}`);
        else if (t.sessionId == null && !inWindow(t.date, today)) e.push(`${label}: target.date must be inside the plan window`);
        break;
      case 'add-session':
        if (!isObj(t) || !inWindow(t.date, today)) e.push(`${label}: target.date must be a YYYY-MM-DD date inside the plan window`);
        if (!isObj(a)) e.push(`${label}: after must describe the new session`);
        else e.push(...sessionShapeErrors(a, label));
        break;
      case 'replace-week': {
        const ss = isObj(a) ? a.sessions : null;
        if (!Array.isArray(ss) || !ss.length || ss.length > 14) { e.push(`${label}: after.sessions must be an array of 1–14 sessions`); break; }
        ss.forEach((s, i) => {
          if (!isObj(s)) { e.push(`${label} session ${i + 1}: not an object`); return; }
          if (!inWindow(s.date, today)) e.push(`${label} session ${i + 1}: date "${s.date}" must be inside the plan window`);
          e.push(...sessionShapeErrors(s, `${label} session ${i + 1}`));
        });
        break;
      }
      case 'replace-resistance-library': {
        const ws = isObj(a) ? a.workouts : null;
        if (!Array.isArray(ws) || !ws.length || ws.length > 20) { e.push(`${label}: after.workouts must be an array of 1–20 workouts`); break; }
        const bands = state.bandIds || [], anchors = state.anchorIds || [];
        ws.forEach((w, i) => {
          const wl = `${label} workout ${i + 1}`;
          if (!isObj(w) || !str(w.name).trim()) { e.push(`${wl}: needs a name`); return; }
          if (!Array.isArray(w.exercises) || !w.exercises.length) { e.push(`${wl}: needs at least one exercise`); return; }
          w.exercises.forEach((x, j) => {
            const xl = `${wl} exercise ${j + 1} (${str(x && x.name) || '?'})`;
            if (!isObj(x) || !str(x.name).trim()) { e.push(`${xl}: needs a name`); return; }
            if (!bands.includes(x.band)) e.push(`${xl}: band "${x.band}" is not one of the athlete's bands (${bands.join(', ')})`);
            if (!anchors.includes(x.anchor)) e.push(`${xl}: anchor "${x.anchor}" must be one of ${anchors.join(', ')}`);
            if (x.choke != null && !CHOKES.includes(x.choke)) e.push(`${xl}: choke must be one of ${CHOKES.join('/')}`);
            if (x.sets != null && !(isInt(x.sets) && +x.sets >= 1 && +x.sets <= 10)) e.push(`${xl}: sets must be 1–10`);
            if (x.rir != null && !(Number.isFinite(+x.rir) && +x.rir >= 0 && +x.rir <= 5)) e.push(`${xl}: rir must be 0–5`);
          });
        });
        break;
      }
    }
    return e;
  }

  // Give each change an id, and fill `before` from the current state where the coach
  // left it out (legacy blocks never carry one). A `before` the coach DID write is kept,
  // so a coach that was looking at an older plan is caught as stale.
  function prepareProposal(p, state) {
    if (!isObj(p) || !Array.isArray(p.changes)) return p;
    const changes = p.changes.map((c, i) => {
      if (!isObj(c)) return c;
      const out = { ...c, id: str(c.id).trim() || `c${i + 1}` };
      if (!('before' in c) || c.before === undefined) {
        const b = currentBefore(out, state);
        if (b !== undefined) out.before = b;
      }
      // Remember the session's date at proposal time — dismissals match on it, because
      // session ids are reused when a week is rebuilt.
      const s = findSession(state.plan, out.target);
      if (s && isObj(out.target) && !out.target.date) out.target = { ...out.target, date: s.date };
      return out;
    });
    return { ...p, changes };
  }

  function validateProposal(p, state) {
    const errors = [];
    if (!isObj(p) || !Array.isArray(p.changes) || !p.changes.length) {
      return { ok: false, errors: ['proposal must have a non-empty "changes" array'], changes: [] };
    }
    if (p.changes.length > MAX_CHANGES) errors.push(`${p.changes.length} changes is too many — at most ${MAX_CHANGES}; keep the few that matter most`);
    p.changes.forEach((c, i) => errors.push(...validateChange(c, state, (c && c.id) || `change ${i + 1}`)));
    // replace-week rebuilds the plan, so per-session edits next to it are contradictory.
    const types = p.changes.map(c => c && c.type);
    if (types.includes('replace-week') && types.some(t => t !== 'replace-week' && t !== 'replace-resistance-library')) {
      errors.push('replace-week cannot be combined with other plan changes — put the edits inside the new week');
    }
    if (types.filter(t => t === 'replace-week').length > 1) errors.push('only one replace-week per proposal');
    // Two edits of the same field on the same session would silently overwrite each other.
    const seen = new Set();
    p.changes.forEach(c => {
      if (!c || !SESSION_TYPES.includes(c.type) || !isObj(c.target)) return;
      const k = c.type + '|' + str(c.target.sessionId || c.target.date);
      if (seen.has(k)) errors.push(`two ${c.type} changes target the same session (${str(c.target.sessionId || c.target.date)})`);
      seen.add(k);
    });
    const changes = p.changes.map(c => (isObj(c) ? { ...c, stale: CHANGE_TYPES.includes(c.type) ? isStale(c, state) : true } : c));
    return { ok: errors.length === 0, errors, changes };
  }

  // ── turning coach output into a proposal ──────────────────
  // Legacy blocks (schedule_update / schedule_set / schedule_add / resistance_set) still
  // parse, so a model imitating its own older replies doesn't break — they just become
  // proposals too. They carry no evidence, so unless a why is present they fail
  // validation and go round the repair loop as plan_proposal.
  function proposalFromBlocks(b, state) {
    b = b || {};
    if (isObj(b.planProposal) && Array.isArray(b.planProposal.changes)) {
      const extra = b.workouts ? [{ type: 'replace-resistance-library', target: {}, after: { workouts: b.workouts }, why: str(b.planProposal.resistanceWhy || '') }] : [];
      return { summary: str(b.planProposal.summary).slice(0, 200), changes: [...b.planProposal.changes, ...extra] };
    }
    const changes = [];
    const whyOf = x => str((x && (x.why || x.reason || x.adaptation_note)) || '');
    if (Array.isArray(b.planSet) && b.planSet.length) {
      changes.push({ type: 'replace-week', target: {}, after: { sessions: b.planSet.map(s => { const { id, why, reason, ...rest } = s || {}; return rest; }) }, why: str(b.planSetWhy || '') });
    } else {
      (b.updates || []).forEach(u => {
        if (!isObj(u)) return;
        const target = { sessionId: u.id };
        const why = whyOf(u);
        const restDay = u.intensity === 'rest' || /rest day/i.test(str(u.type));
        if (restDay) { changes.push({ type: 'add-rest-day', target, why }); return; }
        if (u.date != null) changes.push({ type: 'move-session', target, after: { date: u.date }, why });
        if (u.type != null || u.description != null || u.tips != null) {
          const after = {};
          ['type', 'description', 'tips'].forEach(k => { if (u[k] != null) after[k] = u[k]; });
          if (after.type == null) { const s = findSession(state.plan, target); if (s) after.type = s.type; }
          changes.push({ type: 'swap-session', target, after, why });
        }
        if (u.duration != null) changes.push({ type: 'set-duration', target, after: { duration: u.duration }, why });
        if (u.intensity != null) changes.push({ type: 'set-intensity', target, after: { intensity: u.intensity }, why });
        if (u.targets != null) changes.push({ type: 'set-target', target, after: { targets: str(u.targets) }, why });
      });
      (b.planAdd || []).forEach(s => {
        if (!isObj(s)) return;
        const { why, reason, id, ...after } = s;
        changes.push({ type: 'add-session', target: { date: s.date }, after, why: str(why || reason || '') });
      });
    }
    if (Array.isArray(b.workouts) && b.workouts.length) {
      changes.push({ type: 'replace-resistance-library', target: {}, after: { workouts: b.workouts }, why: str(b.workoutsWhy || '') });
    }
    return changes.length ? { summary: '', changes } : null;
  }

  // ```plan_proposal {...}``` — the primary block the coach now writes.
  function extractPlanProposal(text) {
    const re = /```plan_proposal\s*([\s\S]*?)```/gi;
    let m, proposal = null; const raw = [];
    while ((m = re.exec(String(text || ''))) !== null) {
      try {
        const obj = JSON.parse(m[1].trim());
        if (isObj(obj) && Array.isArray(obj.changes)) { proposal = obj; raw.push(m[0]); }
        else if (Array.isArray(obj)) { proposal = { summary: '', changes: obj }; raw.push(m[0]); }
      } catch (e) { /* malformed — treated as absent */ }
    }
    const clean = String(text || '').replace(/```plan_proposal[\s\S]*?```/gi, '').trim();
    return { clean, proposal, raw };
  }

  // {"nochange": true, "reading": "..."} — a review that found nothing worth changing.
  // Accepted bare, fenced as ```review```/```json```, or as the whole reply.
  function parseNoChange(text) {
    const t = String(text || '');
    const candidates = [];
    const fence = /```(?:review|json)?\s*([\s\S]*?)```/gi; let m;
    while ((m = fence.exec(t)) !== null) candidates.push({ body: m[1], whole: m[0] });
    const bare = t.match(/\{[^{}]*"nochange"\s*:\s*true[^{}]*\}/);
    if (bare) candidates.push({ body: bare[0], whole: bare[0] });
    for (const c of candidates) {
      try {
        const o = JSON.parse(c.body.trim());
        if (isObj(o) && o.nochange === true) {
          return { nochange: true, reading: str(o.reading).trim().slice(0, 600), clean: t.replace(c.whole, '').trim() };
        }
      } catch (e) { /* not it */ }
    }
    return null;
  }

  // One validation round, then at most ONE repair round. `repair(errors)` asks the model
  // to fix its own output and resolves to a fresh proposal (or null). If the repaired
  // proposal still fails, nothing is applied — the caller shows a clean error.
  async function resolveProposal({ proposal, state, repair }) {
    if (!proposal) return { status: 'none' };
    let p = prepareProposal(proposal, state);
    let v = validateProposal(p, state);
    if (v.ok) return { status: 'ok', proposal: { ...p, changes: v.changes }, repaired: false };
    let p2 = null;
    try { p2 = repair ? await repair(v.errors) : null; } catch (e) { p2 = null; }
    if (!p2) return { status: 'failed', errors: v.errors };
    p2 = prepareProposal(p2, state);
    const v2 = validateProposal(p2, state);
    if (v2.ok) return { status: 'ok', proposal: { ...p2, changes: v2.changes }, repaired: true };
    return { status: 'failed', errors: v2.errors };
  }

  // ── applying ──────────────────────────────────────────────
  function nextSessionId(plan) {
    const max = plan.reduce((m, s) => {
      const n = parseInt(str(s.id).replace(/\D/g, ''), 10);
      return Number.isNaN(n) ? m : Math.max(m, n);
    }, 0);
    return `s${max + 1}`;
  }
  function weekdayOf(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  }
  function normSession(x, id) {
    return {
      id: str(id),
      day: x.date ? weekdayOf(x.date) : str(x.day),
      date: str(x.date),
      type: str(x.type).trim() || 'Session',
      duration: Number(x.duration) || 0,
      intensity: INTENSITIES.includes(x.intensity) ? x.intensity : 'low',
      description: str(x.description).slice(0, 400),
      targets: str(x.targets).slice(0, 200),
      tips: Array.isArray(x.tips) ? x.tips.map(str).slice(0, 6) : [],
      bands: !!x.bands,
    };
  }

  // Apply the selected, non-stale changes to a COPY of the state. Staleness is re-checked
  // here against the state at the moment of applying — the athlete may have tapped Apply
  // an hour after the proposal arrived, and a lot can happen in an hour.
  function applyChanges(state, changes) {
    let plan = clone(state.plan || []);
    let resistance = null;
    let replacedWeek = false;
    const applied = [], skipped = [], touched = {};
    (changes || []).forEach(c => {
      if (!c || !CHANGE_TYPES.includes(c.type)) { skipped.push({ id: c && c.id, reason: 'unknown type' }); return; }
      if (isStale(c, state)) { skipped.push({ id: c.id, reason: 'stale' }); return; }
      const s = findSession(plan, c.target);
      const a = c.after || {};
      switch (c.type) {
        case 'move-session':  s.date = a.date; s.day = weekdayOf(a.date); break;
        case 'swap-session':
          s.type = str(a.type).trim() || s.type;
          ['description', 'targets'].forEach(k => { if (a[k] != null) s[k] = str(a[k]); });
          if (Array.isArray(a.tips)) s.tips = a.tips.map(str);
          if (a.duration != null) s.duration = Number(a.duration) || 0;
          if (INTENSITIES.includes(a.intensity)) s.intensity = a.intensity;
          break;
        case 'set-duration':  s.duration = Number(a.duration) || 0; break;
        case 'set-intensity': s.intensity = a.intensity; break;
        case 'set-target':    s.targets = str(a.targets); break;
        case 'remove-session': plan = plan.filter(x => x !== s); break;
        case 'add-rest-day':
          if (s) Object.assign(s, { type: 'Rest Day', duration: 0, intensity: 'rest', targets: '', description: str(a.description) || 'Rest — recovery is the work today.', tips: [] });
          else plan.push(normSession({ type: 'Rest Day', duration: 0, intensity: 'rest', date: c.target.date, description: 'Rest — recovery is the work today.' }, nextSessionId(plan)));
          break;
        case 'add-session':
          plan.push(normSession({ ...a, date: c.target.date }, nextSessionId(plan)));
          break;
        case 'replace-week':
          plan = a.sessions.map((x, i) => normSession(x, `s${i + 1}`));
          replacedWeek = true;
          break;
        case 'replace-resistance-library':
          resistance = clone(a.workouts);
          break;
      }
      if (s && c.type !== 'remove-session') touched[s.id] = c.why;
      applied.push(c.id);
    });
    plan.sort((x, y) => str(x.date).localeCompare(str(y.date)));
    return { plan, resistance, applied, skipped, replacedWeek, touched };
  }

  // ── snapshots (undo) ──────────────────────────────────────
  function pushSnapshot(list, snap, max = SNAPSHOTS_MAX) {
    return [...(Array.isArray(list) ? list : []), clone(snap)].slice(-max);
  }
  function popSnapshot(list) {
    const l = Array.isArray(list) ? list.slice() : [];
    const snap = l.pop() || null;
    return { snapshot: snap, list: l };
  }

  // ── dismissals ────────────────────────────────────────────
  // A dismissal is (type, target, after). It matches a later change of the same type and
  // after-value on the same session id OR the same date.
  function dismissalOf(c, at) {
    return { type: c.type, target: { sessionId: c.target && c.target.sessionId != null ? str(c.target.sessionId) : null, date: (c.target && c.target.date) || null }, after: clone(c.after === undefined ? null : c.after), why: str(c.why).slice(0, 160), at };
  }
  function matchesDismissal(c, d) {
    if (!c || !d || c.type !== d.type) return false;
    if (stable(c.after === undefined ? null : c.after) !== stable(d.after)) return false;
    const ct = c.target || {}, dt = d.target || {};
    if (['replace-week', 'replace-resistance-library'].includes(c.type)) return true;
    return (ct.sessionId != null && dt.sessionId != null && str(ct.sessionId) === str(dt.sessionId))
        || (!!ct.date && ct.date === dt.date);
  }
  function isDismissed(c, dismissals) { return (dismissals || []).some(d => matchesDismissal(c, d)); }
  function recordDismissals(list, changes, at, max = DISMISSALS_MAX) {
    let out = Array.isArray(list) ? list.slice() : [];
    (changes || []).forEach(c => {
      const d = dismissalOf(c, at);
      out = out.filter(x => !matchesDismissal(c, x));
      out.push(d);
    });
    return out.slice(-max);
  }

  // ── describing a change (UI + prompt) ─────────────────────
  function shortDate(iso) {
    if (!ISO.test(str(iso))) return str(iso);
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function describeChange(c, state) {
    const s = findSession((state && state.plan) || [], c.target);
    const where = s ? `${shortDate(s.date)} · ${s.type}` : (c.target && c.target.date ? shortDate(c.target.date) : '');
    const b = c.before || {}, a = c.after || {};
    const min = v => (v == null ? '—' : `${v} min`);
    switch (c.type) {
      case 'move-session':   return { title: `Move session`, where, before: shortDate(b.date), after: shortDate(a.date) };
      case 'swap-session':   return { title: `Swap session`, where, before: str(b.type) || '—', after: str(a.type) };
      case 'set-duration':   return { title: `Duration`, where, before: min(b.duration), after: min(a.duration) };
      case 'set-intensity':  return { title: `Intensity`, where, before: str(b.intensity) || '—', after: str(a.intensity) };
      case 'set-target':     return { title: `Targets`, where, before: str(b.targets) || '(none)', after: str(a.targets) || '(none)' };
      case 'add-rest-day':   return { title: `Rest day`, where, before: c.before ? `${str(b.type)}${b.duration ? `, ${b.duration} min` : ''}` : '(nothing planned)', after: 'Rest Day' };
      case 'add-session':    return { title: `Add session`, where: shortDate(c.target && c.target.date), before: '(nothing)', after: `${str(a.type)}${a.duration ? `, ${a.duration} min` : ''}` };
      case 'remove-session': return { title: `Remove session`, where, before: `${str(b.type)}`, after: '(removed)' };
      case 'replace-week':   return { title: `Replace the week`, where: '', before: 'current plan', after: `${(a.sessions || []).length} new sessions (logged feedback is cleared)` };
      case 'replace-resistance-library': return { title: `Replace strength library`, where: '', before: 'current sessions', after: (a.workouts || []).map(w => w && w.name).filter(Boolean).join(', ') };
      default: return { title: str(c.type), where, before: '', after: '' };
    }
  }

  root.ProposalCore = {
    CHANGE_TYPES, INTENSITIES, CHOKES, DURATION_MIN, DURATION_MAX, MAX_CHANGES, SNAPSHOTS_MAX, DISMISSALS_MAX,
    planWindow, inWindow, planSignature, librarySignature, findSession, currentBefore, isStale,
    validateChange, prepareProposal, validateProposal,
    proposalFromBlocks, extractPlanProposal, parseNoChange, resolveProposal,
    applyChanges, pushSnapshot, popSnapshot,
    dismissalOf, matchesDismissal, isDismissed, recordDismissals,
    describeChange, stable,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
