// Server-side mirror of the app's buildSystemPrompt() (app/cycling-coach.html) plus the
// schedule-block parser/appliers (extractScheduleUpdates / applyScheduleSet /
// applyScheduleUpdates). The Telegram bot needs the SAME coaching context and the SAME
// write-to-schedule capability the web chat has, but those live in browser JS, so they
// are reproduced here. Keep the two in sync when either changes.

// Unit helpers — copied verbatim from the app so numbers read identically.
const mi   = km  => km  == null ? null : Math.round(km  * 0.621371 * 10) / 10; // km → miles (1dp)
const mph  = kph => kph == null ? null : Math.round(kph * 0.621371);           // kph → mph
const degF = c   => c   == null ? null : Math.round(c * 9 / 5 + 32);           // °C → °F

// Build the coach system prompt. `data` mirrors the app's athleteData + plan/feedback:
//   { whoop, strava, weather, goal, plan, feedback }
// Any field may be null/empty — the prompt degrades exactly like the app's does.
export function buildSystemPrompt({ whoop, strava, weather, goal, plan, feedback } = {}) {
  plan = Array.isArray(plan) ? plan : [];
  feedback = feedback && typeof feedback === 'object' ? feedback : {};

  let prompt = `You are an expert cycling coach — evidence-based, direct, and recovery-aware. You specialize in endurance cycling and use polarized training principles (Seiler 80/20), heart rate and RPE-based training zones, and volume/load methodology.

Your job is to give the athlete personalized, actionable coaching advice based on their real WHOOP recovery data and Strava training history. Be specific — reference their actual numbers. Never give generic advice.

Tone: Direct, confident, like a coach who knows their data. Conversational but not fluffy. If their recovery is low, say so clearly. If they're overreaching, flag it. Always explain the "why" briefly.

Format: Short paragraphs. Use clear structure. Occasionally use metric callouts like [Recovery: 34% ⚠️] inline to highlight key numbers.

You are talking to the athlete over Telegram, so keep replies tight and skimmable on a phone.`;

  if (whoop) {
    const w = whoop;
    prompt += `\n\nATHLETE'S CURRENT WHOOP DATA (live, today):`;
    if (w.recovery_score != null) prompt += `\nRecovery: ${w.recovery_score}%`;
    if (w.hrv != null)            prompt += `\nHRV: ${w.hrv}ms`;
    if (w.rhr != null)            prompt += `\nRHR: ${w.rhr}bpm`;
    if (w.sleep_efficiency != null) prompt += `\nSleep efficiency: ${w.sleep_efficiency}%`;
    if (w.sleep_duration_h != null) prompt += `\nSleep duration: ${w.sleep_duration_h}h`;
    if (w.spo2 != null)           prompt += `\nSpO2: ${w.spo2}%`;
    if (w.strain != null)         prompt += `\nStrain: ${w.strain}`;
  }
  if (strava) {
    const s = strava;
    prompt += `\n\nATHLETE'S STRAVA DATA (last 7 days, live):`;
    prompt += `\nRides: ${s.rides_7d}`;
    prompt += `\nTotal distance: ${mi(s.total_km_7d)} mi`;
    prompt += `\nTotal elevation: ${s.total_elevation_7d}m`;
    prompt += `\nTotal moving time: ${s.total_moving_time_h_7d}h`;
    if (s.last_ride) {
      prompt += `\n\nMost recent ride: ${s.last_ride.name} on ${s.last_ride.date}`;
      prompt += `\n  Distance: ${mi(s.last_ride.distance_km)}mi, Moving time: ${s.last_ride.moving_time_min}min`;
      prompt += `\n  Elevation: ${s.last_ride.elevation_m}m, Avg speed: ${mph(s.last_ride.avg_speed_kph)} mph`;
      if (s.last_ride.avg_hr != null) prompt += `\n  Avg HR: ${s.last_ride.avg_hr}bpm, Max HR: ${s.last_ride.max_hr}bpm`;
    }
    if (s.last_ride_detail) {
      const d = s.last_ride_detail;
      const ms = (t) => t == null ? '?' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      if (d.laps?.length) {
        prompt += `\n\nRecorded laps on the most recent ride:`;
        d.laps.forEach(l => {
          prompt += `\n- Lap ${l.lap}: ${mi(l.distance_km)}mi in ${ms(l.time_s)}${l.avg_hr != null ? ` @ avg ${l.avg_hr}bpm (max ${l.max_hr})` : ''}`;
        });
      }
      if (d.repeated_segments?.length) {
        prompt += `\n\nSEGMENT SPLITS from the most recent ride (live from Strava). These are Strava segments the athlete rode more than once in the ride — on a loop course, pass 1 vs pass 2 IS the lap-1 vs lap-2 comparison. The longest segment ≈ the full loop. Use these to assess pacing (even/negative splits) and HR drift; you don't need to ask the athlete for lap times.`;
        d.repeated_segments.forEach(g => {
          prompt += `\n- ${g.name} (${mi(g.distance_km)}mi): ` + g.efforts.map((e, i) =>
            `pass ${i + 1}: ${ms(e.time_s)}${e.avg_hr != null ? ` @ ${e.avg_hr}bpm` : ''}`).join(' → ');
        });
      }
    }
    if (s.all_rides?.length > 1) {
      prompt += `\n\nAll rides this week:`;
      s.all_rides.forEach((r) => {
        prompt += `\n- ${r.date} | ${r.name} | ${mi(r.distance_km)}mi | ${r.moving_time_min}min | ${r.elevation_m}m elev${r.avg_hr != null ? ` | avg HR ${r.avg_hr}` : ''}`;
      });
    }
  }
  if (weather) {
    const wx = weather;
    const n = wx.now || {};
    const s = wx.summary || {};
    prompt += `\n\nWEATHER FORECAST (live, next ${s.hours || 48}h, for ride planning):`;
    if (wx.location) prompt += `\nLocation: ${wx.location.lat}, ${wx.location.lon}`;
    if (n.temp_c != null) prompt += `\nNow: ${degF(n.temp_c)}°F, wind ${n.wind_kph != null ? mph(n.wind_kph) : '?'} mph${n.wind_dir ? ' from ' + n.wind_dir : ''}, gusting ${n.gust_kph != null ? mph(n.gust_kph) : '?'} mph, ${n.precip_mm ?? 0}mm rain (last 3h)`;
    if (s.wind_kph_max != null) prompt += `\nNext ${s.hours || 48}h: wind ${mph(s.wind_kph_min)}–${mph(s.wind_kph_max)} mph (max gust ${mph(s.gust_kph_max)} mph), temp ${degF(s.temp_c_min)}–${degF(s.temp_c_max)}°F, total rain ${s.precip_mm_total}mm`;
    if (wx.hourly?.length) {
      prompt += `\nHourly outlook (~3h steps): `;
      prompt += wx.hourly.map(h => {
        const t = new Date(h.time).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        return `${t} ${degF(h.temp_c)}°F/${mph(h.wind_kph)}${h.wind_dir || ''}mph` + (h.precip_mm ? `/${h.precip_mm}mm` : '');
      }).join('; ');
    }
    prompt += `\nUse this to advise on ride timing, kit (rain/wind), and whether to move/shorten a planned session.`;
  }
  if (goal) {
    prompt += `\n\nATHLETE'S GOAL:\n${goal}`;
  }
  if (!whoop && !strava) {
    prompt += `\n\nNo data loaded yet. Ask the athlete to share their WHOOP recovery numbers and recent Strava rides so you can give personalized advice. You can still answer general cycling training questions.`;
  }

  // ── Ground-truth date + "today" resolution (authoritative over chat history) ──
  const todayISO = new Date().toISOString().slice(0, 10);
  const todayLong = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  prompt += `\n\n=== GROUND TRUTH (authoritative — trust this over anything earlier in the conversation) ===`;
  prompt += `\nToday is ${todayLong} (${todayISO}).`;
  if (strava) {
    const ridesToday = (strava.all_rides || []).filter(r => r.date === todayISO);
    if (ridesToday.length) {
      prompt += `\nRide(s) recorded TODAY: ` + ridesToday.map(r => `${r.name} — ${mi(r.distance_km)}mi at ${mph(r.avg_speed_kph)} mph`).join('; ') + `.`;
    } else {
      const lr = strava.last_ride;
      prompt += `\nNo ride has been recorded today. Most recent ride: ${lr ? `${lr.name} on ${lr.date} (avg ${mph(lr.avg_speed_kph)} mph)` : 'none in the last 7 days'}.`;
    }
  }
  if (whoop && whoop.recovery_score != null) {
    const w = whoop;
    prompt += `\nWHOOP this morning — recovery ${w.recovery_score}%`
      + (w.hrv != null ? `, HRV ${w.hrv}ms` : '')
      + (w.rhr != null ? `, RHR ${w.rhr}bpm` : '')
      + (w.sleep_duration_h != null ? `, sleep ${w.sleep_duration_h}h` : '')
      + '.';
  }
  prompt += `\nYou ALREADY have the athlete's WHOOP recovery/HRV/sleep and their Strava rides above — interpret them directly. Do NOT ask the athlete for their recovery score, HRV, RHR, or sleep; the app provides them. You may ask only about things you cannot measure (e.g. how the ride or their legs felt).`;
  prompt += `\nThe conversation history below may include sessions from earlier days, and may mix messages the athlete typed in the web app with messages they sent over Telegram. NEVER treat a past date as "today". If the athlete asks about "today's ride" and nothing is dated today, tell them there is no ride today and refer to the most recent ride by its real date — do not relabel an old ride as today's.`;

  // ── Inject the active training schedule + tell the coach it CAN write to it ──
  prompt += `\n\n=== YOU CAN WRITE TO THE ATHLETE'S SCHEDULE ===
You are not just a chat box — you have direct write access to the athlete's Training Schedule (shared with the "Schedule" tab in their web app). When you want to create or change the plan, emit a fenced JSON block and it is applied instantly. Never tell the athlete you can't write to their schedule — you can.`;

  if (plan.length) {
    prompt += `\n\nACTIVE TRAINING SCHEDULE (this is the athlete's current plan — always reference this when discussing sessions, never contradict it):`;
    plan.forEach(s => {
      const isToday = s.date === todayISO;
      const done = feedback[s.id];
      let line = `\n- ${s.day} ${s.date}${isToday ? ' [TODAY]' : ''}: ${s.type}`;
      if (s.duration > 0) line += `, ${s.duration}min`;
      if (s.targets) line += `, ${s.targets}`;
      if (done) {
        const bits = [];
        if (done.rpe) bits.push(`RPE ${done.rpe}/10`);
        if (done.feel?.length) bits.push(`felt: ${done.feel.join(', ')}`);
        if (done.notes) bits.push(`"${done.notes}"`);
        line += ` [COMPLETED${bits.length ? ' — ' + bits.join(', ') : ''}]`;
        if (done.actual) {
          const a = done.actual, ap = [];
          if (a.duration) ap.push(`${a.duration}min`);
          if (a.distance_mi) ap.push(`${a.distance_mi}mi`);
          if (a.avg_hr) ap.push(`avg HR ${a.avg_hr}`);
          if (a.max_hr) ap.push(`max HR ${a.max_hr}`);
          if (a.notes) ap.push(`"${a.notes}"`);
          if (ap.length) line += ` [ACTUAL vs planned — ${ap.join(' · ')}]`;
        }
      }
      prompt += line;
    });
    prompt += `\n\nTo CHANGE ONE existing session, apply the change and include a JSON block at the very end of your reply in this exact format (no extra text after it):
\`\`\`schedule_update
{"id":"s3","type":"Rest Day","duration":0,"intensity":"rest","description":"Full rest — legs were heavy.","targets":"","tips":[]}
\`\`\`
Only include fields you are changing. The id must match one of the session ids listed above. You can update: type, duration, intensity (low/medium/high/rest), description, targets, tips. After making a change, briefly explain to the athlete what you changed and why.

Use schedule_update blocks proactively when:
- The athlete says they just rode (mark that day as completed with ride details, adjust next session)
- The athlete says they took a rest day (mark scheduled session as skipped, adjust load)
- The athlete says they skipped a session or felt terrible
- Strava data shows a ride on a day marked as rest, or no ride on a training day

To REPLACE THE WHOLE WEEK (a fresh plan, a re-map, or major restructuring), use a schedule_set block instead — see the format below.`;
  } else {
    prompt += `\n\nThe athlete has no plan yet. If they ask you to map out, build, or plan their week (or it would clearly help), CREATE one — don't tell them to press a button.`;
  }

  prompt += `\n\nTo CREATE or REPLACE the entire schedule, include this block at the very end of your reply (no text after it):
\`\`\`schedule_set
[{"id":"s1","day":"Monday","date":"YYYY-MM-DD","type":"Zone 2 Endurance","duration":90,"intensity":"low","description":"One concise sentence.","targets":"e.g. HR 130-145bpm","tips":["short tip"],"bands":false}]
\`\`\`
Rules: start from today (${todayISO}); use real future dates in YYYY-MM-DD; ids s1,s2,…; intensity is one of low/medium/high/rest; rest days use type "Rest Day", duration 0, intensity "rest". Cover the days the athlete asked for (default the next 7). After the block, briefly tell the athlete what you scheduled and why. This overwrites any existing plan, so only use it for a full (re)build — for single-session tweaks use schedule_update.`;

  // ── ROUTE PLANNING (mirrors app/cycling-coach.html) ──────────────────────
  // NOTE: the Telegram bot side of this (api/telegram.js actually calling
  // api/route.js's planRoute() and replying with the real result) is not wired up
  // yet — this only keeps the prompt/parser in sync per this file's stated contract.
  // Until telegram.js calls planRoute(), route_request blocks from the bot path will
  // be parsed and stripped but never executed.
  prompt += `\n\n=== YOU CAN PLAN REAL ROUTES ===
You have a routing tool backed by real road/elevation data. Do NOT invent a route, distance, or elevation number yourself — emit this block instead and the app fills in real numbers:
\`\`\`route_request
{"mode":"loop","durationMin":60,"paceKph":24,"avoidHills":true}
\`\`\`
or, for a ride to a specific place and back:
\`\`\`route_request
{"mode":"out_and_back","destination":"box hill","avoidHills":false}
\`\`\`
Rules: mode is "loop" (round trip from home, sized by durationMin + paceKph) or "out_and_back" (home -> destination -> home, shortest distance). Estimate paceKph from the athlete's real recent Strava average speed, never a guess. destination is a known place name (box hill, richmond park, leith hill) or "lat,lon". Put the block at the very end of your reply, no text after it.`;

  return prompt;
}

