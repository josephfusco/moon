// Checks the date calendar in a real browser: layout at several screen sizes, mouse and keyboard use.
// Run: node scripts/check-picker.mjs   (URL=... to point somewhere other than the dev server)
import { openBrowser, sleep } from './browser.mjs';

const URL_ = process.env.URL ?? 'http://localhost:5173/';
const b = await openBrowser();
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const js = (s) => b.ev(s);
const key = (k, vk, text) => b.key(k, k, vk, text);
const type = async (s) => { for (const c of s) await b.send('Input.insertText', { text: c }); };

await b.goto(`${URL_}?tiles=0`);
await js(`localStorage.setItem('moon:hinted', JSON.stringify({ earth: true, explore: true })); window.__moon.goTo(new Date(2026, 10, 23, 5, 27).getTime(), 0)`);

const SIZES = [['desktop', 1288, 672, false], ['phone', 390, 844, true], ['small', 320, 568, true], ['landscape', 667, 375, true], ['tablet', 820, 1180, true]];
for (const [name, w, h, mobile] of SIZES) {
  await b.size(w, h, mobile, 2); await b.send('Emulation.setTouchEmulationEnabled', { enabled: mobile }); await sleep(400);
  const coarse = await js(`matchMedia('(pointer: coarse)').matches`);
  await js(`document.getElementById('date').click()`); await sleep(300);
  const r = JSON.parse(await js(`(() => { const p = document.getElementById('picker'), r = p.getBoundingClientRect(), c = [...p.querySelectorAll('#pk-grid button')].map((x) => x.getBoundingClientRect());
    return JSON.stringify({ hidden: p.hidden, l: r.left, t: r.top, r: r.right, b: r.bottom, scroll: p.scrollHeight - p.clientHeight, cw: Math.min(...c.map((x) => x.width)), ch: Math.min(...c.map((x) => x.height)), sw: document.documentElement.scrollWidth }); })()`));
  ok(!r.hidden && r.l >= 0 && r.t >= 0 && r.r <= w && r.b <= h && r.sw <= w, `${name} ${w}x${h}: calendar on screen (${Math.round(r.r - r.l)}x${Math.round(r.b - r.t)}, cells ${Math.round(r.cw)}x${Math.round(r.ch)}, hidden overflow ${r.scroll}px${coarse ? ', touch' : ''})`);
  if (coarse && h > 520) ok(r.ch >= 44, `${name}: day targets are at least 44px tall for fingers`);
  await b.shot(`picker-${name}`);
  await js(`document.getElementById('pk-done').click()`);
}

await b.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await b.size(1288, 672, false, 1); await sleep(300);
const when = () => js(`new Date(window.__moon.S.tween ? window.__moon.S.tween.to : window.__moon.S.t).toString().slice(0, 21)`);
const open = () => js(`!document.getElementById('picker').hidden`);

await b.click('#date'); await sleep(200);
ok(await open(), 'mouse click opens it');
ok(await js(`document.querySelector('#pk-grid .sel span').textContent`) === '23', 'the day shown is marked');
ok(await js(`document.getElementById('pk-time').value`) === '5:27 AM', 'the time shown matches');
// The glyph for the marked day should be the phase in the title.
ok((await js(`document.querySelector('#pk-grid .sel').getAttribute('aria-label')`)).includes((await js(`document.getElementById('phase').textContent`)).toLowerCase()), 'marked day names the same phase as the title');
await js(`[...document.querySelectorAll('#pk-grid button')].find((x) => x.day.getDate() === 9 && x.day.getMonth() === 10).click()`);
ok(await when() === 'Mon Nov 09 2026 05:27', `clicking a day goes there, same time of day (${await when()})`);
ok(await open(), 'and the calendar stays open');

// Time
await b.click('#pk-time'); await js(`document.getElementById('pk-time').select()`); await type('9:30 pm'); await key('Enter', 13, '\r');
ok(await when() === 'Mon Nov 09 2026 21:30', `typed time applies (${await when()})`);
await b.click('#pk-time'); await js(`document.getElementById('pk-time').select()`); await type('banana'); await key('Enter', 13, '\r');
ok(await js(`document.getElementById('pk-time').value`) === '9:30 PM' && await when() === 'Mon Nov 09 2026 21:30', 'a time that makes no sense is put back');

// Far year
await b.click('#pk-year'); await js(`document.getElementById('pk-year').select()`); await type('1969'); await sleep(100);
ok(await js(`document.getElementById('pk-month').textContent + document.querySelectorAll('#pk-grid button:not(.out)').length`) === 'November30' && await open(), 'typing a year shows that year and keeps it open');
for (let i = 0; i < 4; i++) await b.click('#pk-prev');
await js(`[...document.querySelectorAll('#pk-grid button')].find((x) => x.day.getDate() === 20 && x.day.getMonth() === 6).click()`);
ok(await when() === 'Sun Jul 20 1969 21:30', `20 July 1969 (${await when()})`);
await b.shot('picker-1969');

// Keyboard
await key('Escape', 27); await sleep(100);
ok(!(await open()), 'Escape closes');
await js(`document.getElementById('date').focus()`); await key('Enter', 13, '\r'); await sleep(200);
ok(await open() && await js(`document.activeElement.day?.getDate()`) === 20, 'Enter on the date opens with focus on the marked day');
await key('ArrowRight', 39); await key('ArrowDown', 40);
ok(await js(`document.activeElement.day.getDate()`) === 28 && await when() === 'Sun Jul 20 1969 21:30', 'arrows move between days without changing the Moon');
await key('ArrowDown', 40);
ok(await js(`document.getElementById('pk-month').textContent`) === 'August' && await js(`document.activeElement.day.getDate()`) === 4, 'arrowing past the month turns the page');
await key('Enter', 13, '\r'); await sleep(100);
ok(await when() === 'Mon Aug 04 1969 21:30', `Enter goes to the focused day (${await when()})`);
await key(' ', 32, ' ');
ok(await js(`window.__moon.S.playing`) === false, 'Space does not start playback behind the calendar');
await key('Escape', 27); await sleep(100);
ok(!(await open()) && await js(`document.activeElement.id`) === 'date', 'Escape hands focus back to the date');

// Outside click, Now, South up
await js(`document.activeElement.blur()`); await b.click('#date'); await sleep(150);
await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 300, button: 'left', clickCount: 1 }); await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300, y: 300, button: 'left', clickCount: 1 });
await sleep(100);
ok(!(await open()) && await js(`document.activeElement === document.body`), 'a click elsewhere closes it and leaves nothing focused');
await b.click('#date'); await sleep(150); await b.click('#date'); await sleep(150);
ok(!(await open()), 'clicking the date again closes it');
await b.click('#date'); await sleep(150); await b.click('#pk-now'); await sleep(200);
ok(!(await open()) && await js(`window.__moon.S.live`), 'Now returns to the present and closes');
await b.click('#date'); await sleep(150);
const north = await js(`document.querySelector('#pk-grid .sel svg').outerHTML`);
await js(`document.getElementById('pk-done').click(); document.getElementById('btn-orient').click(); document.getElementById('date').click()`); await sleep(150);
ok(north !== await js(`document.querySelector('#pk-grid .sel svg').outerHTML`), 'South up mirrors the phases');
await js(`document.getElementById('btn-orient').click(); window.__moon.setMode('artemis')`); await sleep(200);
ok(!(await open()), 'changing view closes it');

ok(b.errors.length === 0, `no console errors ${b.errors.join(' | ')}`);
b.close();
console.log(failed ? `${failed} check(s) failed` : 'all picker checks passed');
process.exit(failed ? 1 : 0);
