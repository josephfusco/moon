import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cols, rows, texelKm, tileTransform, tileBounds, tileAt, pickLevel, allTiles, mortonIndex } from '../src/tiles.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
// Globe texture coordinate of a place: u from 180°W, v from the south pole.
const globeUV = (lon, lat) => [(lon + 180) / 360, (lat + 90) / 180];
const apply = (t, [u, v]) => [u * t[2] + t[0], v * t[3] + t[1]];

test('a tile covers exactly its own image area, inside the gutter', () => {
  const px = 855, g = 1, full = px + 2 * g;
  for (const [level, x, y] of [[3, 0, 0], [3, 7, 3], [4, 5, 2], [5, 0, 15], [5, 31, 0], [5, 17, 9]]) {
    const b = tileBounds(level, x, y), t = tileTransform(level, x, y, px, g);
    const [uL, vT] = apply(t, globeUV(b.west, b.north));   // top left of the tile
    const [uR, vB] = apply(t, globeUV(b.east, b.south));   // bottom right
    near(uL, g / full); near(uR, (g + px) / full);
    near(vT, 1 - g / full); near(vB, 1 - (g + px) / full); // image top row is v = 1
    const [uc, vc] = apply(t, globeUV((b.west + b.east) / 2, (b.north + b.south) / 2));
    near(uc, 0.5); near(vc, 0.5);
  }
});

test('an unflipped image maps the same area upside down', () => {
  const px = 720, g = 1, full = px + 2 * g;
  for (const [level, x, y] of [[3, 2, 1], [5, 30, 14]]) {
    const b = tileBounds(level, x, y), t = tileTransform(level, x, y, px, g, false);
    const [uL, vT] = apply(t, globeUV(b.west, b.north)), [uR, vB] = apply(t, globeUV(b.east, b.south));
    near(uL, g / full); near(uR, (g + px) / full);
    near(vT, g / full); near(vB, (g + px) / full); // image top row is v = 0
  }
});

test('quadtree numbering: every tile once, children consecutive under their parent', () => {
  for (const level of [3, 4, 5]) {
    const seen = new Set();
    for (let y = 0; y < rows(level); y++) for (let x = 0; x < cols(level); x++) seen.add(mortonIndex(level, x, y));
    assert.equal(seen.size, cols(level) * rows(level));
    assert.equal(Math.max(...seen), cols(level) * rows(level) - 1);
  }
  for (const [level, x, y] of [[3, 0, 0], [3, 5, 2], [4, 15, 7], [4, 8, 0]]) {
    const kids = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => mortonIndex(level + 1, 2 * x + a, 2 * y + b)).sort((p, q) => p - q);
    assert.deepEqual(kids, [0, 1, 2, 3].map((k) => mortonIndex(level, x, y) * 4 + k));
  }
});

test('places land in the tile whose bounds contain them', () => {
  const places = { Tycho: [-11.36, -43.31], Copernicus: [-20.08, 9.62], Plato: [-9.38, 51.62], farSide: [179.9, 0], pole: [0, 90], south: [10, -90] };
  for (const level of [3, 4, 5]) for (const [name, [lon, lat]] of Object.entries(places)) {
    const { x, y } = tileAt(level, lon, lat), b = tileBounds(level, x, y);
    assert.ok(lon >= b.west && lon <= b.east && lat <= b.north && lat >= b.south, `${name} at level ${level}`);
    assert.ok(x >= 0 && x < cols(level) && y >= 0 && y < rows(level));
  }
  assert.deepEqual(tileAt(5, -180, 0), tileAt(5, 180, 0)); // the map wraps
});

test('tiles are square on the map and levels double in detail', () => {
  for (const level of [3, 4, 5]) {
    const b = tileBounds(level, 1, 1);
    near(b.east - b.west, b.north - b.south);
    near(texelKm(level, 855) / texelKm(level + 1, 855), 2);
  }
  assert.equal(allTiles([3, 4, 5]).length, 32 + 128 + 512);
});

test('detail level follows magnification and never exceeds what exists', () => {
  const px = 855, levels = [3, 4, 5], base = texelKm(3, 1024); // an 8k base map
  assert.equal(pickLevel(4.3, base, levels, px), null);          // whole disc on a screen: base is enough
  assert.equal(pickLevel(0.7, base, levels, px), 4);
  assert.equal(pickLevel(0.4, base, levels, px), 5);
  assert.equal(pickLevel(0.05, base, levels, px), 5);            // closer than the data: stay at the finest
  assert.equal(pickLevel(1.4, texelKm(3, 512), levels, px), 3);  // a 4k base map needs help sooner
});
