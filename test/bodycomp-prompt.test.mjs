// buildBodyCompText() turns the /api/bodycomp payload into the coach's body composition
// block. The numbers it derives (share of weight lost as lean mass) are what the coach
// reasons from, so they're pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppFunctions } from './_load-app.mjs';

const { buildBodyCompText } = loadAppFunctions(['buildBodyCompText']);

const point = (month, w, f, lean, smm) => ({
  month, weight_kg: w, body_fat_pct: f, lean_mass_kg: lean, skeletal_muscle_mass_kg: smm,
});
const payload = {
  first_month: '2025-11', latest_month: '2026-11',
  latest: { weight_kg: 99.5, body_fat_pct: 18.9, body_fat_mass_kg: 18.8, lean_mass_kg: 76.3, skeletal_muscle_mass_kg: 52.4, visceral_fat_index: 7, bmr_kcal: 2047 },
  change_since_first: { weight_kg: -27.3, body_fat_mass_kg: -17.6, lean_mass_kg: -8, skeletal_muscle_mass_kg: -7.5, body_fat_pct: -9.8 },
  missing_months: ['2026-10'],
  trend: [
    point('2026-07', 102.8, 21.2, 77.4, 54.0),
    point('2026-08', 101.6, 20.8, 76.9, 53.5),
    point('2026-09', 100.6, 20.4, 76.9, 53.5),
    point('2026-11', 99.5, 18.9, 76.3, 52.4),
  ],
};

test('no data, or an error payload, adds nothing to the prompt', () => {
  assert.equal(buildBodyCompText(null), '');
  assert.equal(buildBodyCompText({ error: 'x' }), '');
});

test('reports latest values and the overall lean share of the loss', () => {
  const t = buildBodyCompText(payload);
  assert.match(t, /Latest report \(2026-11\): weight 99\.5kg, body fat 18\.9%/);
  assert.match(t, /Change since 2025-11: weight -27\.3kg/);
  assert.match(t, /29% was lean mass/); // 8 / 27.3
});

test('the last-three-reports window uses the 4th-from-last point as its start', () => {
  const t = buildBodyCompText(payload);
  // 102.8 → 99.5 = -3.3kg; lean 77.4 → 76.3 = -1.1kg → 33%
  assert.match(t, /2026-07 → 2026-11\): weight -3\.3kg, lean mass -1\.1kg, skeletal muscle -1\.6kg — 33% of the loss/);
});

test('missing months are named so a gap is not read as a plateau', () => {
  assert.match(buildBodyCompText(payload), /No report for: 2026-10/);
});

test('no lean share is claimed when weight barely moved', () => {
  const flat = { ...payload, change_since_first: { weight_kg: -0.2, lean_mass_kg: -0.5 }, trend: payload.trend.slice(-1) };
  const t = buildBodyCompText(flat);
  assert.doesNotMatch(t, /was lean mass/);
  assert.doesNotMatch(t, /Last three reports/);
});
