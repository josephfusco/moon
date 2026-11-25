// Compare our geometry against NASA SVS Dial-A-Moon (geocentric, hourly) for a spread of 2026 dates.
// Run: node scripts/validate.mjs
import { moonState, moonAge } from '../src/ephemeris.js';

const stamps = [];
for (let i = 0; i < 24; i++) {
  const d = new Date(Date.UTC(2026, 0, 3, 5) + i * 15.2 * 86400000 + i * 3600000 * 7);
  if (d.getUTCFullYear() === 2026) stamps.push(d.toISOString().slice(0, 13) + ':00');
}
const wrap = (d) => ((d + 540) % 360) - 180;
const worst = {};
const track = (k, v) => { worst[k] = Math.max(worst[k] ?? 0, Math.abs(v)); };

console.log('time              Δphase%  Δage(d) Δdiam"  Δdist(km) Δsubearth(lon,lat)°  Δsubsolar(lon,lat)°  Δposangle°');
for (const s of stamps) {
  const res = await fetch(`https://svs.gsfc.nasa.gov/api/dialamoon/${s}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const n = await res.json();
  const date = new Date(s + ':00Z');
  const m = moonState(date);
  const d = {
    phase: m.illuminated * 100 - n.phase,
    age: moonAge(date) - n.age,
    diam: m.angularDiameterArcsec - n.diameter,
    dist: m.distance - n.distance,
    seLon: wrap(m.subObserver.lon - n.subearth_lon), seLat: m.subObserver.lat - n.subearth_lat,
    ssLon: wrap(m.subSolar.lon - n.subsolar_lon), ssLat: m.subSolar.lat - n.subsolar_lat,
    pa: wrap(m.posAngle - n.posangle),
  };
  Object.entries(d).forEach(([k, v]) => track(k, v));
  const f = (v, w = 7, p = 3) => v.toFixed(p).padStart(w);
  console.log(`${s}  ${f(d.phase)} ${f(d.age)} ${f(d.diam, 7, 2)} ${f(d.dist, 9, 1)}   ${f(d.seLon)} ${f(d.seLat)}      ${f(d.ssLon)} ${f(d.ssLat)}     ${f(d.pa)}`);
}
console.log('\nworst absolute differences:', Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toFixed(4)])));
