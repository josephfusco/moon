import { createScene } from './scene.js';
import {
  moonState, phaseName, phaseIndex, searchPhase, moonAge, riseSet, nextApsis, localEffects, SYNODIC_DAYS, C_KM_S,
} from './ephemeris.js';
import { PHOTOS, FEATURES } from './data/artemis.js';
import orion from './data/orion.json';

const $ = (id) => document.getElementById(id);
const DAY = 86400000, DEG = Math.PI / 180;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- vectors ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const perp = (v, axis) => { const d = dot(v, axis); return norm([v[0] - axis[0] * d, v[1] - axis[1] * d, v[2] - axis[2] * d]); };
const fromLonLat = (lon, lat) => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];

// ---------- state: one clock drives everything ----------
const Q = new URLSearchParams(location.search); // ?t=2026-12-24T01:28Z opens on that instant
const startT = Date.parse(Q.get('t') ?? '');
const S = {
  t: Number.isFinite(startT) ? startT : Date.now(), live: !Number.isFinite(startT), playing: false, vel: 0, tween: null,
  mode: 'earth', orient: store.get('orient') === 'south' ? 'south' : 'north', where: store.get('where'),
  labels: false, mapLight: false, flat: 0, zoom: 1, lon: 0, lat: 0, earthT: null, roll: null,
};
const view = { dir: null, up: null, distKm: 0, fitKm: 0 };
// Until a location is shared, the sky and tide rows are worked out for Ithaca, New York. The Moon itself
// stays Earth-centred (so it still matches NASA's Dial-A-Moon) and nothing is saved.
const HOME = { lat: 42.44, lon: -76.5, name: 'Ithaca, New York' };

const canvas = $('moon');
const scene = createScene(canvas);

// ---------- Orion's trajectory (JPL Horizons) ----------
const T0 = orion.rows[0][0] * 1000, T1 = orion.rows[orion.rows.length - 1][0] * 1000;
const FLY0 = Date.parse('2026-04-06T02:00:00Z'), FLY1 = Date.parse('2026-04-07T04:00:00Z');
function orionAt(t) {
  const step = (orion.rows[1][0] - orion.rows[0][0]) * 1000;
  const f = Math.min(orion.rows.length - 1.001, Math.max(0, (t - T0) / step));
  const i = Math.floor(f), k = f - i, a = orion.rows[i], b = orion.rows[i + 1];
  const dir = norm(mix(fromLonLat(a[1], a[2]), fromLonLat(b[1], b[2]), k));
  return {
    dir, rangeKm: a[3] + (b[3] - a[3]) * k,
    lon: Math.atan2(dir[1], dir[0]) / DEG, lat: Math.asin(dir[2]) / DEG,
  };
}
const nearestPhoto = (t) => PHOTOS.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best));

// ---------- time ----------
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
function goTo(t, seconds = 1.6) {
  S.live = false; S.playing = false; S.vel = 0;
  if (!Number.isFinite(t)) return;
  if (reduceMotion || !(seconds > 0) || Math.abs(t - S.t) > 45 * DAY) { S.t = t; S.tween = null; } else S.tween = { from: S.t, to: t, start: performance.now(), dur: seconds * 1000 };
  syncButtons();
}
function nudge(ms) { goTo((S.tween ? S.tween.to : S.t) + ms, 0.5); }
function goLive() { goTo(Date.now(), 1.4); S.live = true; syncButtons(); }
function clampTime() { if (S.mode === 'artemis') S.t = Math.min(FLY1, Math.max(FLY0, S.t)); }

