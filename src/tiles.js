// Tile addressing for the detail layers. Pure arithmetic, shared by the renderer, the baker and the tests.
//
// The Moon map is an equirectangular image: left edge 180°W, right edge 180°E, top edge the north pole.
// Level L cuts it into 2^L columns and 2^(L-1) rows of square tiles; tile (x, y) counts from the top left.
// Every tile image carries a border of `gutter` pixels copied from its neighbors, so that smooth
// sampling at a tile's edge blends into the same pixels its neighbor shows and no seam appears.
import { MOON_RADIUS_KM } from './ephemeris.js';

export const cols = (level) => 2 ** level;
export const rows = (level) => 2 ** (level - 1);
export const tileKey = (level, x, y) => `${level}/${x}_${y}`;

/** Size of one image pixel on the ground at the equator, in km. */
export const texelKm = (level, px) => (2 * Math.PI * MOON_RADIUS_KM) / (cols(level) * px);

/**
 * How to turn the globe's own texture coordinate (u: 0 at 180°W to 1 at 180°E, v: 0 south pole to 1 north
 * pole) into a coordinate inside one tile image: tileUV = globeUV * scale + offset.
 * Returns [offsetU, offsetV, scaleU, scaleV]. Assumes the image is loaded with its top row at v = 1.
 */
export function tileTransform(level, x, y, px, gutter) {
  const full = px + 2 * gutter, c = cols(level), r = rows(level);
  return [
    (gutter - x * px) / full,
    1 - (gutter + (r - y) * px) / full,
    (c * px) / full,
    (r * px) / full,
  ];
}

/** Longitude and latitude limits of a tile, in degrees. */
export function tileBounds(level, x, y) {
  const w = 360 / cols(level), h = 180 / rows(level);
  return { west: -180 + x * w, east: -180 + (x + 1) * w, north: 90 - y * h, south: 90 - (y + 1) * h };
}

/** The tile that contains a place. */
export function tileAt(level, lon, lat) {
  const c = cols(level), r = rows(level);
  const x = Math.min(c - 1, Math.max(0, Math.floor(((((lon + 180) % 360) + 360) % 360) / 360 * c)));
  const y = Math.min(r - 1, Math.max(0, Math.floor((90 - lat) / 180 * r)));
  return { x, y };
}

/**
 * Which level to show for the current magnification: the coarsest one whose pixels are no bigger than
 * the screen's (with a little slack). Returns null when the base map is already sharp enough.
 */
export function pickLevel(kmPerScreenPx, baseTexelKm, levels, px, slack = 1.25) {
  const want = kmPerScreenPx * slack;
  if (baseTexelKm <= want) return null;
  const sorted = [...levels].sort((a, b) => a - b);
  return sorted.find((l) => texelKm(l, px) <= want) ?? sorted[sorted.length - 1];
}

/** Every tile address in a set of levels. */
export function allTiles(levels) {
  const out = [];
  for (const level of levels) for (let y = 0; y < rows(level); y++) for (let x = 0; x < cols(level); x++) out.push({ level, x, y });
  return out;
}
