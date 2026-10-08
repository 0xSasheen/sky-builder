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
  fovDeg: number;
  yawDeg: number;
  pitchDeg: number;
  showOverlay: boolean;
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

export type WarningCode = 'k' | 'ak' | 'zenith' | 'outsideCell' | 'notCentred';

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
