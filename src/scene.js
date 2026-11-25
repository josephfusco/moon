// The Moon mesh lives at the origin in its own body-fixed frame (z = north pole, x = 0°E 0°N).
// The camera and the Sun are placed around it from the ephemeris. Units: 1 = 1737.4 km.
import * as THREE from 'three';
import { MOON_RADIUS_KM } from './ephemeris.js';
import { cols, rows, tileKey, tileTransform, tileBounds, pickLevel, mortonIndex } from './tiles.js';

// The globe is a 768 x 384 grid so that it divides evenly into detail tiles: 24 x 24 squares per tile at
// the finest level (5). Its triangles are stored tile by tile in quadtree order (see mortonIndex), so
// any tile at any level is one run of them and can be redrawn with sharper images over the base map.
const SEG_X = 768, SEG_Y = 384, FINEST = 5;
const TILE_SEG = SEG_X / cols(FINEST), TILE_INDICES = TILE_SEG * TILE_SEG * 6;
const TILES = `${import.meta.env.BASE_URL}tiles/`;
const TEX = `${import.meta.env.BASE_URL}textures/`;

const vertexShader = /* glsl */ `
  varying vec3 vDir; varying vec3 vPos; varying vec2 vUv;
  void main() {
    vDir = normal; vPos = position; vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D uColor; uniform sampler2D uNormal;
  uniform vec4 uTileC; uniform vec4 uTileN; // xy offset, zw scale: where this piece of the globe sits in its images
  uniform float uHasNormal; uniform float uEarthshine; uniform float uExposure; uniform float uFlat;
  uniform vec3 uSun;      // unit vector, Moon -> Sun, body frame
  uniform vec3 uEarthKm;  // Moon -> Earth center, body frame, km
  varying vec3 vDir; varying vec3 vPos; varying vec2 vUv;
  const float R = 1737.4; const float RE = 6378.137; const float RS = 695700.0; const float AU = 149597870.7;

  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

  // Lunar-Lambert photometric function (McEwen; coefficients as in USGS ISIS LunarLambertMcEwen): a phase-dependent blend of
  // Lommel-Seeliger and Lambert. At full moon it is flat to the limb, as the real Moon is.
  float lunarLambert(float mu0, float mu, float g) {
    float L = clamp(1.0 - 0.019 * g + 2.42e-4 * g * g - 1.46e-6 * g * g * g, 0.0, 1.0);
    return L * 2.0 * mu0 / (mu0 + mu + 1e-5) + (1.0 - L) * mu0;
  }

  void main() {
    vec3 up = normalize(vDir);
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up) + vec3(1e-6, 0.0, 0.0));
    vec3 north = cross(up, east);
    // Slopes baked from LOLA elevation at true scale, stored as sign(s) * sqrt(|s|).
    vec2 e = texture2D(uNormal, vUv * uTileN.zw + uTileN.xy).rg * 2.0 - 1.0;
    vec2 s = e * abs(e) * uHasNormal;
    vec3 n = normalize(up - s.x * east - s.y * north);

    vec3 P = vPos * R;
    vec3 V = normalize(cameraPosition - vPos);
    float mu = max(dot(n, V), 0.02);
    vec3 albedo = texture2D(uColor, vUv * uTileC.zw + uTileC.xy).rgb;

    // Sunlight. The Sun is a 0.53-degree disc, so the terminator is a narrow penumbra, not an edge.
    float sunUp = smoothstep(-0.00465, 0.00465, dot(up, uSun));
    float mu0 = max(dot(n, uSun), 0.0) * sunUp;
    float g = degrees(acos(clamp(dot(uSun, V), -1.0, 1.0)));

    // Earth's shadow (lunar eclipses): umbra and penumbra cones behind the Earth.
    vec3 r = P - uEarthKm;
    float d = dot(r, -uSun);
    float rho = length(r + d * uSun);
    float umbra = 1.02 * RE - d * (RS - RE) / AU;
    float penumbra = 1.02 * RE + d * (RS + RE) / AU;
    float lit = d > 0.0 ? smoothstep(umbra, penumbra, rho) : 1.0;
    vec3 sunlight = mix(vec3(0.020, 0.0045, 0.0012), vec3(1.0), lit * lit);

    vec3 c = albedo * lunarLambert(mu0, mu, g) * sunlight;

    // Earthshine: sunlight reflected off the Earth onto the Moon's night side.
    vec3 E = normalize(uEarthKm - P);
    float muE = max(dot(n, E), 0.0);
    float gE = degrees(acos(clamp(dot(E, V), -1.0, 1.0)));
    c += albedo * lunarLambert(muE, mu, gE) * uEarthshine * vec3(0.78, 0.88, 1.0);

    c *= uExposure;
    c = mix(c, albedo * 0.78, uFlat); // optional even "map light", no Sun
    gl_FragColor = vec4(toSRGB(clamp(c, 0.0, 1.0)), 1.0);
  }`;

