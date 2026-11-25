// Bake the detail tiles from the full-resolution NASA SVS "CGI Moon Kit" files (https://svs.gsfc.nasa.gov/4720):
//   raw/lroc_color_16bit_srgb.tif   LROC WAC color mosaic at full size
//   raw/ldem_64_uint.tif            LOLA elevation, 64 px/deg, uint16 half-meters, +10 km offset
// Output: public/tiles/v1/{c,n}/<level>/<x>_<y>.{webp,jpg} and public/tiles/manifest.json
// Run: node scripts/build-tiles.mjs            (everything)
//      node scripts/build-tiles.mjs --sample   (one tile per level, to look at before the full run)
//      node scripts/build-tiles.mjs --only=n   (just relief, or --only=c for color)
import sharp from 'sharp';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { cols, rows, tileAt } from '../src/tiles.js';

const VERSION = 'v1', OUT = `public/tiles/${VERSION}`, GUTTER = 1, LEVELS = [3, 4, 5], TOP = 5;
const SAMPLE = process.argv.includes('--sample');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const R = 1737400, SLOPE_MAX = 1.0; // must match build-textures.mjs and the shader
sharp.cache(false);

// In sample mode: the tile holding Tycho, at each level.
const wanted = (level, x, y) => { if (!SAMPLE) return true; const t = tileAt(level, -11.36, -43.31); return t.x === x && t.y === y; };

/** Cut a w×h, 3-channel image into tiles with a wrapped (east-west) and clamped (poles) gutter. */
async function cut(buf, w, h, level, px, dir, encode) {
  const full = px + 2 * GUTTER, c = cols(level), r = rows(level);
  if (c * px !== w || r * px !== h) throw new Error(`level ${level}: ${w}x${h} is not ${c}x${r} tiles of ${px}`);
  await mkdir(`${OUT}/${dir}/${level}`, { recursive: true });
  const jobs = [];
  for (let ty = 0; ty < r; ty++) for (let tx = 0; tx < c; tx++) {
    if (!wanted(level, tx, ty)) continue;
    const tile = Buffer.alloc(full * full * 3);
    for (let yy = 0; yy < full; yy++) {
      const sy = Math.min(h - 1, Math.max(0, ty * px + yy - GUTTER));
      const sx0 = tx * px - GUTTER;
      if (sx0 >= 0 && sx0 + full <= w) buf.copy(tile, yy * full * 3, (sy * w + sx0) * 3, (sy * w + sx0 + full) * 3);
      else for (let xx = 0; xx < full; xx++) {
        const sx = (((sx0 + xx) % w) + w) % w;
        buf.copy(tile, (yy * full + xx) * 3, (sy * w + sx) * 3, (sy * w + sx) * 3 + 3);
      }
    }
    jobs.push(encode(sharp(tile, { raw: { width: full, height: full, channels: 3 } }), `${OUT}/${dir}/${level}/${tx}_${ty}`));
    if (jobs.length >= 8) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
}

// ---------------- color ----------------
let colorPx = null, colorSize = null;
async function color() {
  const src = 'raw/lroc_color_16bit_srgb.tif';
  const meta = await sharp(src, { limitInputPixels: false }).metadata();
  colorSize = [meta.width, meta.height];
  colorPx = Math.floor(meta.width / cols(TOP));
  console.log(`color source ${meta.width}x${meta.height}, ${meta.channels} channels, ${meta.depth}; tiles of ${colorPx}px`);
  if (meta.width !== meta.height * 2) throw new Error('color source is not 2:1');
  for (const level of [...LEVELS].reverse()) {
    const w = cols(level) * colorPx, h = rows(level) * colorPx;
    const { data, info } = await sharp(src, { limitInputPixels: false })
      .resize(w, h, { kernel: 'lanczos3', fit: 'fill' }).removeAlpha().toColourspace('srgb')
      .raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 || data.length !== w * h * 3) throw new Error(`unexpected raw color: ${JSON.stringify(info)}`);
    await cut(data, w, h, level, colorPx, 'c', (img, path) => img.webp({ quality: 90, smartSubsample: true }).toFile(`${path}.webp`));
    console.log(`color level ${level}: ${w}x${h}`);
  }
}

