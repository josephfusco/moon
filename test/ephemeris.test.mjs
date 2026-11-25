// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as A from 'astronomy-engine';
import { moonState, moonAge, phaseName, searchPhase, localEffects, EARTH_RADIUS_KM, AU_KM } from '../src/ephemeris.js';

const ref = JSON.parse(readFileSync(new URL('./fixtures/dialamoon.json', import.meta.url)));
const wrap = (d) => ((d + 540) % 360) - 180;

// The tolerances stated in the About text ("How this Moon is made"). If these fail, that text is wrong.
const CLAIM = { phase: 0.006, libration: 0.005, subsolar: 0.005, posangle: 0.2, distance: 55 };
// Dial-A-Moon publishes rounded values, so half of its last digit is added to each limit.
const ROUND = { phase: 0.005, angle: 0.0005, distance: 0.5 };

test(`geometry matches NASA Dial-A-Moon (${ref.rows.length} instants, fetched ${ref.fetched})`, () => {
  const worst = { phase: 0, libration: 0, subsolar: 0, posangle: 0, distance: 0, age: 0, diameter: 0 };
  for (const n of ref.rows) {
    const date = new Date(n.time + ':00Z');
    const m = moonState(date);
    const d = {
      phase: m.illuminated * 100 - n.phase,
      libration: Math.max(Math.abs(wrap(m.subObserver.lon - n.subearth_lon)), Math.abs(m.subObserver.lat - n.subearth_lat)),
      subsolar: Math.max(Math.abs(wrap(m.subSolar.lon - n.subsolar_lon)), Math.abs(m.subSolar.lat - n.subsolar_lat)),
      posangle: wrap(m.posAngle - n.posangle),
      distance: m.distance - n.distance,
      age: moonAge(date) - n.age,
      diameter: m.angularDiameterArcsec - n.diameter,
    };
    for (const k in d) worst[k] = Math.max(worst[k], Math.abs(d[k]));
  }
  console.log('worst differences:', Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toFixed(4)])));
  assert.ok(worst.phase <= CLAIM.phase + ROUND.phase, `illumination off by ${worst.phase}%`);
  assert.ok(worst.libration <= CLAIM.libration + ROUND.angle, `libration off by ${worst.libration}°`);
  assert.ok(worst.subsolar <= CLAIM.subsolar + ROUND.angle, `sub-solar point off by ${worst.subsolar}°`);
  assert.ok(worst.posangle <= CLAIM.posangle + ROUND.angle, `axis tilt off by ${worst.posangle}°`);
  assert.ok(worst.distance <= CLAIM.distance + ROUND.distance, `distance off by ${worst.distance} km`);
  assert.ok(worst.age <= 0.01, `age off by ${worst.age} days`);
  assert.ok(worst.diameter <= 0.5, `diameter off by ${worst.diameter} arcsec`);
});

test('phase names: principal phases at their instants, the rest in between', () => {
  const from = new Date('2026-01-01T00:00Z');
  for (const [deg, name] of [[0, 'New Moon'], [90, 'First Quarter'], [180, 'Full Moon'], [270, 'Last Quarter']]) {
    const t = searchPhase(deg, from, 1);
    assert.equal(phaseName(moonState(t).elongation), name);
  }
  assert.equal(phaseName(45), 'Waxing Crescent');
  assert.equal(phaseName(135), 'Waxing Gibbous');
  assert.equal(phaseName(225), 'Waning Gibbous');
  assert.equal(phaseName(315), 'Waning Crescent');
  assert.equal(phaseName(-45), 'Waning Crescent');
});

test('searchPhase finds instants about one synodic month apart', () => {
  const a = searchPhase(180, new Date('2026-01-01T00:00Z'), 1);
  const b = searchPhase(180, new Date(a.getTime() + 86400000), 1);
  const days = (b - a) / 86400000;
  assert.ok(days > 29.2 && days < 29.9, `${days} days between full moons`);
});

// Independent check of the tide: the textbook first-order formula for the vertical tidal acceleration,
// GM r (3 cos²ψ − 1) / d³, with ψ the body's zenith angle seen from the Earth's center.
test('tide-raising acceleration agrees with the first-order formula', () => {
  const GM = { moon: 4902.800066, sun: 132712440018 };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(...a);
  const km = (v) => [v.x * AU_KM, v.y * AU_KM, v.z * AU_KM];
  let worst = 0, peakMoon = 0, peakSun = 0;
  for (let i = 0; i < 400; i++) {
    const date = new Date(Date.UTC(2026, 0, 1) + i * 37.3 * 3600000);
    const where = { lat: ((i * 37) % 170) - 85, lon: ((i * 73) % 360) - 180 };
    const time = A.MakeTime(date);
    const r = km(A.ObserverVector(time, new A.Observer(where.lat, where.lon, 0), false));
    const first = (gm, body) => {
      const c = dot(r, body) / (len(r) * len(body));
      return (gm * len(r) * (3 * c * c - 1)) / len(body) ** 3 * 1e9;
    };
    const fx = localEffects(date, where);
    const moon = first(GM.moon, km(A.GeoMoon(time))), sun = first(GM.sun, km(A.GeoVector(A.Body.Sun, time, true)));
    // First-order drops terms of order r/d (about 1.7% for the Moon); the local vertical also differs
    // from the geocentric one by up to 0.19°. Allow 0.05 µm/s².
    worst = Math.max(worst, Math.abs(fx.tideMoon - moon), Math.abs(fx.tideSun - sun));
    peakMoon = Math.max(peakMoon, fx.tideMoon); peakSun = Math.max(peakSun, fx.tideSun);
    assert.ok(Math.abs(fx.tide - (fx.tideMoon + fx.tideSun)) < 1e-12);
  }
  console.log('tide: worst difference from first-order', +worst.toFixed(4), 'µm/s²; peaks', +peakMoon.toFixed(3), +peakSun.toFixed(3));
  assert.ok(worst < 0.05, `differs from the first-order formula by ${worst} µm/s²`);
  assert.ok(peakMoon > 0.9 && peakMoon < 1.45, `Moon peak ${peakMoon}`);
  assert.ok(peakSun > 0.4 && peakSun < 0.56, `Sun peak ${peakSun}`);
  assert.ok(EARTH_RADIUS_KM > 6370);
});

test('local sky position matches the topocentric state', () => {
  const date = new Date('2026-11-25T18:00Z'), where = { lat: 42.44, lon: -76.5 };
  const fx = localEffects(date, where), st = moonState(date, where);
  assert.ok(Math.abs(fx.altitude - st.horizon.altitude) < 1e-9);
  assert.ok(Math.abs(fx.azimuth - st.horizon.azimuth) < 1e-9);
});