// ---------- phase strip ----------
const STRIP = ['New', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
function glyph(elong, flip) {
  const r = 11, e = elong % 360, waning = e > 180, a = (waning ? 360 - e : e) * DEG;
  const rx = Math.abs(Math.cos(a)) * r;
  const lit = e === 0 ? '' : e === 180 ? `M0 ${-r}A${r} ${r} 0 1 1 0 ${r}A${r} ${r} 0 1 1 0 ${-r}`
    : `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${rx} ${r} 0 0 ${a > Math.PI / 2 ? 1 : 0} 0 ${-r}`;
  const mirror = waning !== flip ? ' transform="scale(-1 1)"' : '';
  return `<svg viewBox="-13 -13 26 26" aria-hidden="true"><circle r="${r}" fill="#1a1a1a" stroke="rgba(255,255,255,.3)" stroke-width=".7"/><path d="${lit}" fill="#e8e8e6"${mirror}/></svg>`;
}
const strip = $('strip');
function buildStrip() {
  strip.querySelectorAll('button').forEach((b) => b.remove());
  STRIP.forEach((name, i) => {
    const b = document.createElement('button');
    b.innerHTML = glyph(i * 45, S.orient === 'south');
    b.title = name; b.setAttribute('aria-label', `Go to the next ${name.toLowerCase()} moon`);
    b.onclick = () => {
      const from = new Date((S.tween ? S.tween.to : S.t) + 5 * 60000);
      const hit = searchPhase(i * 45, from, 1);
      if (hit) goTo(hit.getTime(), 2.0);
    };
    strip.insertBefore(b, $('cursor'));
  });
}
buildStrip();

// ---------- controls ----------
function syncButtons() {
  $('btn-play').setAttribute('aria-pressed', S.playing);
  $('btn-play').textContent = S.playing ? 'Pause' : 'Play';
  document.body.classList.toggle('live', S.live && S.mode !== 'artemis');
  $('btn-orient').textContent = { north: 'North up', south: 'South up', sky: 'As in my sky' }[S.orient];
  $('btn-where').textContent = S.where ? `${Math.abs(S.where.lat).toFixed(1)}°${S.where.lat >= 0 ? 'N' : 'S'} ${Math.abs(S.where.lon).toFixed(1)}°${S.where.lon >= 0 ? 'E' : 'W'} ✕` : 'My location';
  $('btn-labels').setAttribute('aria-pressed', S.labels);
  $('btn-map').setAttribute('aria-pressed', S.mapLight);
}
$('btn-play').onclick = () => { S.playing = !S.playing; S.live = false; S.tween = null; S.vel = 0; syncButtons(); };
$('btn-now').onclick = goLive;
$('btn-prev').onclick = () => nudge(-DAY);
$('btn-next').onclick = () => nudge(DAY);
$('btn-map').onclick = () => { S.mapLight = !S.mapLight; syncButtons(); };
$('btn-labels').onclick = () => { S.labels = !S.labels; syncButtons(); };
$('btn-about').onclick = () => $('about').showModal();
$('about').addEventListener('click', (e) => { if (e.target === $('about')) $('about').close(); });
$('btn-orient').onclick = () => {
  const order = S.where ? ['north', 'south', 'sky'] : ['north', 'south'];
  S.orient = order[(order.indexOf(S.orient) + 1) % order.length];
  store.set('orient', S.orient); buildStrip(); syncButtons();
};
$('btn-where').onclick = () => {
  if (S.where) { S.where = null; store.set('where', null); if (S.orient === 'sky') S.orient = 'north'; almanacAt = NaN; syncButtons(); return; }
  if (!navigator.geolocation) return;
  $('btn-where').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition((p) => {
    // Rounded to about 1 km and kept only in this browser; nothing is sent anywhere.
    S.where = { lat: +p.coords.latitude.toFixed(2), lon: +p.coords.longitude.toFixed(2) };
    store.set('where', S.where); S.orient = 'sky'; almanacAt = NaN; buildStrip(); syncButtons();
  }, () => { syncButtons(); $('btn-where').textContent = 'Location unavailable'; }, { maximumAge: 3600000, timeout: 15000 });
};
// The date is edited in place: type it, Enter (or leaving the field) goes there, Escape cancels.
const pick = $('pick');
const editing = () => document.body.classList.contains('editing');
$('date').onclick = () => {
  if (S.mode === 'artemis') return; // the flyby has its own slider and a fixed window
  const d = new Date(S.t - new Date(S.t).getTimezoneOffset() * 60000);
  pick.value = pick.dataset.from = d.toISOString().slice(0, 16);
  document.body.classList.add('editing'); pick.focus();
};
function endEdit(commit) {
  if (!editing()) return;
  document.body.classList.remove('editing');
  const t = new Date(pick.value).getTime();
  if (commit && pick.value !== pick.dataset.from && Number.isFinite(t)) goTo(t, 1.6);
}
pick.addEventListener('keydown', (e) => {
  e.stopPropagation(); // arrows and space belong to the field while it is open
  if (e.key === 'Enter') { e.preventDefault(); endEdit(true); $('date').focus(); } else if (e.key === 'Escape') { endEdit(false); $('date').focus(); }
});
pick.addEventListener('blur', () => endEdit(true));

document.querySelectorAll('.modes button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
// A mouse click on a control must not park keyboard focus there, or Space would repeat that button
// instead of play/pause. Tab focus still works; the click still fires.
document.addEventListener('mousedown', (e) => { if (e.target.closest('button, #date') && !e.target.closest('dialog')) e.preventDefault(); });
function setMode(mode) {
  if (mode === S.mode) return;
  if (S.mode !== 'artemis') S.earthT = { t: S.t, live: S.live };
  if (mode === 'explore' && S.mode === 'earth') { const st = moonState(new Date(S.t)); S.lon = st.subObserver.lon; S.lat = st.subObserver.lat; }
  if (mode === 'explore' && S.mode === 'artemis') { const o = orionAt(S.t); S.lon = o.lon; S.lat = o.lat; }
  S.playing = false; S.tween = null; S.vel = 0; S.zoom = 1;
  if (mode === 'artemis') { S.live = false; S.t = PHOTOS[7].t; } else if (S.mode === 'artemis' && S.earthT) { S.t = S.earthT.t; S.live = S.earthT.live; }
  S.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode));
  $('hint').textContent = mode === 'explore' ? 'Drag to fly around · the night side is truly dark, Map light reveals it' : 'Drag the Moon to turn time';
  $('hint').classList.remove('gone');
  almanacAt = NaN; syncButtons();
}

