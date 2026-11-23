// Preview isolation: Vercel previews share the production KV database, so every key a
// preview writes must be namespaced — except the rotating provider refresh tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { envKey } from '../api/_kv.js';
import { readState } from '../api/_state.js';

test('envKey: production keeps the bare historical key', () => {
  assert.equal(envKey('coach_state', 'production'), 'coach_state');
  assert.equal(envKey('routes:master', 'production'), 'routes:master');
});

test('envKey: preview, development and unset all get the preview: prefix', () => {
  for (const env of ['preview', 'development', undefined, '']) {
    assert.equal(envKey('coach_state', env), 'preview:coach_state');
  }
});

test('refresh-token keys are never wrapped in envKey', () => {
  for (const f of ['api/strava.js', 'api/whoop.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.match(src, /const TOKEN_KEY = '(strava|whoop)_refresh_token';/);
    assert.doesNotMatch(src, /envKey\(\s*TOKEN_KEY/);
    assert.doesNotMatch(src, /envKey\(\s*'(strava|whoop)_refresh_token'/);
  }
});

function fakeKv(initial) {
  const store = { ...initial }; const writes = [];
  return { store, writes, io: { get: async k => store[k] ?? null, set: async (k, v) => { writes.push(k); store[k] = v; } } };
}

test('preview seeds from production once and only writes the prefixed key', async () => {
  const prod = { plan: [{ id: 's1', date: '2026-11-16' }], conversationHistory: [{ role: 'user', content: 'hi' }] };
  const kv = fakeKv({ coach_state: prod });
  const s = await readState(kv.io, 'preview');
  assert.equal(s.plan[0].id, 's1');
  assert.deepEqual(kv.writes, ['preview:coach_state']);
  assert.equal(kv.store.coach_state, prod, 'production blob untouched');
  // Second read finds the seed and does not re-copy.
  await readState(kv.io, 'preview');
  assert.deepEqual(kv.writes, ['preview:coach_state']);
});

test('production never seeds and never writes on read', async () => {
  const kv = fakeKv({});
  const s = await readState(kv.io, 'production');
  assert.deepEqual(s.plan, []);
  assert.deepEqual(kv.writes, []);
});

test('preview with an existing preview state ignores production', async () => {
  const kv = fakeKv({ coach_state: { goal: 'prod' }, 'preview:coach_state': { goal: 'preview' } });
  assert.equal((await readState(kv.io, 'preview')).goal, 'preview');
  assert.deepEqual(kv.writes, []);
});
