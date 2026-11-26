// One clock in, the whole Earth–Moon–Sun geometry out.
// Everything the renderer needs is expressed in the Moon's body-fixed frame
// (x = 0°N 0°E, y = 0°N 90°E, z = north pole), so the Moon mesh never moves:
// the observer and the Sun move around it.
import * as A from 'astronomy-engine';

export const MOON_RADIUS_KM = 1737.4;
export const EARTH_RADIUS_KM = 6378.137;
export const SUN_RADIUS_KM = 695700;
export const AU_KM = 149597870.7;
export const SYNODIC_DAYS = 29.530588853;
const DEG = Math.PI / 180;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const arr = (v) => [v.x, v.y, v.z];

/** Basis vectors of the Moon's body-fixed frame, expressed in J2000 equatorial (EQJ). */
function moonFrame(time) {
  const ax = A.RotationAxis(A.Body.Moon, time);
  const p = norm(arr(ax.north));
  const q = norm(cross([0, 0, 1], p)); // ascending node of the lunar equator on the ICRF equator
  const w = ax.spin * DEG; // IAU prime-meridian angle W
  const pq = cross(p, q);
  const x = [0, 1, 2].map((i) => q[i] * Math.cos(w) + pq[i] * Math.sin(w));
  return { x, y: cross(p, x), z: p };
}
const toBody = (f, v) => [dot(v, f.x), dot(v, f.y), dot(v, f.z)];
const lonLat = (v) => {
  const n = norm(v);
  return { lon: Math.atan2(n[1], n[0]) / DEG, lat: Math.asin(n[2]) / DEG };
};

/**
 * @param {Date} date
 * @param {{lat:number, lon:number, height?:number}|null} where  null = center of the Earth
 */
export function moonState(date, where = null) {
  const time = A.MakeTime(date);
  const moonGeo = scale(arr(A.GeoMoon(time)), AU_KM); // Earth center -> Moon, EQJ, km
  const sunGeo = scale(arr(A.GeoVector(A.Body.Sun, time, true)), AU_KM);

  let obs = [0, 0, 0];
  let observer = null;
  if (where) {
    observer = new A.Observer(where.lat, where.lon, where.height ?? 0);
    obs = scale(arr(A.ObserverVector(time, observer, false)), AU_KM);
  }
  const f = moonFrame(time);
  const toObs = sub(obs, moonGeo); // Moon -> observer
  const toSun = sub(sunGeo, moonGeo); // Moon -> Sun
  const toEarth = scale(moonGeo, -1);
  const distance = len(toObs);

  const obsB = toBody(f, toObs);
  const sunB = toBody(f, toSun);
  const earthB = toBody(f, toEarth);

  // Screen "up" candidates, as body-frame vectors (the renderer projects them).
  const eqd = A.Rotation_EQD_EQJ(time);
  const northOfDate = arr(A.RotateVector(eqd, new A.Vector(0, 0, 1, time)));
  const northB = toBody(f, northOfDate);
  let zenithB = null;
  let horizon = null;
  if (observer) {
    const hor = A.Rotation_HOR_EQJ(time, observer);
    zenithB = toBody(f, arr(A.RotateVector(hor, new A.Vector(0, 0, 1, time))));
    const eq = A.Equator(A.Body.Moon, time, observer, true, true);
    const h = A.Horizon(time, observer, eq.ra, eq.dec, 'normal');
    horizon = { altitude: h.altitude, azimuth: h.azimuth };
  }

  // Phase angle at the Moon between the Sun and the observer.
  const phaseAngle = Math.acos(Math.max(-1, Math.min(1, dot(norm(toObs), norm(toSun))))) / DEG;
  const illuminated = (1 + Math.cos(phaseAngle * DEG)) / 2;
  const elongation = A.MoonPhase(time); // 0 new, 90 first quarter, 180 full, 270 last quarter

  // Position angle of the Moon's north pole, east of celestial north.
  const view = norm(scale(toObs, -1)); // observer -> Moon, EQJ
  const perp = (v) => norm(sub(v, scale(view, dot(v, view))));
  const nSky = perp(northOfDate);
  const eSky = cross(nSky, view); // east on the sky
  const pSky = perp(f.z);
  const posAngle = ((Math.atan2(dot(pSky, eSky), dot(pSky, nSky)) / DEG) + 360) % 360;

  const ecl = A.EclipticGeoMoon(time); // true ecliptic of date
  // Fraction of Earth's disc that is sunlit as seen from the Moon (drives earthshine).
  const earthLit = (1 + dot(norm(sunGeo), norm(moonGeo))) / 2;

  return {
    date, time, distance, phaseAngle, illuminated, elongation, posAngle,
    obsB, sunB, earthB, northB, zenithB, horizon,
    subObserver: lonLat(obsB),
    subSolar: lonLat(sunB),
    angularDiameterArcsec: (2 * Math.asin(MOON_RADIUS_KM / distance)) / DEG * 3600,
    eclipticLon: ecl.lon, eclipticLat: ecl.lat, earthLit,
  };
}

