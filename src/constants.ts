// Constants shared by the math, the JSON builder and the preview.
// Type imports only: everything else depends on this file.

import type { FaceDef } from './schema.ts';

// --- Mapping signs (CLAUDE.md rule 6) ---------------------------------------
// Multiplied into the Three.js Euler: new Euler(SIGN_MAPPING_X·X, SIGN_MAPPING_Y·Y, 0, 'ZYX').
// +1 means the JSON value goes in unchanged (JOML and Three.js share conventions, PLAN §1.2).

/** Closed: +X tilts the North face up (source + running config agree, BRIEF §12.1). */
export const SIGN_MAPPING_X = 1;
/** Pending in-game check A (PLAN §10): source says +Y turns the hero toward west. */
export const SIGN_MAPPING_Y = 1;

// --- Cube faces (BRIEF §3) ---------------------------------------------------
// From reference/sky_convert.py; checked against Nuit's MATRIX4F_ROTATED_FACE by tests/faces.test.ts.
// right × up = −centre for every face, so each face's front side looks inward.

export const FACES: readonly FaceDef[] = [
  { name: 'bottom', col: 0, row: 0, centre: [0, -1, 0], right: [1, 0, 0], up: [0, 0, -1] },
  { name: 'top', col: 1, row: 0, centre: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { name: 'south', col: 2, row: 0, centre: [0, 0, 1], right: [-1, 0, 0], up: [0, 1, 0] },
  { name: 'west', col: 0, row: 1, centre: [-1, 0, 0], right: [0, 0, -1], up: [0, 1, 0] },
  { name: 'north', col: 1, row: 1, centre: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
  { name: 'east', col: 2, row: 1, centre: [1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] },
];

// --- Time (BRIEF §3, §4.7) ---------------------------------------------------

export const TICKS_PER_DAY = 24000;
/** Tick at which vanilla's sun_angle is 0°, so the spin is zero. */
export const NOON_TICK = 6000;
/** `minecraft:visual/sun_angle` ease in vanilla 26.2 `timeline/day.json`, as [x1, y1, x2, y2]. */
export const SUN_ANGLE_BEZIER = [0.362, 0.241, 0.638, 0.759] as const;

// --- Panoramas (PLAN §13), the convention of reference/sky_convert.py --------

/** Compass bearing of a panorama's left edge (its YAW0): the south-west cube corner. Strip reads W | N | E | S. */
export const PANO_LEFT_BEARING_DEG = -135;
/** Face sizes for a converted atlas. sky_convert.py refuses faces over 2730, as the atlas would pass 8192 px wide. */
export const PANO_FACE_RANGE = { min: 16, max: 2730 } as const;
/** The left-edge bearing field (PLAN §13.7), for panoramas made with another convention. */
export const PANO_LEFT_BEARING_RANGE = { min: -180, max: 180 } as const;

// --- Constraints (BRIEF §6.1) ------------------------------------------------

/** Past this, in face units, the hero is close to spilling into a neighbouring cell. */
export const FACE_WARN_LIMIT = 0.95;
/** The edge of the North cell, in face units. */
export const FACE_HARD_LIMIT = 1.0;
/** The top edge must stay below the zenith. */
export const ZENITH_DEG = 90;
/** Tolerance in face units for "centred" after 4 dp rounding (6 · 5e-5 per edge, doubled). */
export const CENTRE_TOLERANCE = 1e-3;

// --- Rounding (BRIEF §5) -----------------------------------------------------

export const UV_DECIMALS = 4;
export const MAPPING_DECIMALS = 2;

// --- Defaults and slider ranges (BRIEF §8) -----------------------------------

/** Look controls stop short of straight up and down (BRIEF §9). */
export const PITCH_LIMIT_DEG = 89;

export const DEFAULTS = {
  imageW: 1063,
  imageH: 1502,
  heightDeg: 40.5,
  bottomDeg: 3,
  mappingYDeg: 0,
  wallTopT: 0.95,
  texture: 'sasheen:textures/sky/hero.png',
  layer: 3,
  timeTicks: NOON_TICK,
  fovDeg: 70,
  /** The view opens looking north at the horizon. */
  yawDeg: 0,
  pitchDeg: 0,
} as const;

export const RANGES = {
  /** The β slider. It only displays k, which may go past it (K_RANGE). */
  heightDeg: { min: 5, max: 87 },
  bottomDeg: { min: -30, max: 60 },
  mappingYDeg: { min: -180, max: 180 },
  /** Wall mode's top edge t_t, in face units. */
  wallTopT: { min: 0, max: 1 },
  timeTicks: { min: 0, max: TICKS_PER_DAY - 1 },
  fovDeg: { min: 30, max: 110 },
  yawDeg: { min: -180, max: 180 },
  pitchDeg: { min: -PITCH_LIMIT_DEG, max: PITCH_LIMIT_DEG },
} as const;

/**
 * Allowed k = tan(β/2). The bottom is β = 5°. The top, 1.5, is past the cell edge (1.0), so the k box
 * and scale buttons can reach the warnings, and one ×1.5 step past 0.95 can still be undone with ÷1.5.
 */
export const K_RANGE = { min: Math.tan((2.5 * Math.PI) / 180), max: 1.5 } as const;

export const SCALE_FACTORS = [1.15, 1.5] as const;

// --- Fixed JSON values (BRIEF §5). These must match the sky layers. ---------

export const FIXED_JSON = {
  schemaVersion: 1,
  type: 'nuit:multi-textured',
  blend: 'normal',
  fadeDuration: 24000,
  speed: 1.0,
  axis: [0, 0, 0],
  skyboxRotation: false,
  sunSkyTint: false,
  visibleUnderwater: true,
  worlds: ['minecraft:overworld'],
} as const;
