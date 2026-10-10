// Pure math for sky-builder (BRIEF §6, PLAN §4). No DOM or Three.js imports (rule 2).
// All angles in this API are degrees; conversion to radians happens inside each function.

import {
  CENTRE_TOLERANCE, FACE_HARD_LIMIT, FACE_WARN_LIMIT, MAPPING_DECIMALS, NOON_TICK, PITCH_LIMIT_DEG,
  SIGN_MAPPING_Y, SUN_ANGLE_BEZIER, TICKS_PER_DAY, UV_DECIMALS, ZENITH_DEG,
} from './constants.ts';
import type { AtlasLayout, FaceRect, HeroParams, Readouts, UvRange, Vec3, Warning } from './schema.ts';

const DEG = Math.PI / 180;
/** Slack for comparisons against limits, so values that round onto a limit don't trip it. */
const EPS = 1e-9;

const atanDeg = (x: number): number => Math.atan(x) / DEG;
const tanDeg = (deg: number): number => Math.tan(deg * DEG);

/** Modulo that is never negative, like Java's Math.floorMod for doubles. */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Wraps an angle to (−180, 180]. */
export function wrapDeg180(deg: number): number {
  const r = mod(deg + 180, 360) - 180;
  return (r === -180 ? 180 : r) + 0; // + 0 turns −0 into 0
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// --- Size ---------------------------------------------------------------------

/** k = tan(β/2): half-height of the hero on the face. */
export function kFromHeight(betaDeg: number): number {
  return tanDeg(betaDeg / 2);
}

/** β = 2·arctan(k). */
export function heightFromK(k: number): number {
  return 2 * atanDeg(k);
}

/** Scaling multiplies k, not β (BRIEF §6.1). */
export function scaleK(k: number, f: number): number {
  return f * k;
}

// --- North face ↔ atlas UV (BRIEF §6.1 step 3, §6.3) --------------------------

export function faceToNorthUv(s: number, t: number): { u: number; v: number } {
  return { u: 1 / 3 + (s + 1) / 6, v: 1 / 2 + (1 - t) / 4 };
}

export function northUvToFace(u: number, v: number): { s: number; t: number } {
  return { s: 6 * (u - 1 / 3) - 1, t: 1 - 4 * (v - 1 / 2) };
}

/** The hero's rectangle on the North face. The top edge (t1) comes from minV, because V = 0 is the top. */
export function uvRangeToFaceRect(uv: UvRange): FaceRect {
  const topLeft = northUvToFace(uv.minU, uv.minV);
  const bottomRight = northUvToFace(uv.maxU, uv.maxV);
  return { s0: topLeft.s, s1: bottomRight.s, t0: bottomRight.t, t1: topLeft.t };
}

// --- Forward solutions (unrounded) --------------------------------------------

/** Tilted mode, BRIEF §6.1 step 4: centred on the North face, s ∈ [−ak, ak], t ∈ [−k, k]. */
export function tiltedUv(aspect: number, k: number): UvRange {
  const ak = aspect * k;
  return {
    minU: 1 / 3 + (1 - ak) / 6,
    minV: 1 / 2 + (1 - k) / 4,
    maxU: 1 / 3 + (1 + ak) / 6,
    maxV: 1 / 2 + (1 + k) / 4,
  };
}

/** Mapping X = b + β/2, and β/2 = arctan(k). */
export function tiltedMappingX(k: number, bottomDeg: number): number {
  return bottomDeg + atanDeg(k);
}

/** Wall mode, BRIEF §6.2: upright on the North wall, bottom at elevation b, top at t_t. */
export function wallUv(aspect: number, bottomDeg: number, topT: number): UvRange {
  const tb = tanDeg(bottomDeg);
  const halfWidth = ((topT - tb) * aspect) / 2;
  return {
    minU: 1 / 3 + (1 - halfWidth) / 6,
    minV: 1 / 2 + (1 - topT) / 4,
    maxU: 1 / 3 + (1 + halfWidth) / 6,
    maxV: 1 / 2 + (1 - tb) / 4,
  };
}

// --- Rounding (BRIEF §5) --------------------------------------------------------

export function roundTo(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f + 0; // + 0 turns −0 into 0
}

export function roundUv(uv: UvRange): UvRange {
  return {
    minU: roundTo(uv.minU, UV_DECIMALS),
    minV: roundTo(uv.minV, UV_DECIMALS),
    maxU: roundTo(uv.maxU, UV_DECIMALS),
    maxV: roundTo(uv.maxV, UV_DECIMALS),
  };
}

/** Sliders → the rounded values that go into the JSON. */
export function solveHero(p: HeroParams): { uv: UvRange; mapping: Vec3 } {
  const aspect = p.imageW / p.imageH;
  const uv = p.mode === 'tilted' ? tiltedUv(aspect, p.k) : wallUv(aspect, p.bottomDeg, p.wallTopT);
  const x = p.mode === 'tilted' ? tiltedMappingX(p.k, p.bottomDeg) : 0;
  return {
    uv: roundUv(uv),
    mapping: [roundTo(x, MAPPING_DECIMALS), roundTo(p.mappingYDeg, MAPPING_DECIMALS), 0],
  };
}

// --- Inverse: readouts and import (BRIEF §6.3) ---------------------------------

/** a = 3(maxU − minU) / 2(maxV − minV); lets import work before an image is loaded. */
export function aspectFromUv(uv: UvRange): number {
  return (3 * (uv.maxU - uv.minU)) / (2 * (uv.maxV - uv.minV));
}

/**
 * Readouts for what Nuit will draw. Elevations are measured along the hero's vertical
 * centre line; the width is measured across its middle row.
 */
export function analyse(uv: UvRange, mappingX: number, aspect: number = aspectFromUv(uv)): Readouts {
  const rect = uvRangeToFaceRect(uv);
  const k = (rect.t1 - rect.t0) / 2;
  const ak = (rect.s1 - rect.s0) / 2;
  const tc = (rect.t0 + rect.t1) / 2;
  const topDeg = mappingX + atanDeg(rect.t1);
  const r: Readouts = {
    rect,
    aspect,
    k,
    ak,
    heightDeg: atanDeg(rect.t1) - atanDeg(rect.t0),
    widthDeg: 2 * atanDeg(ak / Math.hypot(1, tc)),
    topDeg,
    bottomDeg: mappingX + atanDeg(rect.t0),
    margins: {
      k: FACE_WARN_LIMIT - Math.max(Math.abs(rect.t0), Math.abs(rect.t1)),
      ak: FACE_WARN_LIMIT - Math.max(Math.abs(rect.s0), Math.abs(rect.s1)),
      zenithDeg: ZENITH_DEG - topDeg,
    },
    warnings: [],
  };
  r.warnings = checkConstraints(r);
  return r;
}

/** BRIEF §6.1 constraints. Bottom edges below the horizon are allowed and not warned about. */
export function checkConstraints(r: Readouts): Warning[] {
  const warnings: Warning[] = [];
  const hardMargin = FACE_HARD_LIMIT - FACE_WARN_LIMIT;
  if (r.margins.k < -hardMargin - EPS || r.margins.ak < -hardMargin - EPS) {
    warnings.push({ code: 'outsideCell', level: 'error',
      message: 'The hero crosses the edge of the North cell; Nuit will split it across two faces.' });
  } else {
    if (r.margins.k < -EPS) {
      warnings.push({ code: 'k', level: 'warn',
        message: `Vertical extent ${(FACE_WARN_LIMIT - r.margins.k).toFixed(3)} is over ${FACE_WARN_LIMIT}; close to the cell edge.` });
    }
    if (r.margins.ak < -EPS) {
      warnings.push({ code: 'ak', level: 'warn',
        message: `Horizontal extent ${(FACE_WARN_LIMIT - r.margins.ak).toFixed(3)} is over ${FACE_WARN_LIMIT}; close to the cell edge.` });
    }
  }
  if (r.margins.zenithDeg <= 0) {
    warnings.push({ code: 'zenith', level: 'error',
      message: `Top edge at ${r.topDeg.toFixed(1)}° tips over the zenith.` });
  }
  if (Math.abs(r.rect.s0 + r.rect.s1) / 2 > CENTRE_TOLERANCE) {
    warnings.push({ code: 'notCentred', level: 'warn',
      message: 'The hero is not centred left to right on the North face.' });
  }
  return warnings;
}

/** Which slider mode, if any, produced this uvRange and mapping X. */
export function classifyUv(uv: UvRange, mappingX: number): 'tilted' | 'wall' | 'custom' {
  const rect = uvRangeToFaceRect(uv);
  const centredS = Math.abs(rect.s0 + rect.s1) / 2 <= CENTRE_TOLERANCE;
  const centredT = Math.abs(rect.t0 + rect.t1) / 2 <= CENTRE_TOLERANCE;
  if (centredS && centredT) return 'tilted';
  if (centredS && mappingX === 0) return 'wall';
  return 'custom';
}

/** Recovers slider values from a JSON (import). Image size is not recoverable; only the aspect is. */
export function recoverParams(uv: UvRange, mapping: Vec3): Partial<HeroParams> {
  const [x, y] = mapping;
  const rect = uvRangeToFaceRect(uv);
  switch (classifyUv(uv, x)) {
    case 'tilted': {
      const k = 2 * (uv.maxV - uv.minV);
      return { mode: 'tilted', k, bottomDeg: x - atanDeg(k), mappingYDeg: y };
    }
    case 'wall':
      return { mode: 'wall', wallTopT: rect.t1, bottomDeg: atanDeg(rect.t0), mappingYDeg: y };
    case 'custom':
      return { mappingYDeg: y };
  }
}

// --- Time (BRIEF §3, §4.7) -------------------------------------------------------

/** Clock time for a tick: hour = (6 + T/1000) mod 24. */
export function ticksToClock(ticks: number): { h: number; m: number } {
  const hours = mod(6 + ticks / 1000, 24);
  const h = Math.floor(hours);
  return { h, m: Math.floor((hours - h) * 60) };
}

/**
 * CSS-style cubic Bézier from (0,0) to (1,1): solve x(s) = p for s by bisection, return y(s).
 * x(s) is monotonic because 0 ≤ x1, x2 ≤ 1.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, p: number): number {
  const b = (c1: number, c2: number, s: number): number =>
    3 * c1 * s * (1 - s) ** 2 + 3 * c2 * s ** 2 * (1 - s) + s ** 3;
  if (p <= 0) return 0; // exact at the ends, so θ(noon) is exactly 0
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (b(x1, x2, mid) < p) lo = mid;
    else hi = mid;
  }
  return b(y1, y2, (lo + hi) / 2);
}

/** θ(T): vanilla 26.2 `sun_angle`, the daily spin Nuit applies as Y(+θ). 0° at noon. */
export function sunAngleDeg(ticks: number): number {
  const p = mod((ticks - NOON_TICK) / TICKS_PER_DAY, 1);
  const [x1, y1, x2, y2] = SUN_ANGLE_BEZIER;
  return 360 * cubicBezier(x1, y1, x2, y2, p);
}

/** Compass bearing at noon (clockwise from north) for a raw mapping Y. Negative = west of north. */
export function noonBearingDeg(mappingYDeg: number): number {
  return wrapDeg180(-SIGN_MAPPING_Y * mappingYDeg);
}

// --- View (BRIEF §9) ---------------------------------------------------------------

export function clampPitch(pitchDeg: number): number {
  return clamp(pitchDeg, -PITCH_LIMIT_DEG, PITCH_LIMIT_DEG);
}

/**
 * The yaw and pitch Minecraft's F3 screen shows for a view, so the preview can be matched in game.
 * Minecraft's yaw is 0 facing south and grows clockwise (west = 90), so it is the bearing minus 180°.
 * Its pitch is positive looking down.
 */
export function mcYawPitch(bearingDeg: number, pitchDeg: number): { yaw: number; pitch: number } {
  return { yaw: wrapDeg180(bearingDeg - 180), pitch: -pitchDeg + 0 };
}

/** The "Facing" word on Minecraft's F3 screen: the nearest of the four compass directions. */
export function mcFacing(bearingDeg: number): 'north' | 'east' | 'south' | 'west' {
  return (['north', 'east', 'south', 'west'] as const)[mod(Math.floor(bearingDeg / 90 + 0.5), 4)];
}

// --- Atlas (BRIEF §2, §8) ------------------------------------------------------------

/**
 * A sky atlas is a 3 × 2 grid of square faces, so it must be exactly 3:2 (2W = 3H).
 * That also makes H even and W = 3·(H/2), so the face size W/3 is always a whole number.
 */
export function atlasLayout(width: number, height: number): AtlasLayout {
  if (width > 0 && 2 * width === 3 * height) return { ok: true, faceSize: width / 3 };
  return { ok: false, message: `A sky atlas must be exactly 3:2 (3 faces wide, 2 high); this image is ${width} × ${height}.` };
}
