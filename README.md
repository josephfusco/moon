# Moon

The Moon as it really is right now, for where you are: NASA Lunar Reconnaissance Orbiter imagery and
laser-measured relief, lit and turned by a real ephemeris. Runs entirely in the browser, works offline,
and asks nothing of any other site.

Live: https://josephfus.co/moon/

## Run it

```sh
npm install
npm run dev        # development server
npm test           # ephemeris and tile tests (checked against recorded NASA Dial-A-Moon values)
```

## Data

Color and elevation come from NASA's Scientific Visualization Studio
[CGI Moon Kit](https://svs.gsfc.nasa.gov/4720) (LROC wide-angle camera mosaic and LOLA elevation).
The base maps in `public/textures` are in the repository. The zoom-in detail tiles (263 MB) are not;
they are baked from the kit's full-size files:

```sh
# download into raw/: lroc_color_16bit_srgb.tif (2.6 GB) and ldem_64_uint.tif (0.5 GB), then
npm run tiles
```

Without tiles the app still works and simply shows the base maps.

Positions come from [Astronomy Engine](https://github.com/cosinekitty/astronomy). Artemis II photographs
are NASA's, from the NASA Image and Video Library. "How this Moon is made" in the app lists what is
exact and what is approximated.

## Publish

```sh
npm run deploy     # tests, builds, and pushes the site to the gh-pages branch
```

## Checks in a real browser

`scripts/check-tiles.mjs` and `scripts/check-offline.mjs` drive headless Chrome with no extra dependencies.
