// Record NASA SVS Dial-A-Moon values (geocentric, hourly) so the tests can run offline.
// Run: node scripts/record-dialamoon.mjs
import { writeFileSync } from 'node:fs';

const API = 'https://svs.gsfc.nasa.gov/api/dialamoon/';
const stamps = [];
for (const year of [2025, 2026, 2027]) {
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(year, 0, 3, 5) + i * 30.4 * 86400000 + i * 3600000 * 7);
    if (d.getUTCFullYear() === year) stamps.push(d.toISOString().slice(0, 13) + ':00');
  }
}
const rows = [];
for (const s of stamps) {
  const res = await fetch(API + s, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) { console.log(s, 'HTTP', res.status); continue; }
  const n = await res.json().catch(() => null);
  if (!n || typeof n.phase !== 'number') { console.log(s, 'no data'); continue; }
  rows.push({ time: s, phase: n.phase, age: n.age, diameter: n.diameter, distance: n.distance, subearth_lon: n.subearth_lon, subearth_lat: n.subearth_lat, subsolar_lon: n.subsolar_lon, subsolar_lat: n.subsolar_lat, posangle: n.posangle });
}
writeFileSync(new URL('../test/fixtures/dialamoon.json', import.meta.url), JSON.stringify({ source: API, fetched: new Date().toISOString().slice(0, 10), rows }, null, 1) + '\n');
console.log(`recorded ${rows.length} of ${stamps.length}`, [...new Set(rows.map((r) => r.time.slice(0, 4)))]);