const PHASES = [
  'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
  'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
];
/** Principal phases are instants; we name them within ±6° of elongation (about half a day). */
export function phaseName(elongation) {
  const e = ((elongation % 360) + 360) % 360;
  for (let k = 0; k < 4; k++) {
    const d = Math.abs(((e - k * 90 + 540) % 360) - 180);
    if (d <= 6) return PHASES[k * 2];
  }
  return PHASES[Math.floor(e / 90) * 2 + 1];
}
export const phaseIndex = (elongation) => PHASES.indexOf(phaseName(elongation));

const SIGNS = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const GLYPHS = ['♈︎', '♉︎', '♊︎', '♋︎', '♌︎', '♍︎', '♎︎', '♏︎', '♐︎', '♑︎', '♒︎', '♓︎'];
/** Tropical zodiac sign from ecliptic longitude of date. */
export function zodiac(lon) {
  const l = ((lon % 360) + 360) % 360;
  const i = Math.floor(l / 30);
  return { sign: SIGNS[i], glyph: GLYPHS[i], degree: l - i * 30 };
}

/** Elongation alone (0 new, 180 full), for when the full state is more than is needed. */
export const elongationAt = (date) => A.MoonPhase(A.MakeTime(date));

/** Time of the nearest instant (forward or backward) when elongation = target degrees. */
export function searchPhase(targetDeg, date, direction = 1) {
  const r = A.SearchMoonPhase(targetDeg, A.MakeTime(date), direction * 40);
  return r ? r.date : null;
}
/** Days since the previous new moon. */
export function moonAge(date) {
  const prev = searchPhase(0, date, -1);
  return prev ? (date - prev) / 86400000 : NaN;
}
export function riseSet(date, where) {
  if (!where) return null;
  const o = new A.Observer(where.lat, where.lon, where.height ?? 0);
  const t = A.MakeTime(date);
  const rise = A.SearchRiseSet(A.Body.Moon, o, +1, t, 1.5);
  const set = A.SearchRiseSet(A.Body.Moon, o, -1, t, 1.5);
  return { rise: rise?.date ?? null, set: set?.date ?? null };
}
const GM_MOON = 4902.800066, GM_SUN = 132712440018; // km^3/s^2
export const C_KM_S = 299792.458;
/**
 * What the Moon is doing at a place on Earth: where it is in that sky, and the vertical part of the
 * tide-raising acceleration from the Moon and the Sun (the difference between each body's pull at the
 * place and at the Earth's center). Positive = upward, in micrometers per second squared.
 * This is the force that drives tides, not a water height: that depends on coastlines and basins.
 */
export function localEffects(date, where) {
  const time = A.MakeTime(date);
  const observer = new A.Observer(where.lat, where.lon, where.height ?? 0);
  const r = scale(arr(A.ObserverVector(time, observer, false)), AU_KM); // Earth center -> place, EQJ, km
  const up = arr(A.RotateVector(A.Rotation_HOR_EQJ(time, observer), new A.Vector(0, 0, 1, time)));
  const lift = (gm, body) => {
    const d = sub(body, r), ld = len(d), lb = len(body);
    const a = sub(scale(d, gm / (ld * ld * ld)), scale(body, gm / (lb * lb * lb))); // km/s^2
    return dot(a, up) * 1e9; // µm/s^2
  };
  const moon = lift(GM_MOON, scale(arr(A.GeoMoon(time)), AU_KM));
  const sun = lift(GM_SUN, scale(arr(A.GeoVector(A.Body.Sun, time, true)), AU_KM));
  const eq = A.Equator(A.Body.Moon, time, observer, true, true);
  const h = A.Horizon(time, observer, eq.ra, eq.dec, 'normal');
  return { altitude: h.altitude, azimuth: h.azimuth, tideMoon: moon, tideSun: sun, tide: moon + sun };
}
export function nextApsis(date) {
  const a = A.SearchLunarApsis(A.MakeTime(date));
  return { kind: a.kind === 0 ? 'perigee' : 'apogee', date: a.time.date, km: a.dist_km };
}
