// Types for sky3_image.json (BRIEF §5) and the tool's state (PLAN §3).
// Types only: this file emits no code.

export type Vec3 = [number, number, number];
/** Keys are tick numbers as strings, e.g. {"0": [22.47, 0, 0]}. */
export type TickMap<T> = Record<string, T>;
export type BlendMode = 'normal' | 'alpha' | 'add' | 'subtract' | 'multiply'
                      | 'screen' | 'burn' | 'dodge' | 'replace' | 'disable';

export interface UvRange { minU: number; minV: number; maxU: number; maxV: number; }

export interface AnimatableTexture {
  texture: string;
  uvRange: UvRange;
  gridColumns: 1;
  gridRows: 1;
}

export interface Sky3Json {
  schemaVersion: 1;
  type: 'nuit:multi-textured';
  properties: {
    layer: number;
    blend: BlendMode;
    fade: { duration: 24000; keyFrames: TickMap<number> };
    rotation: {
      speed: number;
      mapping: TickMap<Vec3>;
      axis: TickMap<Vec3>;
      skyboxRotation: boolean;
    };
    sunSkyTint: boolean;
    visibleUnderwater: boolean;
  };
  conditions: { worlds: { entries: string[] } };
  animatableTextures: [AnimatableTexture];
}

// --- Cube faces (BRIEF §3) ----------------------------------------------------

export type FaceName = 'bottom' | 'top' | 'south' | 'west' | 'north' | 'east';

/** A point at face coordinates (s, t) ∈ [−1, 1]² lies at centre + s·right + t·up. */
export interface FaceDef {
  name: FaceName;
  /** Atlas cell: column 0–2 left to right, row 0–1 top to bottom. */
  col: number;
  row: number;
  centre: Vec3;
  right: Vec3;
  up: Vec3;
}

// --- Tool state --------------------------------------------------------------

export type HeroMode = 'tilted' | 'wall';

/** What the sliders edit. Never reaches the renderer directly (rule 3). */
export interface HeroParams {
  mode: HeroMode;
  imageW: number;
  imageH: number;
  /** Half-height on the face, tan(β/2). Canonical size; β is derived. Tilted mode only. */
  k: number;
  bottomDeg: number;
  /** Top edge on the face, t_t. Wall mode only. */
  wallTopT: number;
  /** Raw mapping Y; positive turns the hero toward west. */
  mappingYDeg: number;
  texture: string;
  layer: number;
}

/** Preview only; never reaches the JSON. */
export interface ViewState {
  timeTicks: number;
  playing: boolean;
  /** How fast Play moves the time (PLAY_SPEEDS). */
  ticksPerSecond: number;
  /** Vertical field of view, as in Minecraft's FOV setting. */
  fovDeg: number;
  /** Compass bearing of the view, clockwise from north (east = +90), in (−180, 180]. */
  yawDeg: number;
  /** Elevation of the view; positive looks up. Clamped to ±PITCH_LIMIT_DEG. */
  pitchDeg: number;
  showOverlay: boolean;
}

/** The atlas cell grid, or why the image can't be one (BRIEF §8). */
export type AtlasLayout = { ok: true; faceSize: number } | { ok: false; message: string };

/** One fade keyframe of a sky layer: at `tick` the layer's alpha is `alpha` (PLAN §17.2). */
export interface FadeKey { tick: number; alpha: number }

// --- Sky tabs (PLAN §17.4) -----------------------------------------------------

/** A tab's sky settings. The image itself is kept elsewhere (IndexedDB slot "sky:<tab id>"). */
export interface TabSky {
  /** The file the user chose for this tab, if any; without one the tab shows the template's texture or the default. */
  user: { name: string } | null;
  type: SkyType;
  /** For a panorama: null means the default for its width. */
  faceSize: number | null;
  leftBearingDeg: number;
}

/** The template layer a tab writes (PLAN §17.4). */
export interface TemplateLayerRef {
  /** Its JSON file, e.g. assets/nuit/sky/sky2_day.json. */
  file: string;
  /** Its texture in the zip, or null if it names none Minecraft could use. */
  texturePath: string | null;
  /** Its fade duration and keyframes as the template has them, for the "Template's" button. */
  duration: number;
  keyFrames: FadeKey[];
}

/** One sky layer of the pack, as a tab (PLAN §17.4). Tab order is layer order. */
export interface SkyTab {
  /** Stable and never shown. */
  id: string;
  /** Unique (case-insensitive) and non-empty. */
  name: string;
  /** Whether the layer goes into the pack. The first included tab is the always-on base. */
  include: boolean;
  sky: TabSky;
  keyFrames: FadeKey[];
  /** True once the user edits the keyframes; until then a newly loaded template's keyframes replace them. */
  keyFramesEdited: boolean;
  /** Null for a tab the template doesn't have: it becomes a new layer file. */
  templateLayer: TemplateLayerRef | null;
}

/** What the preview shows (PLAN §17.5). */
export type PreviewMode = 'blend' | 'tab';

/** Which sky layer(s) of a pack template the current sky replaces (PLAN §16). Day by default. */
export type SkyTarget = 'day' | 'night' | 'both' | 'none';

/** What a sky file is. 'auto' (the upload default) decides from the shape: 3:2 is an atlas, 2:1 a panorama. */
export type SkyKind = 'atlas' | 'panorama';
export type SkyType = 'auto' | SkyKind;

/** Raw pixels, laid out like the browser's ImageData: RGBA, 8 bits each, rows from the top. */
export interface RgbaImage {
  width: number;
  height: number;
  /** Backed by a plain ArrayBuffer, as `new ImageData(data, …)` requires. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface AppState {
  hero: HeroParams;
  view: ViewState;
  /** Current output; pinned exactly as loaded after an import. */
  json: Sky3Json;
  /** True from an import until the next slider change. */
  pinned: boolean;
}

// --- Math results ------------------------------------------------------------

/** A rectangle on the North face in face coordinates; s0 < s1 (left, right), t0 < t1 (bottom, top). */
export interface FaceRect { s0: number; s1: number; t0: number; t1: number; }

export type WarningCode = 'empty' | 'k' | 'ak' | 'zenith' | 'outsideCell' | 'notCentred';

/** The part of the hero Nuit draws on one cube face (BRIEF §4.1). */
export interface HeroPiece {
  face: FaceName;
  /** Where on the face, in face coordinates. */
  rect: FaceRect;
  /** Which part of the hero image, as fractions: u left to right, v top to bottom (V = 0 is the top). */
  tex: { u0: number; u1: number; v0: number; v1: number };
}

export interface Warning {
  code: WarningCode;
  /** 'warn' = amber (past 0.95), 'error' = red (outside the cell or over the zenith). */
  level: 'warn' | 'error';
  message: string;
}

export interface Readouts {
  rect: FaceRect;
  aspect: number;
  /** Half-height in face units, (t1 − t0)/2. */
  k: number;
  /** Half-width in face units, (s1 − s0)/2. */
  ak: number;
  heightDeg: number;
  widthDeg: number;
  topDeg: number;
  bottomDeg: number;
  /** Distance to each limit; negative means the limit is broken. */
  margins: { k: number; ak: number; zenithDeg: number };
  warnings: Warning[];
}