function buildGeometry() {
  const n = (SEG_X + 1) * (SEG_Y + 1);
  const pos = new Float32Array(n * 3), dir = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let j = 0, k = 0; j <= SEG_Y; j++) {
    const lat = Math.PI / 2 - (Math.PI * j) / SEG_Y;
    for (let i = 0; i <= SEG_X; i++, k++) {
      const lon = -Math.PI + (2 * Math.PI * i) / SEG_X;
      const x = Math.cos(lat) * Math.cos(lon), y = Math.cos(lat) * Math.sin(lon), z = Math.sin(lat);
      dir.set([x, y, z], k * 3); pos.set([x, y, z], k * 3);
      uv.set([i / SEG_X, 1 - j / SEG_Y], k * 2);
    }
  }
  const idx = new Uint32Array(SEG_X * SEG_Y * 6);
  for (let ty = 0; ty < rows(FINEST); ty++) for (let tx = 0; tx < cols(FINEST); tx++) {
    let t = mortonIndex(FINEST, tx, ty) * TILE_INDICES;
    for (let j = ty * TILE_SEG; j < (ty + 1) * TILE_SEG; j++) for (let i = tx * TILE_SEG; i < (tx + 1) * TILE_SEG; i++) {
      const a = j * (SEG_X + 1) + i, b = a + SEG_X + 1;
      idx.set([a, b, a + 1, a + 1, b, b + 1], t); t += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(dir, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.01);
  return geo;
}

/** Push every vertex out to its real LOLA elevation (true scale: at most about 0.6% of the radius). */
async function displace(geo) {
  const img = new Image();
  img.src = `${TEX}height_1k.png`;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const W = cv.width, H = cv.height;
  const meters = (x, y) => {
    const i = (Math.min(H - 1, Math.max(0, y)) * W + ((x % W) + W) % W) * 4;
    return ((px[i] << 8 | px[i + 1]) - 20000) * 0.5;
  };
  const pos = geo.attributes.position, dir = geo.attributes.normal, uv = geo.attributes.uv;
  for (let k = 0; k < pos.count; k++) {
    const fx = uv.getX(k) * W - 0.5, fy = (1 - uv.getY(k)) * H - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const h = (meters(x0, y0) * (1 - ax) + meters(x0 + 1, y0) * ax) * (1 - ay)
      + (meters(x0, y0 + 1) * (1 - ax) + meters(x0 + 1, y0 + 1) * ax) * ay;
    const s = 1 + h / (MOON_RADIUS_KM * 1000);
    pos.setXYZ(k, dir.getX(k) * s, dir.getY(k) * s, dir.getZ(k) * s);
  }
  pos.needsUpdate = true;
}

export function createScene(canvas, onProgress = () => {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(1, 1, 0.1, 1000);

  const blank = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  blank.needsUpdate = true;
  const uniforms = {
    uColor: { value: null }, uNormal: { value: blank }, uHasNormal: { value: 0 },
    uSun: { value: new THREE.Vector3(1, 0, 0) }, uEarthKm: { value: new THREE.Vector3(384400, 0, 0) },
    uEarthshine: { value: 0 }, uExposure: { value: 1.3 }, uFlat: { value: 0 },
    uTileC: { value: new THREE.Vector4(0, 0, 1, 1) }, uTileN: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
  const geo = buildGeometry();
  const moon = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader }));
  moon.visible = false;
  scene.add(moon);

  // ---- detail tiles: sharper color and relief for the part of the Moon on screen, when zoomed in ----
  // The base globe is always drawn. Tiles are the same triangles drawn again on top with finer images,
  // through the same shader, so light, eclipses and Map light behave identically on them.
  const detail = new THREE.Mesh(geo, []);
  detail.renderOrder = 1; detail.frustumCulled = false; detail.visible = false;
  scene.add(detail);
  const bitmaps = new THREE.ImageBitmapLoader().setOptions({ premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const tiles = new Map(); // key -> { level, x, y, state, material, used, shown }
  const sampleCache = new Map();
  const queue = [];
  let manifest = null, baseTexelKm = Infinity, lastPick = 0, loading = 0, levelNow = null;
  // Each tile holds about 7 MB of graphics memory, so phones and small-memory devices keep far fewer.
  const lowMemory = (navigator.deviceMemory && navigator.deviceMemory <= 4) || Math.min(screen.width, screen.height) < 500;
  const SHOWN_MAX = lowMemory ? 12 : 32, KEPT_MAX = lowMemory ? 16 : 48, PARALLEL = 4;
  // ?tiles=0 shows the base map alone, for comparing against the detail tiles.
  (new URLSearchParams(location.search).get('tiles') === '0' ? Promise.reject() : fetch(`${TILES}manifest.json`))
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
    .then((m) => { if (m?.levels?.length && (m.color?.px || m.normal?.px)) manifest = m; })
    .catch(() => { /* no tiles here: the base map is the whole story */ });

  /** A 5 x 5 spread of points across a tile, as unit vectors, for testing whether it is in view. */
  function samples(level, x, y) {
    const key = tileKey(level, x, y);
    let s = sampleCache.get(key);
    if (!s) {
      const b = tileBounds(level, x, y), D = Math.PI / 180;
      s = new Float32Array(75);
      for (let j = 0, k = 0; j < 5; j++) for (let i = 0; i < 5; i++, k += 3) {
        const lon = (b.west + (b.east - b.west) * i / 4) * D, lat = (b.north + (b.south - b.north) * j / 4) * D;
        s[k] = Math.cos(lat) * Math.cos(lon); s[k + 1] = Math.cos(lat) * Math.sin(lon); s[k + 2] = Math.sin(lat);
      }
      sampleCache.set(key, s);
    }
    return s;
  }
  const probe = new THREE.Vector3(), viewDir = new THREE.Vector3(), lastDir = new THREE.Vector3();
  let lastLevel = null;
  /** null if the tile is off screen or on the far side; otherwise how far it is from the screen center. */
  function onScreen(level, x, y) {
    const s = samples(level, x, y);
    let minX = 2, maxX = -2, minY = 2, maxY = -2, near = Infinity;
    for (let k = 0; k < 75; k += 3) {
      probe.set(s[k], s[k + 1], s[k + 2]);
      if (probe.dot(camera.position) <= 1.0) continue; // beyond the limb
      probe.project(camera);
      minX = Math.min(minX, probe.x); maxX = Math.max(maxX, probe.x); minY = Math.min(minY, probe.y); maxY = Math.max(maxY, probe.y);
      near = Math.min(near, probe.x * probe.x + probe.y * probe.y);
    }
    return near === Infinity || minX > 1 || maxX < -1 || minY > 1 || maxY < -1 ? null : near;
  }
  function tileTexture(bitmap, srgb) {
    const t = new THREE.Texture(bitmap);
    t.flipY = false; // the bitmap is uploaded as it is; tileTransform(..., false) accounts for that
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    return t;
  }
  function loadTile({ level, x, y }) {
    const key = tileKey(level, x, y), m = manifest;
    const tile = { level, x, y, state: 'loading', material: null, used: performance.now(), shown: false };
    tiles.set(key, tile); loading++;
    const url = (kind, ext) => `${TILES}${m.version}/${kind}/${level}/${x}_${y}.${ext}`;
    // A layer that has not been baked falls back to the base map for that tile.
    Promise.all([m.color ? bitmaps.loadAsync(url('c', m.color.ext)) : null, m.normal ? bitmaps.loadAsync(url('n', m.normal.ext)) : null]).then(([c, n]) => {
      tile.material = new THREE.ShaderMaterial({
        vertexShader, fragmentShader,
        uniforms: {
          ...uniforms, // the same light, exposure and Earth as the base: shared, not copied
          ...(c ? { uColor: { value: tileTexture(c, true) }, uTileC: { value: new THREE.Vector4(...tileTransform(level, x, y, m.color.px, m.gutter, false)) } } : {}),
          ...(n ? { uNormal: { value: tileTexture(n, false) }, uHasNormal: { value: 1 }, uTileN: { value: new THREE.Vector4(...tileTransform(level, x, y, m.normal.px, m.gutter, false)) } } : {}),
        },
        // Exactly the base's triangles, so depths are equal; the offset makes the finer level win.
        depthFunc: THREE.LessEqualDepth, polygonOffset: true, polygonOffsetFactor: -level, polygonOffsetUnits: -level,
      });
      tile.own = [c && 'uColor', n && 'uNormal'].filter(Boolean);
      tile.state = 'ready'; lastPick = 0;
    }, () => { tile.state = 'failed'; }).finally(() => { loading--; pump(); });
  }
  function pump() { while (loading < PARALLEL && queue.length) loadTile(queue.shift()); }
  function dropTile(key, tile) {
    for (const u of tile.own) { const t = tile.material.uniforms[u].value; t.image?.close?.(); t.dispose(); }
    tile.material.dispose(); tiles.delete(key);
  }
  function updateTiles() {
    if (!manifest || !moon.visible) return;
    const now = performance.now();
    if (now - lastPick < 120) return;
    lastPick = now;
    const kmPerPx = MOON_RADIUS_KM / (discRadius() * renderer.getPixelRatio());
    const level = levelNow = pickLevel(kmPerPx, baseTexelKm, manifest.levels, (manifest.color ?? manifest.normal).px);
    // Show every loaded tile that is in view and not finer than needed, coarse first so finer ones sit on top.
    const show = [];
    for (const t of tiles.values()) {
      t.shown = t.state === 'ready' && level !== null && t.level <= level && onScreen(t.level, t.x, t.y) !== null;
      if (t.shown) { t.used = now; show.push(t); }
    }
    show.sort((a, b) => a.level - b.level);
    geo.clearGroups();
    show.forEach((t, i) => geo.addGroup(mortonIndex(t.level, t.x, t.y) * TILE_INDICES * 4 ** (FINEST - t.level), TILE_INDICES * 4 ** (FINEST - t.level), i));
    detail.material = show.map((t) => t.material);
    detail.visible = show.length > 0;
    // Ask for what is missing at the needed level, nearest the middle of the screen first, but only once
    // the view has settled: while it is still flying or zooming, tiles along the way would never be seen.
    queue.length = 0;
    viewDir.copy(camera.position).normalize();
    const span = (kmPerPx * renderer.domElement.width) / MOON_RADIUS_KM; // roughly the angle across the screen
    const settled = viewDir.angleTo(lastDir) < span * 0.004 && level === lastLevel; // under about half a percent of the screen per check
    lastDir.copy(viewDir); lastLevel = level;
    if (level !== null && settled) {
      const want = [];
      for (let y = 0; y < rows(level); y++) for (let x = 0; x < cols(level); x++) {
        const d = onScreen(level, x, y);
        if (d !== null) want.push({ level, x, y, d });
      }
      want.sort((a, b) => a.d - b.d);
      for (const w of want.slice(0, SHOWN_MAX)) if (!tiles.has(tileKey(w.level, w.x, w.y))) queue.push(w);
      pump();
    }
    // Keep memory bounded: forget the tiles that have gone longest without being seen.
    if (tiles.size > KEPT_MAX) {
      const idle = [...tiles].filter(([, t]) => t.state === 'ready' && !t.shown).sort((a, b) => a[1].used - b[1].used);
      for (const [key, t] of idle.slice(0, tiles.size - KEPT_MAX)) dropTile(key, t);
    }
  }
  const tileStats = () => {
    const all = [...tiles.values()];
    return { available: !!manifest, level: levelNow, shown: all.filter((t) => t.shown).length, ready: all.filter((t) => t.state === 'ready').length, loading, failed: all.filter((t) => t.state === 'failed').length, kept: tiles.size };
  };

  // Progressive textures: a small color map first, then the largest the device can hold.
  const loader = new THREE.TextureLoader();
  const maxTex = renderer.capabilities.maxTextureSize;
  const modest = (navigator.deviceMemory && navigator.deviceMemory <= 4) || Math.min(screen.width, screen.height) < 500;
  const load = (file, srgb) => loader.loadAsync(TEX + file).then((t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  });
  const swap = (key, tex) => { uniforms[key].value?.dispose?.(); uniforms[key].value = tex; };
  const ready = load('color_2k.webp', true).then((t) => {
    swap('uColor', t); moon.visible = true; onProgress('preview');
    const big = maxTex >= 8192 && !modest;
    baseTexelKm = (2 * Math.PI * MOON_RADIUS_KM) / (big ? 8192 : 4096);
    Promise.all([
      load(big ? 'color_8k.webp' : 'color_4k.webp', true).then((c) => swap('uColor', c)),
      load(big ? 'normal_6k.jpg' : 'normal_4k.jpg', false).then((nm) => { swap('uNormal', nm); uniforms.uHasNormal.value = 1; }),
      displace(geo),
    ]).then(() => onProgress('full'), (err) => { console.error(err); onProgress('partial'); });
  });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', resize);
  resize();

  const tmp = new THREE.Vector3();
  /**
   * @param view {dir:[x,y,z] unit Moon->camera, distKm, up:[x,y,z], fitKm, zoom, frame:{cx,cy,r}}
   *   fitKm: the distance at which the Moon would exactly fill the frame; when distKm differs
   *   (perigee vs apogee) the Moon is drawn truly larger or smaller.
   */
  function render(view, light) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const d = view.distKm / MOON_RADIUS_KM;
    camera.position.set(view.dir[0] * d, view.dir[1] * d, view.dir[2] * d);
    camera.up.set(view.up[0], view.up[1], view.up[2]);
    camera.lookAt(0, 0, 0);
    // view.frame = where the Moon's disc should sit on screen (CSS px) when it is fitKm away.
    const aspect = w / h;
    const tanV = Math.tan(Math.asin(Math.min(0.999, MOON_RADIUS_KM / view.fitKm))) * (h / 2) / (view.frame.r * view.zoom);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanV));
    camera.aspect = aspect;
    camera.near = Math.max(0.05, d - 1.5); camera.far = d + 1.5;
    camera.setViewOffset(w, h, w / 2 - view.frame.cx, h / 2 - view.frame.cy, w, h);
    camera.updateProjectionMatrix();
    uniforms.uSun.value.set(...light.sun).normalize();
    uniforms.uEarthKm.value.set(...light.earthKm);
    uniforms.uEarthshine.value = light.earthshine;
    uniforms.uExposure.value = light.exposure;
    uniforms.uFlat.value = light.flat;
    updateTiles();
    renderer.render(scene, camera);
  }

  /** Project a body-frame unit vector to CSS pixels; visible = on the hemisphere facing the camera. */
  function project(p) {
    tmp.set(p[0], p[1], p[2]);
    const visible = tmp.dot(camera.position) > 1.0;
    tmp.project(camera);
    return { x: (tmp.x * 0.5 + 0.5) * canvas.clientWidth, y: (-tmp.y * 0.5 + 0.5) * canvas.clientHeight, visible };
  }
  /** Apparent radius of the Moon's disc in CSS pixels. */
  function discRadius() {
    const d = camera.position.length();
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return (Math.tan(Math.asin(1 / d)) / half) * (canvas.clientHeight / 2);
  }
  return { render, project, discRadius, ready, resize, tileStats, tileManifest: () => manifest };
}