// Dragging: in Earth view you hold the terminator and pull it across the disc; in Explore you orbit.
const pointers = new Map();
let pinch = 0, lastMove = 0;
canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.classList.add('dragging');
  S.vel = 0; S.tween = null;
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) setZoom(S.zoom * (d / pinch));
    pinch = d; return;
  }
  if (S.mode === 'explore') {
    const k = 0.25 / S.zoom;
    S.lon -= dx * k; S.lat = Math.max(-89, Math.min(89, S.lat + dy * k));
  } else scrub(dx);
  $('hint').classList.add('gone');
});
const release = (e) => {
  pointers.delete(e.pointerId); pinch = 0;
  if (!pointers.size) { canvas.classList.remove('dragging'); if (performance.now() - lastMove > 80) S.vel = 0; }
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
function scrub(dx) {
  const now = performance.now(), dt = Math.max(8, now - lastMove);
  lastMove = now;
  let ms;
  if (S.mode === 'artemis') ms = dx * 60000; // one pixel = one minute of the flyby
  else {
    // The terminator crosses the disc in half a lunation, so it roughly follows your finger.
    const southUp = S.roll !== null && Math.cos(S.roll) < 0;
    ms = (southUp ? 1 : -1) * dx * ((SYNODIC_DAYS / 2) * DAY) / (2 * scene.discRadius());
  }
  S.live = false; S.playing = false; S.t += ms; clampTime();
  S.vel = S.vel * 0.6 + (ms / dt) * 1000 * 0.4;
  syncButtons();
}
function setZoom(z) { S.zoom = Math.max(1, Math.min(S.mode === 'explore' ? 10 : 3, z)); }
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && S.mode !== 'explore') { scrub(-e.deltaX * 0.5); S.vel = 0; } else setZoom(S.zoom * Math.exp(-e.deltaY * 0.0025));
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, button') && e.key === ' ') return;
  if ($('about').open) return;
  const unit = S.mode === 'artemis' ? (e.shiftKey ? 60000 : 600000) : (e.shiftKey ? 3600000 : DAY);
  if (e.key === 'ArrowRight') nudge(unit);
  else if (e.key === 'ArrowLeft') nudge(-unit);
  else if (e.key === ' ' && S.mode !== 'artemis') { e.preventDefault(); $('btn-play').click(); }
  else if (e.key.toLowerCase() === 'n' && S.mode !== 'artemis') goLive();
});

