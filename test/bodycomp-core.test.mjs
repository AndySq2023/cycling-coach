// shared/bodycomp-core.js turns the Hume Sheet into the body comp payload. The failure
// modes worth pinning: a column landing in the wrong field, a blank cell becoming 0, and
// the private key — pasted into Vercel by hand — not parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  parseHeader, parseRows, missingMonths, normalizePrivateKey,
  buildServiceAccountJwt, buildBodyCompFromValues,
} from '../shared/bodycomp-core.js';

const HEADER = [
  'Month', 'Source file', 'Health score (as shown)',
  'Weight start (kg)', 'Weight end (kg)', 'Body fat start (%)', 'Body fat end (%)',
  'Lean mass start (kg)', 'Lean mass end (kg)', 'Visceral fat index start', 'Visceral fat index end',
  'A/G ratio start (%)', 'A/G ratio end (%)', 'BMR start (kcal)', 'BMR end (kcal)',
];

test('parseHeader: start/end columns get a unit-suffixed key, plain columns a plain key', () => {
  assert.deepEqual(parseHeader('Skeletal muscle mass end (kg)'), { key: 'skeletal_muscle_mass_kg', side: 'end' });
  assert.deepEqual(parseHeader('Body fat start (%)'), { key: 'body_fat_pct', side: 'start' });
  assert.deepEqual(parseHeader('Visceral fat index start'), { key: 'visceral_fat_index', side: 'start' });
  assert.deepEqual(parseHeader('A/G ratio end (%)'), { key: 'a_g_ratio_pct', side: 'end' });
  assert.deepEqual(parseHeader('Health score (as shown)'), { key: 'health_score', side: null });
  assert.deepEqual(parseHeader('Period'), { key: 'month', side: null });
});

test('parseRows: matches by header, keeps blanks as null (never 0)', () => {
  const rows = parseRows([
    HEADER,
    ['2026-09', 'sep.png', 584, 101.5, 100.6, 20.1, 20.4, 77.2, 76.9, 7, 9, '', '', 2055, 2042],
  ]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.month, '2026-09');
  assert.equal(r.source_file, 'sep.png');
  assert.equal(r.health_score, 584);
  assert.deepEqual(r.metrics.weight_kg, { start: 101.5, end: 100.6 });
  assert.deepEqual(r.metrics.visceral_fat_index, { start: 7, end: 9 });
  assert.deepEqual(r.metrics.a_g_ratio_pct, { start: null, end: null });
});

test('parseRows: a reordered column still lands in the right field', () => {
  const swapped = [...HEADER];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  const [r] = parseRows([swapped, ['2026-09', 'x', 584, 100.6, 101.5]]);
  assert.deepEqual(r.metrics.weight_kg, { start: 101.5, end: 100.6 });
});

test('parseRows: blank trailing rows are skipped', () => {
  assert.equal(parseRows([HEADER, ['2026-09', 'x'], [], ['', '']]).length, 1);
});

test('missingMonths: reports the gap, across a year boundary too', () => {
  const r = m => ({ month: m });
  assert.deepEqual(missingMonths([r('2026-09'), r('2026-11')]), ['2026-10']);
  assert.deepEqual(missingMonths([r('2025-11'), r('2026-02')]), ['2025-12', '2026-01']);
  assert.deepEqual(missingMonths([r('2026-09')]), []);
});

test('buildBodyCompFromValues: sorts by month, trends use period end, change spans first start to latest end', () => {
  const out = buildBodyCompFromValues({
    monthly: [
      HEADER,
      ['2026-11', 'nov.png', 690, 98.5, 99.5, 20.2, 18.9, 76.2, 76.3, 9, 7, 105.3, 105.8, 2022, 2047],
      ['2025-11', 'nov25.png', 584, 126.8, 122.2, 28.7, 26.3, 84.3, 84.0, 17, 15, '', '', 2208, 2195],
    ],
    total: [],
  });
  assert.equal(out.first_month, '2025-11');
  assert.equal(out.latest_month, '2026-11');
  assert.equal(out.trend[0].weight_kg, 122.2);
  assert.equal(out.trend[1].weight_kg, 99.5);
  assert.equal(out.change_since_first.weight_kg, -27.3);
  assert.equal(out.latest.a_g_ratio_pct, 105.8);
  assert.equal(out.missing_months.length, 11);
});

test('buildBodyCompFromValues: an empty Sheet is an { error }, not a crash', () => {
  assert.ok(buildBodyCompFromValues({ monthly: [HEADER], total: [] }).error);
});

test('normalizePrivateKey: escaped, real-newline and quoted pastes all give the same PEM', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const escaped = pem.trim().replace(/\n/g, '\\n') + '\\n';
  assert.equal(normalizePrivateKey(pem), pem);
  assert.equal(normalizePrivateKey(escaped), pem);
  assert.equal(normalizePrivateKey(`"${escaped}"`), pem);
});

test('buildServiceAccountJwt: RS256 token with the right claims and a valid signature', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = buildServiceAccountJwt('svc@example.iam.gserviceaccount.com', pem, 1000);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  assert.equal(claims.iss, 'svc@example.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.match(claims.scope, /spreadsheets\.readonly/);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
});

test('buildServiceAccountJwt: a bad key names the env var to fix', () => {
  assert.throws(() => buildServiceAccountJwt('x', 'not a key'), /GOOGLE_PRIVATE_KEY/);
});
