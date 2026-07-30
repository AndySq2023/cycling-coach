// The coach LLM's day-of-week arithmetic is anchored to its training-era calendar — it
// has previously written an entire week dated the wrong year while the ground-truth
// prompt said otherwise. These guards are the only thing standing between that failure
// mode and a training plan silently landing on the wrong dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppFunctions } from './_load-app.mjs';

const { normalizePlanDates, repairPlanDates, sanitizePatchDate } = loadAppFunctions([
  'parsePlanDate', 'isoPlanDate', 'weekdayName', 'plausiblePlanDate',
  'normalizePlanDates', 'repairPlanDates', 'sanitizePatchDate',
]);

const iso = d => d.toISOString().slice(0, 10);
const today = () => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); return d; };

test('a plausible plan (today onward) is left untouched', () => {
  const t = today();
  const plan = [0, 1, 2].map(i => {
    const d = new Date(t.getTime() + i * 86400000);
    return { id: `s${i + 1}`, date: iso(d), day: d.toLocaleDateString('en-GB', { weekday: 'long' }) };
  });
  assert.equal(repairPlanDates(plan), plan, 'must return the SAME reference when nothing needed fixing');
});

test('a wrong-year plan is re-dated from the day name, staying in order', () => {
  const wrongYear = [
    { id: 's1', day: 'Monday', date: '2019-01-07' },
    { id: 's2', day: 'Tuesday', date: '2019-01-08' },
    { id: 's3', day: 'Wednesday', date: '2019-01-09' },
  ];
  const fixed = normalizePlanDates(wrongYear);
  const now = Date.now();
  for (const s of fixed) {
    const days = Math.abs(Math.round((Date.parse(s.date + 'T12:00:00') - now) / 86400000));
    assert.ok(days <= 15, `${s.date} should land near today, was ${days} days away`);
  }
  // day name must always match the date it was re-derived to.
  fixed.forEach(s => {
    const wd = new Date(s.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    assert.equal(s.day, wd, `day label must agree with date for ${JSON.stringify(s)}`);
  });
  // order preserved: each date strictly after the previous.
  for (let i = 1; i < fixed.length; i++) {
    assert.ok(Date.parse(fixed[i].date) > Date.parse(fixed[i - 1].date));
  }
});

test('repairPlanDates leaves a real (if stale) past week untouched — only >60 days off is corruption', () => {
  const t = today();
  const staleButReal = [0, 1].map(i => {
    const d = new Date(t.getTime() - (10 + i) * 86400000); // 10-11 days ago: stale, not corrupt
    return { id: `s${i + 1}`, date: iso(d), day: 'x' };
  });
  const result = repairPlanDates(staleButReal);
  assert.equal(result, staleButReal, 'a merely-stale week must not be rewritten');
});

test('an empty or non-array plan is handled without throwing', () => {
  assert.deepEqual(repairPlanDates([]), []);
  assert.equal(repairPlanDates(null), null);
  assert.equal(repairPlanDates(undefined), undefined);
});

test('sanitizePatchDate: a plausible date is normalised and its day re-derived', () => {
  const d = new Date(today().getTime() + 2 * 86400000);
  const patch = { id: 's3', date: iso(d), day: 'WRONG_DAY_NAME' };
  const clean = sanitizePatchDate(patch);
  const wd = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  assert.equal(clean.day, wd, 'a bogus day name must be corrected to match the date, not trusted');
});

test('sanitizePatchDate: an implausible date is dropped rather than trusted', () => {
  const patch = { id: 's3', type: 'Rest Day', date: '2019-01-01', day: 'Tuesday' };
  const clean = sanitizePatchDate(patch);
  assert.ok(!('date' in clean), 'a wrong-year patch date must be dropped');
  assert.ok(!('day' in clean), 'its day name must be dropped alongside it');
  assert.equal(clean.type, 'Rest Day', 'unrelated fields on the same patch must survive');
});

test('sanitizePatchDate: a patch with no date field is passed through unchanged', () => {
  const patch = { id: 's3', type: 'Rest Day', duration: 0 };
  assert.deepEqual(sanitizePatchDate(patch), patch);
});