// ---------- Artemis II panel ----------
const film = $('film');
PHOTOS.forEach((p) => {
  const b = document.createElement('button');
  b.title = p.title; b.dataset.id = p.id;
  b.innerHTML = `<img loading="lazy" src="${import.meta.env.BASE_URL}artemis/thumb/${p.id}.jpg" alt="${p.title}">`;
  b.onclick = () => goTo(p.t, 2.2);
  film.appendChild(b);
});
$('flyby-range').oninput = (e) => { S.tween = null; S.vel = 0; S.t = FLY0 + (e.target.value / 1000) * (FLY1 - FLY0); };
let shownPhoto = null;
function showPhoto(p, t) {
  if (shownPhoto !== p) {
    shownPhoto = p;
    $('card-img').src = `${import.meta.env.BASE_URL}artemis/${p.id}.jpg`;
    $('card-img').alt = p.title;
    $('card-link').href = `https://images.nasa.gov/details/${p.id}`;
    $('card-title').textContent = p.title;
    $('card-caption').textContent = `“${p.caption}”`;
    $('card-credit').textContent = `Photo: NASA · ${p.id} · caption excerpt from NASA`;
    film.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === p.id));
    film.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  const mins = Math.round((t - p.t) / 60000);
  const rel = mins === 0 ? 'taken at this moment' : `taken ${Math.abs(mins) >= 90 ? `${(Math.abs(mins) / 60).toFixed(1)} h` : `${Math.abs(mins)} min`} ${mins > 0 ? 'earlier' : 'from now'}`;
  text($('card-meta'), `${p.utc.slice(11, 19)} UTC · ${p.lens} · ${rel}`);
}

// ---------- readout ----------
const cache = new WeakMap();
function text(el, s) { if (cache.get(el) !== s) { cache.set(el, s); el.textContent = s; } }
const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtUTC = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const km = (v) => `${Math.round(v).toLocaleString()} km`;
const compass = (az) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(az / 22.5) % 16];
const ll = (lat, lon) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

let almanacAt = NaN, almanacWall = 0, slow = {};
function almanac(st) {
  const now = performance.now();
  if (!(Math.abs(S.t - almanacAt) < 600000) && now - almanacWall > 140) {
    almanacAt = S.t; almanacWall = now;
    const d = new Date(S.t);
    slow = { age: moonAge(d), full: searchPhase(180, d, 1), neu: searchPhase(0, d, 1), rs: riseSet(d, S.where ?? HOME), apsis: nextApsis(d) };
  }
  const rows = [
    ['Distance', km(st.distance), `${(st.distance / C_KM_S).toFixed(2)} s at light speed${slow.apsis ? ` · ${slow.apsis.kind} ${fmtShort.format(slow.apsis.date)}` : ''}`],
    ['Next full moon', slow.full ? fmtDay.format(slow.full) : '—', ''],
    ['Next new moon', slow.neu ? fmtDay.format(slow.neu) : '—', ''],
  ];
  const fx = localEffects(new Date(S.t), S.where ?? HOME);
  rows.push([S.where ? 'In your sky' : `In the sky over ${HOME.name}`, fx.altitude > 0 ? `${fx.altitude.toFixed(0)}° up, ${compass(fx.azimuth)}` : 'Below the horizon',
    slow.rs ? `rises ${slow.rs.rise ? fmtTime.format(slow.rs.rise) : '—'} · sets ${slow.rs.set ? fmtTime.format(slow.rs.set) : '—'}` : '']);
  // Sun and Moon in line (new or full) add up to spring tides; at right angles (the quarters) they partly cancel.
  const align = Math.abs(Math.cos(st.elongation * DEG));
  rows.push([S.where ? 'Tidal pull where you are' : `Tidal pull in ${HOME.name.split(',')[0]}`, `${Math.abs(fx.tide).toFixed(2)} µm/s² ${fx.tide >= 0 ? 'upward' : 'downward'}`,
    align > 0.9 ? 'Sun and Moon in line: spring tides' : align < 0.42 ? 'Sun and Moon at right angles: neap tides' : 'between spring and neap tides']);
  rows.push(['Libration', `${st.subObserver.lon >= 0 ? '+' : '−'}${Math.abs(st.subObserver.lon).toFixed(1)}° / ${st.subObserver.lat >= 0 ? '+' : '−'}${Math.abs(st.subObserver.lat).toFixed(1)}°`, 'longitude / latitude']);
  const el = $('almanac');
  while (el.children.length < rows.length) el.appendChild(Object.assign(document.createElement('div'), { innerHTML: '<span class="k"></span><span class="v"></span><span class="n"></span>' }));
  while (el.children.length > rows.length) el.lastChild.remove();
  rows.forEach((r, i) => { const c = el.children[i].children; text(c[0], r[0]); text(c[1], r[1]); text(c[2], r[2]); });
  return slow;
}