// Parse schedule_update / schedule_set blocks out of a coach reply. Mirrors the app's
// extractScheduleUpdates(): returns the human-readable text with the blocks stripped,
// plus the parsed updates and (last-wins) full plan.
export function extractScheduleUpdates(text) {
  const updates = [];
  const re = /```schedule_update\s*([\s\S]*?)```/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    try { updates.push(JSON.parse(match[1].trim())); } catch { /* skip bad block */ }
  }

  let planSet = null;
  const setRe = /```schedule_set\s*([\s\S]*?)```/gi;
  let setMatch;
  while ((setMatch = setRe.exec(text)) !== null) {
    try {
      const arr = JSON.parse(setMatch[1].trim());
      if (Array.isArray(arr) && arr.length) planSet = arr;
    } catch { /* skip bad block */ }
  }

  const clean = text
    .replace(/```schedule_update[\s\S]*?```/gi, '')
    .replace(/```schedule_set[\s\S]*?```/gi, '')
    .trim();
  return { clean, updates, planSet };
}

// Parse a ```route_request ... ``` block out of a coach reply. Mirrors the app's
// extractRouteRequest(). See the NOTE above buildSystemPrompt's route section: nothing
// currently calls planRoute() from the Telegram path, so this is parse-only for now.
export function extractRouteRequest(text) {
  const re = /```route_request\s*([\s\S]*?)```/i;
  const match = re.exec(text);
  let routeRequest = null;
  if (match) {
    try { routeRequest = JSON.parse(match[1].trim()); } catch { /* skip bad block */ }
  }
  const clean = text.replace(/```route_request[\s\S]*?```/gi, '').trim();
  return { clean, routeRequest };
}

