// Shared intervals.icu response shaping — used by BOTH the hosted function
// (api/intervals.js) and the local proxy (proxy/server.js), exactly like
// shared/strava-core.js. This file owns what we ask intervals.icu for and the
// shape the app consumes; credential handling belongs to the callers.
//
// Auth is plain HTTP Basic with the literal username "API_KEY" — no OAuth, no
// refresh token, so unlike Strava and WHOOP there is nothing to rotate and no
// KV write path. The key is read-only over the athlete's own data.

const BASE = 'https://intervals.icu/api/v1';

function authHeader(apiKey) {
  return 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');
}

async function icu(path, apiKey) {
  const res = await fetch(BASE + path, { headers: { Authorization: authHeader(apiKey) } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`intervals.icu ${path.split('?')[0]} failed (${res.status}): ${body}`);
  }
  return res.json();
}

const iso = (d) => d.toISOString().slice(0, 10);
const round = (n, p = 0) => (n == null ? null : Number(Number(n).toFixed(p)));

// Durations lifted out of the 90-day power curve. Deliberately few: these are the
// five the coach actually reasons about (sprint, anaerobic, VO2, threshold, aerobic),
// and the raw curve is 184 points which would bloat every system prompt.
const CURVE_POINTS = [[5, '5s'], [60, '1m'], [300, '5m'], [1200, '20m'], [3600, '60m']];

// Six weeks of CTL/ATL — enough to see a block build and taper without shipping a
// year of wellness rows to the browser on every load.
const TREND_DAYS = 42;

// How far back to hunt for double-counted rides, and how far apart two records of the
// same ride can start and still be the same ride. Strava and a head-unit upload of one
// ride normally land on the identical second, but a re-encode can shift it slightly.
const DUPE_SCAN_DAYS = 90;
const DUPE_TOLERANCE_S = 120;

// The power curve is only ever built from activities the API can actually see, and
// intervals.icu will not expose Strava-originated rides. With the Strava sync off, the
// curve therefore covers ONLY direct uploads (iGPSPORT/Favero) — accurate, but thin
// until that feed builds up history. Below this many rides the curve is a sample, not
// a 90-day best, and must not be presented as one: a single ride would otherwise show
// up as a collapse in threshold power.
const CURVE_MIN_RIDES = 5;

// Pull the newest wellness row that actually carries a fitness number. Today's row
// exists from midnight but stays null until intervals.icu processes the day, so
// naively taking the last entry gives you a blank panel every morning.
function latestWithCtl(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i] && rows[i].ctl != null) return rows[i];
  }
  return null;
}

// sportInfo is per-sport; we only care about the bike.
function rideInfo(row) {
  return (row?.sportInfo || []).find(s => s.type === 'Ride') || {};
}

// power_zones are upper bounds expressed as a % of FTP — turn them into watts so the
// app never has to know the encoding.
function zonesToWatts(settings) {
  const ftp = settings?.ftp;
  const pcts = settings?.power_zones;
  const names = settings?.power_zone_names || [];
  if (!ftp || !Array.isArray(pcts)) return null;
  let floor = 0;
  return pcts.map((pct, i) => {
    const max = Math.round((ftp * pct) / 100);
    const zone = {
      name: names[i] || `Z${i + 1}`,
      min_w: floor,
      // The top zone's 999% is a sentinel for "no ceiling", not a real wattage.
      max_w: pct >= 999 ? null : max,
    };
    floor = max + 1;
    return zone;
  });
}

// Two feeds into one intervals.icu account (e.g. Strava sync AND a head-unit upload)
// double-count the ride: intervals.icu sums BOTH training loads into the day, which
// inflates CTL/ATL and drags Form down for weeks. Nothing downstream can unpick that
// from the modelled numbers alone, so we detect it at the activity level and say so.
//
// NOTE: Strava-sourced activities come back from the API with almost every field null
// (intervals.icu can't re-serve Strava data to third parties), so matching on start
// time is the ONLY signal available — name, distance and load are all blank there.
function findDuplicates(activities) {
  const rides = (Array.isArray(activities) ? activities : [])
    .filter(a => a?.start_date_local)
    .map(a => ({
      t: Date.parse(a.start_date_local),
      date: a.start_date_local.slice(0, 10),
      id: a.id,
      source: a.source || 'UNKNOWN',
      load: a.icu_training_load ?? null,
    }))
    .filter(a => Number.isFinite(a.t))
    .sort((a, b) => a.t - b.t);

  const groups = [];
  for (const ride of rides) {
    const last = groups[groups.length - 1];
    if (last && ride.t - last[last.length - 1].t <= DUPE_TOLERANCE_S * 1000) last.push(ride);
    else groups.push([ride]);
  }

  return groups
    .filter(g => g.length > 1)
    .map(g => ({
      date: g[0].date,
      count: g.length,
      sources: g.map(r => r.source),
      ids: g.map(r => r.id),
      // Only the non-Strava copies report a load, so this is the visible part of the
      // over-count, not necessarily the whole of it.
      counted_load: g.reduce((n, r) => n + (r.load || 0), 0) || null,
    }));
}