// ---------------- relief: true-scale slopes from the laser altimeter ----------------
/** Find where the samples start in an uncompressed, single-block little-endian TIFF, and its size. */
function tiffLayout(file) {
  if (file.readUInt32LE(0) !== 0x002a4949) throw new Error('expected little-endian TIFF');
  const ifd = file.readUInt32LE(4), n = file.readUInt16LE(ifd), tag = {};
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12, id = file.readUInt16LE(o), type = file.readUInt16LE(o + 2), count = file.readUInt32LE(o + 4);
    const value = type === 3 ? file.readUInt16LE(o + 8) : file.readUInt32LE(o + 8);
    tag[id] = { type, count, value };
  }
  const width = tag[256].value, height = tag[257].value;
  if ((tag[259]?.value ?? 1) !== 1) throw new Error('TIFF is compressed');
  if (tag[258].value !== 16) throw new Error('expected 16-bit samples');
  const strips = tag[273];
  const offsetOf = (i) => (strips.count === 1 ? strips.value : (strips.type === 3 ? file.readUInt16LE(strips.value + i * 2) : file.readUInt32LE(strips.value + i * 4)));
  const rowsPerStrip = tag[278]?.value ?? height;
  for (let i = 1; i < strips.count; i++) { // the reader below needs one unbroken block
    if (offsetOf(i) !== offsetOf(0) + i * rowsPerStrip * width * 2) throw new Error('TIFF strips are not contiguous');
  }
  return { width, height, offset: offsetOf(0) };
}

let normalPx = null, demSize = null, demRange = null;
async function relief() {
  const file = await readFile('raw/ldem_64_uint.tif');
  const { width: W, height: H, offset } = tiffLayout(file);
  demSize = [W, H];
  normalPx = W / cols(TOP);
  if (!Number.isInteger(normalPx) || H / rows(TOP) !== normalPx) throw new Error(`elevation ${W}x${H} does not divide into level ${TOP} tiles`);
  const dem = new Uint16Array(file.buffer, file.byteOffset + offset, W * H);
  const h = (x, y) => (dem[Math.min(H - 1, Math.max(0, y)) * W + ((x + W) % W)] - 20000) * 0.5; // meters
  const step = (2 * Math.PI) / W;
  const enc = (s) => {
    const c = Math.max(-1, Math.min(1, s / SLOPE_MAX));
    return Math.round(127.5 + 127.5 * Math.sign(c) * Math.sqrt(Math.abs(c)));
  };
  const nrm = Buffer.alloc(W * H * 3);
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < H; y++) {
    const cosLat = Math.max(Math.cos(Math.PI / 2 - (y + 0.5) * step), 1e-3);
    for (let x = 0; x < W; x++) {
      const v = h(x, y); if (v < min) min = v; if (v > max) max = v;
      const i = (y * W + x) * 3;
      nrm[i] = enc((h(x + 1, y) - h(x - 1, y)) / (2 * step * R * cosLat));
      nrm[i + 1] = enc((h(x, y - 1) - h(x, y + 1)) / (2 * step * R));
      nrm[i + 2] = 255;
    }
  }
  demRange = [min, max];
  console.log(`elevation ${W}x${H}, samples at byte ${offset}, range ${min} m .. ${max} m; tiles of ${normalPx}px`);
  if (min < -9500 || max > 11500) throw new Error('elevation range is implausible: wrong offset or format');
  const jpg = { quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true }; // 4:4:4 keeps both slope channels sharp
  for (const level of [...LEVELS].reverse()) {
    const w = cols(level) * normalPx, hh = rows(level) * normalPx;
    const data = level === TOP ? nrm : await sharp(nrm, { raw: { width: W, height: H, channels: 3 }, limitInputPixels: false })
      .resize(w, hh, { kernel: 'lanczos3', fit: 'fill' }).raw().toBuffer();
    await cut(data, w, hh, level, normalPx, 'n', (img, path) => img.jpeg(jpg).toFile(`${path}.jpg`));
    console.log(`relief level ${level}: ${w}x${hh}`);
  }
}

if (ONLY !== 'c') await relief();
if (ONLY !== 'n') await color();

// ---------------- manifest ----------------
async function tally(dir) {
  let files = 0, bytes = 0;
  for (const level of LEVELS) for (const f of await readdir(`${OUT}/${dir}/${level}`).catch(() => [])) { files++; bytes += (await stat(`${OUT}/${dir}/${level}/${f}`)).size; }
  return { files, bytes };
}
const c = await tally('c'), n = await tally('n');
console.log(`color: ${c.files} tiles, ${(c.bytes / 1e6).toFixed(1)} MB; relief: ${n.files} tiles, ${(n.bytes / 1e6).toFixed(1)} MB`);
if (!SAMPLE && !ONLY) {
  await writeFile('public/tiles/manifest.json', JSON.stringify({
    version: VERSION, gutter: GUTTER, levels: LEVELS,
    color: { px: colorPx, ext: 'webp', source: 'lroc_color_16bit_srgb.tif', sourceSize: colorSize, ...c },
    normal: { px: normalPx, ext: 'jpg', source: 'ldem_64_uint.tif', sourceSize: demSize, rangeMeters: demRange, ...n },
  }, null, 1) + '\n');
  console.log('wrote public/tiles/manifest.json');
}
