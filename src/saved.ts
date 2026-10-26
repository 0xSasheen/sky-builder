// What the tool remembers between visits (PLAN §15.2, §17.9). Pure: main.ts does the reading and writing, so this
// can be tested without a browser. A broken or older entry falls back to the defaults, field by field.

import { PANO_FACE_RANGE, PANO_LEFT_BEARING_DEG, PANO_LEFT_BEARING_RANGE, PLAY_SPEEDS, RANGES, TICKS_PER_DAY } from './constants.ts';
import { parseSky3, serializeSky3 } from './json.ts';
import { clamp, clampHero, clampPitch, mod, wrapDeg180 } from './math.ts';
import type { FadeKey, HeroParams, PreviewMode, Sky3Json, SkyTab, SkyType, TemplateLayerRef, ViewState } from './schema.ts';
import { uniqueName } from './tabs.ts';

/** The localStorage key. A new layout gets a new version; the one before is read once, to move it over. */
export const SAVED_KEY = 'sky-builder/v2';
/** The single-sky layout from before sky tabs (decision 17.3.13). */
export const SAVED_KEY_V1 = 'sky-builder/v1';

/** The view as remembered: everything except "playing", which always starts paused. */
export type SavedView = Pick<ViewState, 'timeTicks' | 'ticksPerSecond' | 'fovDeg' | 'yawDeg' | 'pitchDeg' | 'showOverlay'>;

/** A sky's settings in a v1 entry: what became each tab's sky settings. */
export interface SavedSky {
  type: SkyType;
  /** null means the default for the panorama's width. */
  faceSize: number | null;
  leftBearingDeg: number;
}

export interface Session {
  hero: HeroParams;
  view: SavedView;
  /** The sky tabs, without their images (those are in IndexedDB). Empty: start from the template's layers. */
  tabs: SkyTab[];
  openTabId: string;
  previewMode: PreviewMode;
  /** An imported JSON that was still pinned, with the name it was imported from. */
  pinned: { json: Sky3Json; name: string } | null;
}

