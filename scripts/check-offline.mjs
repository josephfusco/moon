// Checks the production build offline. Needs `npm run build` then `npm run preview` (port 4173).
// Run: node scripts/check-offline.mjs [--full]   (--full also saves every detail tile, then checks a zoomed view offline)
import { openBrowser, sleep } from './browser.mjs';

const URL0 = process.env.URL ?? 'http://localhost:4173/';
const FULL = process.argv.includes('--full');
const b = await openBrowser();
const out = {}, fail = [];
const check = (name, ok, detail) => { out[name] = detail; if (!ok) fail.push(name); };
const cached = () => b.ev(`(async()=>{const k=await (await caches.open('moon')).keys();return k.length})()`);

await b.goto(URL0, 12000);
check('service worker controls the page', await b.ev('!!navigator.serviceWorker.controller'), await cached());

if (FULL) {
  await b.move(600, 300); await b.click('#btn-about'); await sleep(1500);
  const label = await b.ev(`document.getElementById('btn-keep').textContent`);
  await b.ev(`document.getElementById('btn-keep').click()`); // it sits below the fold of the dialog
  let status = '';
  for (let i = 0; i < 600; i++) { await sleep(1000); status = await b.ev(`document.getElementById('keep-status').textContent`); if (/kept|could not|enough/.test(status)) break; }
  check('every detail tile saved', /kept on this device/.test(status), { label, status, cached: await cached() });
  await b.ev(`document.getElementById('about').close()`);
}

await b.offline(true);
await b.goto(URL0 + '?t=2027-01-15T03:00Z', 9000);
check('loads offline', (await b.ev(`document.getElementById('phase').textContent`)).trim().length > 1, await b.ev(`document.getElementById('phase').textContent + ' | ' + document.getElementById('date').textContent`));
await b.shot('offline-earth');
if (FULL) {
  await b.ev(`window.__moon.setMode('explore'); (()=>{const S=window.__moon.S;S.lon=-20.08;S.lat=9.62;S.zoom=10})()`);
  let s; for (let i = 0; i < 30; i++) { await sleep(500); s = JSON.parse(await b.ev('JSON.stringify(window.__moon.scene.tileStats())')); if (!s.loading && s.shown) break; }
  check('zoomed detail offline', s.shown > 0 && s.failed === 0, s);
  await b.shot('offline-zoomed');
}
await b.ev(`window.__moon.setMode('artemis')`); await sleep(4000);
const art = await b.ev(`document.getElementById('card-img').naturalWidth + ' / thumbs ' + [...document.querySelectorAll('#film img')].filter(i=>i.naturalWidth>0).length + ' of ' + document.querySelectorAll('#film img').length`);
check('Artemis photos offline', !/^0 /.test(art) && /thumbs (\d+) of \1/.test(art), art);
check('no console errors', b.errors.length === 0, b.errors.slice(0, 5));
console.log(JSON.stringify(out, null, 1));
console.log(fail.length ? `FAILED: ${fail.join(', ')}` : 'all offline checks passed');
b.close();
process.exit(fail.length ? 1 : 0);
