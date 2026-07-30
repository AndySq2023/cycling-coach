// Route geometry is stored as an encoded polyline (~5.6x smaller than raw JSON — see
// app/cycling-coach.html's encodeRouteGeom comment) so saved routes are cheap enough to
// sync across devices. A single bad delta anywhere in that codec corrupts every point
// after it, so this pins down round-trip fidelity, not just "it runs".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppFunctions } from './_load-app.mjs';

const { encodeRouteGeom, decodeRouteGeom } = loadAppFunctions(['encodeRouteGeom', 'decodeRouteGeom']);

function roundTrip(points) {
  return decodeRouteGeom(encodeRouteGeom(points));
}

test('round-trips a realistic route losslessly at 5dp / whole-metre elevation', () => {
  const pts = [];
  let lon = -0.2317, lat = 51.4713;
  // seeded PRNG so the test is deterministic
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 2500; i++) {
    lon += (rand() - 0.5) * 0.0004;
    lat += (rand() - 0.5) * 0.0004;
    pts.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, Math.round(10 + rand() * 90)]);
  }
  const out = roundTrip(pts);
  assert.equal(out.length, pts.length);
  for (let i = 0; i < pts.length; i++) {
    assert.equal(out[i][0], pts[i][0], `lon mismatch at point ${i}`);
    assert.equal(out[i][1], pts[i][1], `lat mismatch at point ${i}`);
    assert.equal(out[i][2], pts[i][2], `elevation mismatch at point ${i}`);
  }
});

test('handles negative longitude, southern hemisphere, and negative elevation', () => {
  const pts = [[-0.5, -33.86, 0], [179.99999, -89.99999, -50], [0, 0, 1234], [-179.99999, 89.99999, 0]];
  assert.deepEqual(roundTrip(pts), pts);
});

test('an empty route encodes to an empty string and decodes to an empty array', () => {
  assert.equal(encodeRouteGeom([]), '');
  assert.deepEqual(decodeRouteGeom(''), []);
});

test('a single point round-trips exactly', () => {
  assert.deepEqual(roundTrip([[-0.2317, 51.4713, 42]]), [[-0.2317, 51.4713, 42]]);
});

test('a route with no elevation data (null) treats it as zero, not NaN', () => {
  const pts = [[-0.2317, 51.4713, null], [-0.2320, 51.4720, null]];
  const out = roundTrip(pts);
  assert.deepEqual(out.map(p => p[2]), [0, 0]);
});