export async function buildIntervalsSummary(athleteId, apiKey) {
  const today = new Date();
  const oldest = new Date(today.getTime() - TREND_DAYS * 86400000);

  // allSettled, not all: a power-curve outage must not blank out CTL/ATL. Each
  // section degrades to null on its own and the panel shows a dash for that row.
  const dupeFrom = new Date(today.getTime() - DUPE_SCAN_DAYS * 86400000);

  const [wellnessR, settingsR, curveR, activitiesR] = await Promise.allSettled([
    icu(`/athlete/${athleteId}/wellness?oldest=${iso(oldest)}&newest=${iso(today)}`, apiKey),
    icu(`/athlete/${athleteId}/sport-settings`, apiKey),
    icu(`/athlete/${athleteId}/power-curves?curves=90d&type=Ride`, apiKey),
    icu(`/athlete/${athleteId}/activities?oldest=${iso(dupeFrom)}&newest=${iso(today)}`, apiKey),
    // NOTE: this list is what the API is ALLOWED to expose, not everything intervals.icu
    // holds — Strava-sourced rides are omitted entirely once the Strava link is revoked,
    // while still counting towards CTL/ATL. Never infer "no training" from it.
  ]);

  const wellness = wellnessR.status === 'fulfilled' ? wellnessR.value : [];
  const settings = settingsR.status === 'fulfilled' ? settingsR.value : [];
  const curve = curveR.status === 'fulfilled' ? curveR.value : null;
  const duplicates = activitiesR.status === 'fulfilled' ? findDuplicates(activitiesR.value) : [];
  const visibleRides = activitiesR.status === 'fulfilled' && Array.isArray(activitiesR.value)
    ? activitiesR.value.filter(a => (a.icu_training_load ?? null) !== null).length
    : null;

  // If every call failed the key or athlete id is wrong — say so rather than
  // returning a summary of nothing that looks like "no training yet".
  if (wellnessR.status === 'rejected' && settingsR.status === 'rejected') {
    throw new Error(wellnessR.reason?.message || 'intervals.icu unreachable');
  }

  const rows = Array.isArray(wellness) ? wellness : [];
  const latest = latestWithCtl(rows);
  const info = rideInfo(latest);

  const bike = (Array.isArray(settings) ? settings : [])
    .find(s => (s.types || []).includes('Ride')) || null;

  const curveData = curve?.list?.[0] || null;
  const wattsBySec = curveData
    ? Object.fromEntries((curveData.secs || []).map((s, i) => [s, (curveData.watts || [])[i]]))
    : {};

  const power_curve = curveData
    ? Object.fromEntries(CURVE_POINTS.map(([secs, label]) => [label, wattsBySec[secs] ?? null]))
    : null;

  // Say how much the curve is standing on, so the app and the coach can treat a
  // one-ride sample differently from a real 90-day best.
  const power_curve_coverage = {
    rides: visibleRides,
    provisional: visibleRides != null && visibleRides < CURVE_MIN_RIDES,
    min_rides: CURVE_MIN_RIDES,
  };

  const ctl = round(latest?.ctl, 1);
  const atl = round(latest?.atl, 1);

  return {
    athlete_id: athleteId,
    // Fitness / fatigue / form — the reason to plug intervals.icu in at all.
    // Form is CTL - ATL (intervals.icu calls it "Form"; TrainingPeaks calls it TSB).
    fitness: {
      date: latest?.id || null,
      ctl,
      atl,
      form: ctl != null && atl != null ? round(ctl - atl, 1) : null,
      ramp_rate: round(latest?.rampRate, 1),
    },
    power: {
      // ftp is what the athlete has SET; eftp is what intervals.icu estimates from
      // the data. They disagree and the gap is the interesting part.
      ftp: bike?.ftp ?? null,
      eftp: round(info.eftp),
      w_prime: round(info.wPrime),
      p_max: round(info.pMax),
      lthr: bike?.lthr ?? null,
      max_hr: bike?.max_hr ?? null,
      zones: zonesToWatts(bike),
    },
    power_curve,
    power_curve_coverage,
    weight_kg: round(curveData?.weight, 1),
    // Non-empty means CTL/ATL/Form above are inflated — treat them as an upper bound.
    duplicates,
    // Chart-only series, mirroring how strava-core ships `history`.
    trend: rows
      .filter(r => r.ctl != null)
      .map(r => ({ date: r.id, ctl: round(r.ctl, 1), atl: round(r.atl, 1) })),
    updated: new Date().toISOString(),
  };
}
