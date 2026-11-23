// Muscles and hard sets — the early signal for "keep muscle while performing".
//
// The Hume body-comp trend says, once a month and with ~1kg of noise, whether lean mass
// is holding. Hard sets per muscle per week is the leading indicator: if a muscle isn't
// getting ~hard sets most weeks, the monthly scan will eventually say so. This file
// turns the strength log into that number.
//
// No estimated 1RM, deliberately: band load isn't measured (each band's force at its
// working length was never calibrated), so a 1RM would be invented.
//
// Pure, and loaded the same two ways as proposal-core.js: a classic <script> in the app
// (works from file://) and an ES-module side-effect import in tests/scripts. Exposes
// globalThis.MuscleCore.
(function (root) {
  'use strict';

  // The ~18 muscles everything is normalised to.
  const MUSCLES = [
    'traps', 'delts', 'chest', 'upper back', 'lats', 'biceps', 'triceps', 'forearms',
    'abs', 'obliques', 'lower back',
    'glutes', 'quads', 'hamstrings', 'adductors', 'abductors', 'hip flexors', 'calves',
  ];
  // The programme is upper body + core only (riding covers the legs), so "neglected" is
  // judged against these. Legs are still counted and shown.
  const TRACKED = ['traps', 'delts', 'chest', 'upper back', 'lats', 'biceps', 'triceps', 'forearms', 'abs', 'obliques', 'lower back'];

  // Every muscle name seen in the exercise dataset (and common gym shorthand) → one of MUSCLES.
  const ALIASES = {
    traps: 'traps', trapezius: 'traps', 'levator scapulae': 'traps', sternocleidomastoid: 'traps', neck: 'traps',
    delts: 'delts', deltoids: 'delts', shoulders: 'delts', 'rear deltoids': 'delts', 'rear delts': 'delts', 'rotator cuff': 'delts',
    chest: 'chest', pectorals: 'chest', pecs: 'chest', 'upper chest': 'chest', 'serratus anterior': 'chest',
    'upper back': 'upper back', back: 'upper back', rhomboids: 'upper back', 'mid back': 'upper back',
    lats: 'lats', 'latissimus dorsi': 'lats',
    biceps: 'biceps', brachialis: 'biceps',
    triceps: 'triceps',
    forearms: 'forearms', 'wrist flexors': 'forearms', 'wrist extensors': 'forearms', 'grip muscles': 'forearms', wrists: 'forearms', hands: 'forearms', grip: 'forearms',
    abs: 'abs', abdominals: 'abs', core: 'abs', 'lower abs': 'abs',
    obliques: 'obliques',
    'lower back': 'lower back', spine: 'lower back', 'erector spinae': 'lower back',
    glutes: 'glutes',
    quads: 'quads', quadriceps: 'quads',
    hamstrings: 'hamstrings',
    adductors: 'adductors', 'inner thighs': 'adductors', groin: 'adductors',
    abductors: 'abductors',
    'hip flexors': 'hip flexors',
    calves: 'calves', soleus: 'calves',
  };
  function normalizeMuscle(name) {
    const k = String(name || '').trim().toLowerCase();
    return ALIASES[k] || null;
  }
  function normalizeMuscles(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(m => { const n = normalizeMuscle(m); if (n && !out.includes(n)) out.push(n); });
    return out;
  }

  // Name → muscles for the band exercises this athlete actually does. First match wins,
  // so specific patterns sit above general ones (hammer curl before curl, leg curl
  // before curl). Prefixes like "A1 · " are ignored.
  const RULES = [
    [/wrist curl/, ['forearms'], []],
    [/hammer curl/, ['biceps', 'forearms'], []],
    [/leg curl|hamstring curl|nordic/, ['hamstrings'], []],
    [/curl/, ['biceps'], ['forearms']],
    [/pull-?apart|reverse fly|face pull|rear delt/, ['delts', 'upper back'], ['traps']],
    [/pull-?down|pullover|pull-?up|chin-?up/, ['lats'], ['biceps', 'upper back']],
    [/upright row/, ['delts', 'traps'], []],
    [/squat row/, ['upper back', 'quads'], ['glutes', 'biceps']],
    [/row/, ['upper back', 'lats'], ['biceps', 'delts']],
    [/shrug/, ['traps'], []],
    [/overhead press|shoulder press|military press|arnold/, ['delts'], ['triceps', 'traps']],
    [/lateral raise|front raise|y-?raise|dislocate/, ['delts'], ['traps']],
    [/tricep|skull|kickback|push-?down|close-grip push/, ['triceps'], ['chest']],
    [/press-?up|push-?up|chest press|floor press|bench press|\bfly\b|flye/, ['chest'], ['triceps', 'delts']],
    [/pallof|anti-?rotation|side plank|woodchop|twist|suitcase/, ['obliques', 'abs'], []],
    [/dead ?bug|crunch|plank|hollow|v-?up|sit-?up|rollout|roll-?out|jack ?knife|leg raise|knee raise/, ['abs'], ['hip flexors']],
    [/back extension|superman|bird ?dog|good morning/, ['lower back'], ['glutes', 'hamstrings']],
    [/deadlift|rdl|pull[- ]through|hinge/, ['hamstrings', 'glutes'], ['lower back']],
    [/hip thrust|glute bridge|hip lift|bridge|clam|hip extension/, ['glutes'], ['hamstrings']],
    [/abduction|lateral walk|monster walk|side step/, ['abductors'], ['glutes']],
    [/adduction|copenhagen/, ['adductors'], []],
    [/squat|lunge|step-?up|leg press|leg extension/, ['quads', 'glutes'], ['adductors']],
    [/calf/, ['calves'], []],
  ];
  function cleanName(name) {
    return String(name || '').toLowerCase().replace(/^[a-z]\d\s*[·.:-]\s*/i, '').replace(/\(.*?\)/g, '').trim();
  }
  // `lib` (optional) is the exercise library: an exact name match uses its tagged
  // target/secondary instead of guessing.
  function musclesForExercise(name, lib) {
    const n = cleanName(name);
    if (lib && Array.isArray(lib.exercises)) {
      const hit = lib.exercises.find(e => e.name === n);
      if (hit) return { primary: normalizeMuscles([hit.target]), secondary: normalizeMuscles(hit.secondary).filter(m => m !== normalizeMuscle(hit.target)) };
    }
    for (const [re, primary, secondary] of RULES) if (re.test(n)) return { primary: primary.slice(), secondary: secondary.slice() };
    return { primary: [], secondary: [] };
  }

  // ── hard sets ─────────────────────────────────────────────
  // A set is "rated" if we know how hard it was: a per-set RIR, or failing that the
  // session RPE. It is HARD at RIR ≤ 3, or (no RIR) session RPE ≥ 7. Primary muscles get
  // 1 per hard set, secondary ½ — the usual fractional-set convention.
  const HARD_RIR = 3, HARD_RPE = 7, MIN_RATED_FOR_AVG = 5;

  function isRated(set, entry) { return (set && set.rir != null && Number.isFinite(+set.rir)) || (entry && Number.isFinite(+entry.sessionRpe) && +entry.sessionRpe > 0); }
  function isHard(set, entry) {
    if (set && set.rir != null && Number.isFinite(+set.rir)) return +set.rir <= HARD_RIR;
    return !!(entry && Number.isFinite(+entry.sessionRpe) && +entry.sessionRpe >= HARD_RPE);
  }

  function emptyCounts() { const o = {}; MUSCLES.forEach(m => { o[m] = 0; }); return o; }

  // `muscleOf(exercise)` → { primary, secondary }. Defaults to the exercise's own tag,
  // then the name rules.
  function defaultMuscleOf(ex) {
    if (ex && ex.muscles && (ex.muscles.primary || ex.muscles.secondary)) {
      return { primary: normalizeMuscles(ex.muscles.primary), secondary: normalizeMuscles(ex.muscles.secondary) };
    }
    return musclesForExercise(ex && ex.name);
  }

  function hardSetsByMuscle(entries, { from, to, muscleOf = defaultMuscleOf } = {}) {
    const counts = emptyCounts();
    let ratedSets = 0, hardSets = 0, totalSets = 0;
    (entries || []).forEach(e => {
      if (!e || typeof e.date !== 'string') return;
      if (from && e.date < from) return;
      if (to && e.date > to) return;
      (e.exercises || []).forEach(ex => {
        const m = muscleOf(ex) || { primary: [], secondary: [] };
        (ex.sets || []).forEach(st => {
          totalSets++;
          if (!isRated(st, e)) return;
          ratedSets++;
          if (!isHard(st, e)) return;
          hardSets++;
          m.primary.forEach(x => { if (x in counts) counts[x] += 1; });
          m.secondary.forEach(x => { if (x in counts && !m.primary.includes(x)) counts[x] += 0.5; });
        });
      });
    });
    return { counts, ratedSets, hardSets, totalSets };
  }

  function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function mondayOf(iso) { const d = new Date(iso + 'T12:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; return addDays(iso, -dow); }

  // This week (Mon→today) plus the average of the previous `weeks` full weeks.
  // Averages — and the neglected list built on them — only appear once there are at
  // least MIN_RATED_FOR_AVG rated sets in the window; below that they'd be noise.
  function weeklyHardSets(entries, today, { weeks = 4, muscleOf = defaultMuscleOf, tracked = TRACKED } = {}) {
    const wkStart = mondayOf(today);
    const thisWeek = hardSetsByMuscle(entries, { from: wkStart, to: today, muscleOf });
    const past = [];
    for (let i = 1; i <= weeks; i++) {
      const from = addDays(wkStart, -7 * i), to = addDays(from, 6);
      past.push({ start: from, ...hardSetsByMuscle(entries, { from, to, muscleOf }) });
    }
    const ratedSets = thisWeek.ratedSets + past.reduce((n, w) => n + w.ratedSets, 0);
    const showAverages = ratedSets >= MIN_RATED_FOR_AVG;
    const avg = emptyCounts();
    if (showAverages) MUSCLES.forEach(m => { avg[m] = Math.round((past.reduce((n, w) => n + w.counts[m], 0) / weeks) * 10) / 10; });
    // Neglected: a tracked muscle averaging under 2 hard sets a week, and not already
    // made up for this week.
    const neglected = showAverages ? tracked.filter(m => avg[m] < 2 && thisWeek.counts[m] < 2) : [];
    return { weekStart: wkStart, week: thisWeek.counts, weekHard: thisWeek.hardSets, avg, ratedSets, showAverages, neglected, weeks: past };
  }

  root.MuscleCore = {
    MUSCLES, TRACKED, HARD_RIR, HARD_RPE, MIN_RATED_FOR_AVG,
    normalizeMuscle, normalizeMuscles, musclesForExercise, cleanName,
    isRated, isHard, hardSetsByMuscle, weeklyHardSets, mondayOf,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