// Apply parsed blocks to a state object's plan/feedback/adaptations, returning a new
// state. Mirrors the app's applyScheduleSet() + applyScheduleUpdates() write semantics.
// Returns { state, changed } so the caller can decide whether to notify.
export function applyScheduleBlocks(state, { updates, planSet }) {
  let plan = Array.isArray(state.plan) ? state.plan.map(s => ({ ...s })) : [];
  let feedback = { ...(state.feedback || {}) };
  let adaptations = { ...(state.adaptations || {}) };
  let changed = false;

  if (planSet) {
    // Full (re)build — normalise exactly like applyScheduleSet, and (because ids may be
    // reassigned) clear prior feedback/notes, mirroring the app.
    plan = planSet.map((s, i) => ({
      id: String(s.id || `s${i + 1}`),
      day: s.day || '',
      date: s.date || '',
      type: s.type || 'Session',
      duration: Number(s.duration) || 0,
      intensity: ['low', 'medium', 'high', 'rest'].includes(s.intensity) ? s.intensity : 'low',
      description: s.description || '',
      targets: s.targets || '',
      tips: Array.isArray(s.tips) ? s.tips : [],
      bands: !!s.bands,
    }));
    feedback = {};
    adaptations = {};
    changed = true;
  } else if (updates.length) {
    updates.forEach(patch => {
      const idx = plan.findIndex(s => String(s.id) === String(patch.id));
      if (idx === -1) return;
      Object.assign(plan[idx], patch);
      changed = true;
    });
  }

  return { state: { ...state, plan, feedback, adaptations }, changed };
}