// ---------- labels ----------
const labelEls = new Map();
function drawLabels(names) {
  const want = new Set(names);
  for (const [name, el] of labelEls) if (!want.has(name)) { el.remove(); labelEls.delete(name); }
  for (const name of names) {
    const [lat, lon] = FEATURES[name];
    const p = scene.project(fromLonLat(lon, lat));
    let el = labelEls.get(name);
    if (!el) { el = document.createElement('span'); el.textContent = name; $('labels').appendChild(el); labelEls.set(name, el); }
    el.style.opacity = p.visible ? 1 : 0;
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - 7).toFixed(1)}px)`;
  }
}

// ---------- layout: the disc sits in whatever space the interface leaves free ----------
function discFrame() {
  const W = innerWidth, H = innerHeight, narrow = W <= 860;
  const top = document.querySelector('header').getBoundingClientRect().bottom + 8;
  let bottom = $('readout').getBoundingClientRect().top - 14, left = 0, right = W;
  if (narrow && S.mode === 'earth') bottom = Math.min(bottom, $('almanac').getBoundingClientRect().top - 12);
  if (S.mode === 'artemis') {
    const c = $('card').getBoundingClientRect();
    if (narrow) bottom = Math.min(bottom, c.top - 12); else right = c.left - 16;
  } else if (!narrow && S.mode === 'earth') left = Math.min(W * 0.2, $('almanac').getBoundingClientRect().right);
  const cx = S.mode === 'artemis' && !narrow ? (left + right) / 2 : W / 2;
  const halfW = Math.min(cx - left, right - cx);
  return { cx, cy: (top + bottom) / 2, r: Math.max(60, Math.min((bottom - top) / 2, halfW - 12) * 0.94) };
}

// ---------- frame ----------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame); // re-arm first: one bad frame must never freeze the page
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (S.tween) {
    const x = Math.min(1, Math.max(0, (now - S.tween.start) / S.tween.dur));
    S.t = S.tween.from + (S.tween.to - S.tween.from) * ease(x);
    if (x >= 1) S.tween = null;
  } else if (S.playing) S.t += dt * 1.5 * DAY; // a day and a half per second
  else if (!pointers.size && Math.abs(S.vel) > 1000) { S.t += S.vel * dt; S.vel *= Math.exp(-dt / 0.55); }
  else if (S.live && S.mode !== 'artemis') S.t = Date.now();
  clampTime();

  const date = new Date(S.t);
  // st: what you see from where you stand. While time is being turned quickly, the daily swing of a
  // real location (the disc rotating in the sky, parallax) would make the Moon tumble, so the view
  // uses the Earth-centre geometry and holds its tilt, then settles to the true local view at rest.
  const st = moonState(date, S.mode === 'earth' ? S.where : null);
  const moving = !!(S.tween || S.playing || pointers.size || Math.abs(S.vel) > 1000);
  const sv = S.mode === 'earth' && S.where && moving ? moonState(date, null) : st;
  const earthDir = norm(sv.obsB);

  // Where the camera wants to be.
  let dir, up, distKm, fitKm;
  if (S.mode === 'earth') {
    dir = earthDir; distKm = sv.distance; fitKm = 384400; // fixed frame: perigee looks bigger, apogee smaller
    const n = perp(st.northB, dir), e = cross(dir, n);
    let target = S.orient === 'south' ? Math.PI : 0;
    if (S.orient === 'sky' && st.zenithB) { const z = perp(st.zenithB, dir); target = Math.atan2(dot(z, e), dot(z, n)); }
    if (S.roll === null) S.roll = target;
    if (S.orient === 'sky' && moving) target = S.roll;
    const diff = Math.atan2(Math.sin(target - S.roll), Math.cos(target - S.roll));
    S.roll += diff * (1 - Math.exp(-dt / 0.35));
    up = [0, 1, 2].map((i) => n[i] * Math.cos(S.roll) + e[i] * Math.sin(S.roll));
  } else if (S.mode === 'explore') {
    dir = fromLonLat(S.lon, S.lat); up = [0, 0, 1]; distKm = fitKm = 60000;
  } else {
    const o = orionAt(S.t);
    dir = o.dir; up = [0, 0, 1]; distKm = fitKm = o.rangeKm;
  }
  const k = view.dir ? 1 - Math.exp(-dt / 0.22) : 1;
  view.dir = norm(mix(view.dir ?? dir, dir, k));
  view.up = norm(mix(view.up ?? up, up, k));
  view.distKm = Math.exp(Math.log(view.distKm || distKm) * (1 - k) + Math.log(distKm) * k);
  view.fitKm = Math.exp(Math.log(view.fitKm || fitKm) * (1 - k) + Math.log(fitKm) * k);
  view.zoom = (view.zoom ?? 1) + (S.zoom - (view.zoom ?? 1)) * (1 - Math.exp(-dt / 0.12));
  const f = discFrame();
  view.frame = view.frame ? { cx: view.frame.cx + (f.cx - view.frame.cx) * k, cy: view.frame.cy + (f.cy - view.frame.cy) * k, r: view.frame.r + (f.r - view.frame.r) * k } : f;

  // Auto exposure, as a camera would: open up as the lit part thins towards a crescent.
  const camPhase = Math.acos(Math.max(-1, Math.min(1, dot(view.dir, norm(st.sunB))))) / DEG;
  const x = Math.max(0, Math.min(1, (camPhase - 60) / 100));
  const exposure = 1.3 * (1 + 4 * x * x * (3 - 2 * x));
  // Earthshine is boosted to be visible, strongest when the Earth is nearly full in the lunar sky.
  const earthshine = (0.04 * st.earthLit * st.earthLit * 1.3) / exposure;
  S.flat += ((S.mode === 'explore' && S.mapLight ? 1 : 0) - S.flat) * (1 - Math.exp(-dt / 0.25));
  scene.render(view, { sun: st.sunB, earthKm: st.earthB, earthshine, exposure, flat: S.flat });

  if (S.mode === 'artemis') {
    const o = orionAt(S.t), p = nearestPhoto(S.t);
    text($('phase'), 'Aboard Orion, Artemis II flyby');
    text($('sub'), `${km(o.rangeKm - 1737.4)} above the surface · over ${ll(o.lat, o.lon)}${Math.abs(o.lon) > 90 ? ' · far side' : ''}`);
    text($('date'), `${fmtUTC.format(date)} UTC`);
    showPhoto(p, S.t);
    if (document.activeElement !== $('flyby-range') || S.tween) $('flyby-range').value = ((S.t - FLY0) / (FLY1 - FLY0)) * 1000;
    drawLabels(S.labels ? Object.keys(FEATURES) : p.features);
  } else {
    const a = almanac(st);
    text($('phase'), phaseName(st.elongation));
    text($('sub'), `${(st.illuminated * 100).toFixed(1)}% illuminated · day ${Number.isFinite(a.age) ? a.age.toFixed(1) : '—'} of ${SYNODIC_DAYS.toFixed(1)}`);
    text($('date'), fmtDate.format(date));
    drawLabels(S.labels ? Object.keys(FEATURES) : []);
    const on = phaseIndex(st.elongation);
    strip.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === on));
    $('cursor').style.transform = `translateX(${(((st.elongation + 22.5) % 360) / 360) * strip.clientWidth}px)`;
  }
}
syncButtons();
scene.ready.then(() => requestAnimationFrame(frame));
window.__moon = { S, goTo, setMode }; // handy in the console