/** The session as text for localStorage. A pinned JSON is kept as its exact serialised bytes. */
export function toSaved(session: Session): string {
  const { hero, view, tabs, openTabId, previewMode, pinned } = session;
  return JSON.stringify({
    version: 2,
    hero,
    view,
    tabs,
    openTabId,
    previewMode,
    pinned: pinned && { name: pinned.name, json: serializeSky3(pinned.json) },
  });
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
/** A number field, or the fallback if it is missing or not a finite number. */
const num = (o: Obj, key: string, fallback: number): number => (isNum(o[key]) ? (o[key] as number) : fallback);

/** Parses the text as an entry of this version, or null. */
function entry(text: string | null, version: number): Obj | null {
  let raw: unknown;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
  return isObj(raw) && raw.version === version ? raw : null;
}

function readHero(raw: Obj, dh: HeroParams): HeroParams {
  const h = isObj(raw.hero) ? raw.hero : {};
  return clampHero({
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
}

function readView(raw: Obj, dv: SavedView): SavedView {
  const v = isObj(raw.view) ? raw.view : {};
  const speed = num(v, 'ticksPerSecond', dv.ticksPerSecond);
  return {
    timeTicks: mod(num(v, 'timeTicks', dv.timeTicks), TICKS_PER_DAY),
    ticksPerSecond: PLAY_SPEEDS.some((s) => s.ticksPerSecond === speed) ? speed : dv.ticksPerSecond,
    fovDeg: clamp(num(v, 'fovDeg', dv.fovDeg), RANGES.fovDeg.min, RANGES.fovDeg.max),
    yawDeg: wrapDeg180(num(v, 'yawDeg', dv.yawDeg)),
    pitchDeg: clampPitch(num(v, 'pitchDeg', dv.pitchDeg)),
    showOverlay: typeof v.showOverlay === 'boolean' ? v.showOverlay : dv.showOverlay,
  };
}

const DEFAULT_SKY: SavedSky = { type: 'auto', faceSize: null, leftBearingDeg: PANO_LEFT_BEARING_DEG };

function readSky(s: Obj, ds: SavedSky = DEFAULT_SKY): SavedSky {
  return {
    type: s.type === 'auto' || s.type === 'atlas' || s.type === 'panorama' ? s.type : ds.type,
    faceSize: isNum(s.faceSize) ? clamp(Math.round(s.faceSize), PANO_FACE_RANGE.min, PANO_FACE_RANGE.max) : ds.faceSize,
    leftBearingDeg: clamp(num(s, 'leftBearingDeg', ds.leftBearingDeg), PANO_LEFT_BEARING_RANGE.min, PANO_LEFT_BEARING_RANGE.max),
  };
}

/** A pinned JSON goes through the importer again, so a damaged entry is dropped rather than shown. */
function readPinned(raw: Obj): Session['pinned'] {
  if (isObj(raw.pinned) && typeof raw.pinned.json === 'string' && typeof raw.pinned.name === 'string') {
    const parsed = parseSky3(raw.pinned.json);
    if (parsed.ok) return { json: parsed.json, name: raw.pinned.name };
  }
  return null;
}

/** Keyframes with numeric ticks and alphas; alphas clamped as typed in. Odd ticks are kept, for the editor to flag. */
function readKeys(x: unknown): FadeKey[] {
  if (!Array.isArray(x)) return [];
  return x.filter((k): k is { tick: number; alpha: number } => isObj(k) && isNum(k.tick) && isNum(k.alpha))
    .map((k) => ({ tick: k.tick, alpha: clamp(k.alpha, 0, 1) }));
}

function readRef(x: unknown): TemplateLayerRef | null {
  if (!isObj(x) || typeof x.file !== 'string') return null;
  return {
    file: x.file,
    texturePath: typeof x.texturePath === 'string' ? x.texturePath : null,
    duration: isNum(x.duration) ? x.duration : TICKS_PER_DAY,
    keyFrames: readKeys(x.keyFrames),
  };
}

/** A tab, or null if it has no usable id or name; anything else that's broken takes its default. */
function readTab(x: unknown): SkyTab | null {
  if (!isObj(x) || typeof x.id !== 'string' || x.id === '' || typeof x.name !== 'string' || x.name.trim() === '') return null;
  const sky = isObj(x.sky) ? x.sky : {};
  return {
    id: x.id,
    name: x.name.trim(),
    include: typeof x.include === 'boolean' ? x.include : true,
    sky: { user: isObj(sky.user) && typeof sky.user.name === 'string' ? { name: sky.user.name } : null, ...readSky(sky) },
    keyFrames: readKeys(x.keyFrames),
    keyFramesEdited: x.keyFramesEdited === true,
    templateLayer: readRef(x.templateLayer),
  };
}

/** Reads what toSaved wrote. Anything missing or invalid takes the default, and values are clamped as if typed in. */
export function fromSaved(text: string | null, defaults: Session): Session {
  const raw = entry(text, 2);
  if (!raw) return defaults;

  const tabs: SkyTab[] = [];
  for (const x of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = readTab(x);
    if (!tab || tabs.some((t) => t.id === tab.id)) continue;
    tabs.push({ ...tab, name: uniqueName(tab.name, tabs.map((t) => t.name)) });
  }
  const openTabId = typeof raw.openTabId === 'string' && tabs.some((t) => t.id === raw.openTabId)
    ? raw.openTabId : tabs[0]?.id ?? defaults.openTabId;

  return {
    hero: readHero(raw, defaults.hero),
    view: readView(raw, defaults.view),
    tabs: tabs.length > 0 ? tabs : defaults.tabs,
    openTabId,
    previewMode: raw.previewMode === 'blend' || raw.previewMode === 'tab' ? raw.previewMode : defaults.previewMode,
    pinned: readPinned(raw),
  };
}

/**
 * Reads a v1 entry, from before sky tabs (decision 17.3.13): the hero, view and pinned JSON as they were, and
 * the single sky's settings, which main.ts gives the Day tab along with the stored image. Null if there is none.
 */
export function fromSavedV1(text: string | null, defaults: Session): { session: Session; sky: SavedSky } | null {
  const raw = entry(text, 1);
  if (!raw) return null;
  return {
    session: { ...defaults, hero: readHero(raw, defaults.hero), view: readView(raw, defaults.view), pinned: readPinned(raw) },
    sky: readSky(isObj(raw.sky) ? raw.sky : {}),
  };
}
