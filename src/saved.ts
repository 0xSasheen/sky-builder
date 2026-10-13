// What the tool remembers between visits (PLAN §15.2). Pure: main.ts does the reading and writing, so this
// can be tested without a browser. A broken or older entry falls back to the defaults, field by field.

import { PANO_FACE_RANGE, PANO_LEFT_BEARING_RANGE, PLAY_SPEEDS, RANGES, TICKS_PER_DAY } from './constants.ts';
import { parseSky3, serializeSky3 } from './json.ts';
import { clamp, clampHero, clampPitch, mod, wrapDeg180 } from './math.ts';
import type { HeroParams, Sky3Json, SkyType, ViewState } from './schema.ts';

/** The localStorage key. A new layout would get a new version, and an old entry would be ignored. */
export const SAVED_KEY = 'sky-builder/v1';

/** The view as remembered: everything except "playing", which always starts paused. */
export type SavedView = Pick<ViewState, 'timeTicks' | 'ticksPerSecond' | 'fovDeg' | 'yawDeg' | 'pitchDeg' | 'showOverlay'>;

export interface SavedSky {
  type: SkyType;
  /** null means the default for the panorama's width. */
  faceSize: number | null;
  leftBearingDeg: number;
}

export interface Session {
  hero: HeroParams;
  view: SavedView;
  sky: SavedSky;
  /** An imported JSON that was still pinned, with the name it was imported from. */
  pinned: { json: Sky3Json; name: string } | null;
}

/** The session as text for localStorage. A pinned JSON is kept as its exact serialised bytes. */
export function toSaved(session: Session): string {
  const { hero, view, sky, pinned } = session;
  return JSON.stringify({
    version: 1,
    hero,
    view,
    sky,
    pinned: pinned && { name: pinned.name, json: serializeSky3(pinned.json) },
  });
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
/** A number field, or the fallback if it is missing or not a finite number. */
const num = (o: Obj, key: string, fallback: number): number => (isNum(o[key]) ? (o[key] as number) : fallback);

/** Reads what toSaved wrote. Anything missing or invalid takes the default, and values are clamped as if typed in. */
export function fromSaved(text: string | null, defaults: Session): Session {
  let raw: unknown;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    return defaults;
  }
  if (!isObj(raw) || raw.version !== 1) return defaults;

  const h = isObj(raw.hero) ? raw.hero : {};
  const dh = defaults.hero;
  const hero = clampHero({
    mode: h.mode === 'tilted' || h.mode === 'wall' ? h.mode : dh.mode,
    imageW: num(h, 'imageW', dh.imageW),
    imageH: num(h, 'imageH', dh.imageH),
    k: num(h, 'k', dh.k),
    bottomDeg: num(h, 'bottomDeg', dh.bottomDeg),
    wallTopT: num(h, 'wallTopT', dh.wallTopT),
    mappingYDeg: num(h, 'mappingYDeg', dh.mappingYDeg),
    texture: typeof h.texture === 'string' ? h.texture : dh.texture,
    layer: num(h, 'layer', dh.layer),
  });

  const v = isObj(raw.view) ? raw.view : {};
  const dv = defaults.view;
  const speed = num(v, 'ticksPerSecond', dv.ticksPerSecond);
  const view: SavedView = {
    timeTicks: mod(num(v, 'timeTicks', dv.timeTicks), TICKS_PER_DAY),
    ticksPerSecond: PLAY_SPEEDS.some((s) => s.ticksPerSecond === speed) ? speed : dv.ticksPerSecond,
    fovDeg: clamp(num(v, 'fovDeg', dv.fovDeg), RANGES.fovDeg.min, RANGES.fovDeg.max),
    yawDeg: wrapDeg180(num(v, 'yawDeg', dv.yawDeg)),
    pitchDeg: clampPitch(num(v, 'pitchDeg', dv.pitchDeg)),
    showOverlay: typeof v.showOverlay === 'boolean' ? v.showOverlay : dv.showOverlay,
  };

  const s = isObj(raw.sky) ? raw.sky : {};
  const ds = defaults.sky;
  const sky: SavedSky = {
    type: s.type === 'auto' || s.type === 'atlas' || s.type === 'panorama' ? s.type : ds.type,
    faceSize: isNum(s.faceSize) ? clamp(Math.round(s.faceSize), PANO_FACE_RANGE.min, PANO_FACE_RANGE.max) : ds.faceSize,
    leftBearingDeg: clamp(num(s, 'leftBearingDeg', ds.leftBearingDeg), PANO_LEFT_BEARING_RANGE.min, PANO_LEFT_BEARING_RANGE.max),
  };

  // A pinned JSON goes through the importer again, so a damaged entry is dropped rather than shown.
  let pinned: Session['pinned'] = null;
  if (isObj(raw.pinned) && typeof raw.pinned.json === 'string' && typeof raw.pinned.name === 'string') {
    const parsed = parseSky3(raw.pinned.json);
    if (parsed.ok) pinned = { json: parsed.json, name: raw.pinned.name };
  }

  return { hero, view, sky, pinned };
}
