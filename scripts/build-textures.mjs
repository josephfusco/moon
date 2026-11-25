// Bake web textures from NASA SVS "CGI Moon Kit" source files (https://svs.gsfc.nasa.gov/4720).
//   raw/lroc_color_16bit_srgb_8k.tif  LROC WAC Hapke-normalised colour mosaic (2025 version)
//   raw/ldem_16_uint.tif              LOLA elevation, 16 px/deg, uint16 half-metres, +10 km offset,
//                                     relative to a 1737.4 km sphere
// Run: node scripts/build-textures.mjs
import sharp from 'sharp';
import { mkdir, stat, readFile } from 'node:fs/promises';

const OUT = 'public/textures';
const R = 1737400; // metres
export const SLOPE_MAX = 1.0; // slopes are stored as sign(s)*sqrt(|s|/SLOPE_MAX): fine steps on gentle terrain
await mkdir(OUT, { recursive: true });

// ---- colour ----
for (const [w, name] of [[8192, 'color_8k'], [4096, 'color_4k'], [2048, 'color_2k']]) {
  await sharp('raw/lroc_color_16bit_srgb_8k.tif', { limitInputPixels: false })
    .resize(w, w / 2, { kernel: 'lanczos3' })
    .webp({ quality: 90, smartSubsample: true })
    .toFile(`${OUT}/${name}.webp`);
}

// ---- elevation -> true-scale slope (normal) map ----
// sharp/libvips tone-maps 16-bit greyscale to 8-bit sRGB, so read the samples directly:
// the file is an uncompressed little-endian TIFF whose pixel data starts at byte 8.
const W = 5760, H = 2880;
const file = await readFile('raw/ldem_16_uint.tif');
if (file.readUInt32LE(0) !== 0x002a4949) throw new Error('expected little-endian TIFF');
const dem = new Uint16Array(W * H);
for (let i = 0; i < dem.length; i++) dem[i] = file.readUInt16LE(8 + i * 2);
const h = (x, y) => (dem[Math.min(H - 1, Math.max(0, y)) * W + ((x + W) % W)] - 20000) * 0.5; // metres
const step = (2 * Math.PI) / W; // radians per pixel, both axes
const enc = (s) => {
  const c = Math.max(-1, Math.min(1, s / SLOPE_MAX));
  return Math.round(127.5 + 127.5 * Math.sign(c) * Math.sqrt(Math.abs(c)));
};
const nrm = Buffer.alloc(W * H * 3);
let min = Infinity, max = -Infinity;
for (let y = 0; y < H; y++) {
  const lat = Math.PI / 2 - (y + 0.5) * step;
  const cosLat = Math.max(Math.cos(lat), 1e-3);
  for (let x = 0; x < W; x++) {
    const v = h(x, y); if (v < min) min = v; if (v > max) max = v;
    const east = (h(x + 1, y) - h(x - 1, y)) / (2 * step * R * cosLat); // dh/d(east)
    const north = (h(x, y - 1) - h(x, y + 1)) / (2 * step * R); // dh/d(north); rows run north -> south
    const i = (y * W + x) * 3;
    nrm[i] = enc(east); nrm[i + 1] = enc(north); nrm[i + 2] = 255;
  }
}
console.log(`elevation range: ${min} m .. ${max} m`);
const nimg = () => sharp(nrm, { raw: { width: W, height: H, channels: 3 }, limitInputPixels: false });
// 4:4:4 so the two slope channels are not chroma-subsampled
const jpg = { quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true };
await nimg().jpeg(jpg).toFile(`${OUT}/normal_6k.jpg`);
await nimg().resize(4096, 2048, { kernel: 'lanczos3' }).jpeg(jpg).toFile(`${OUT}/normal_4k.jpg`);

// ---- elevation for real limb relief: 1024x512, uint16 split across R (high byte) and G (low byte) ----
const SW = 1024, SH = 512, k = W / SW;
const s16 = new Uint16Array(SW * SH);
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
  let sum = 0, n = 0;
  for (let yy = Math.floor(y * k); yy < Math.floor((y + 1) * k); yy++)
    for (let xx = Math.floor(x * k); xx < Math.floor((x + 1) * k); xx++) { sum += dem[yy * W + xx]; n++; }
  s16[y * SW + x] = Math.round(sum / n);
}
const packed = Buffer.alloc(1024 * 512 * 3);
for (let i = 0; i < s16.length; i++) { packed[i * 3] = s16[i] >> 8; packed[i * 3 + 1] = s16[i] & 255; }
await sharp(packed, { raw: { width: 1024, height: 512, channels: 3 } }).png().toFile(`${OUT}/height_1k.png`);

for (const f of ['color_8k.webp', 'color_4k.webp', 'color_2k.webp', 'normal_6k.jpg', 'normal_4k.jpg', 'height_1k.png']) {
  console.log(f, ((await stat(`${OUT}/${f}`)).size / 1e6).toFixed(1), 'MB');
}
