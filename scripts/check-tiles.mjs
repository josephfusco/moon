// Acceptance checks for the detail tiles, in a real browser. Needs the dev server running (npm run dev)
// and tiles baked (npm run tiles). Run: node scripts/check-tiles.mjs   Screenshots land in .checks/
import { openBrowser, sleep } from './browser.mjs';

const URL0 = process.env.URL ?? 'http://localhost:5173/';
const FULL = '?t=2026-10-26T04:12Z'; // a full Moon: everything on the near side is lit
const b = await openBrowser({ width: 1288, height: 672, scale: 2 });
const out = {}, fail = [];
const check = (name, ok, detail) => { out[name] = detail; if (!ok) fail.push(name); };
const stats = async () => JSON.parse(await b.ev('JSON.stringify(window.__moon.scene.tileStats())'));
const tileRequests = () => b.requests.filter((u) => u.includes('/tiles/v')).length;
const settle = async () => { for (let i = 0; i < 40; i++) { await sleep(500); const s = await stats(); if (!s.loading && s.shown > 0) return s; } return stats(); };
const lookAt = (lon, lat, zoom) => b.ev(`(()=>{const S=window.__moon.S;S.lon=${lon};S.lat=${lat};S.zoom=${zoom}})()`);

await b.goto(URL0 + FULL, 7000);
check('whole disc uses no tiles', tileRequests() === 0 && (await stats()).level === null, { requests: tileRequests(), ...(await stats()) });

await b.ev(`window.__moon.setMode('explore'); document.getElementById('btn-labels').click()`);
for (const [name, lon, lat] of [['tycho', -11.36, -43.31], ['copernicus', -20.08, 9.62], ['plato', -9.38, 51.62]]) {
  await lookAt(lon, lat, 10);
  const s = await settle();
  check(`${name} at 10x`, s.level === 5 && s.shown > 0 && s.failed === 0, s);
  await b.shot(`tiles-${name}`);
}
const afterThree = tileRequests();
check('requests stay bounded', afterThree < 3 * 2 * 40, { requests: afterThree });

// Seams: even "map light" across the 180° meridian and across a tile corner on the equator.
await b.ev(`document.getElementById('btn-map').click()`);
await lookAt(180, 0, 10); check('seam at 180°', (await settle()).failed === 0, await stats()); await b.shot('tiles-seam-180');
await lookAt(0, 0, 10); check('tile corner at 0°, 0°', (await settle()).failed === 0, await stats()); await b.shot('tiles-seam-corner');
await b.ev(`document.getElementById('btn-map').click()`);

// Raking light: three days after first quarter the terminator is near Copernicus.
await b.ev(`window.__moon.goTo(Date.parse('2026-10-20T06:00Z'), 0)`);
await lookAt(-20.08, 9.62, 10); await settle(); await b.shot('tiles-raking');
// The limb at full zoom, where stacked surfaces would shimmer if they did not coincide.
await lookAt(-95, 0, 10); await settle(); await b.shot('tiles-limb');

// The same view without tiles, for comparison.
await b.goto(URL0 + FULL + '&tiles=0', 7000);
await b.ev(`window.__moon.setMode('explore')`);
await lookAt(-11.36, -43.31, 10); await sleep(2500);
check('tiles can be switched off', (await stats()).available === false, await stats());
await b.shot('base-tycho');

check('no console errors', b.errors.length === 0, b.errors.slice(0, 5));
console.log(JSON.stringify(out, null, 1));
console.log(fail.length ? `FAILED: ${fail.join(', ')}` : 'all tile checks passed');
b.close();
process.exit(fail.length ? 1 : 0);
