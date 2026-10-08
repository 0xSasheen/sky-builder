// Build, serialise and import sky3_image.json (BRIEF §5, PLAN §5).

import { DEFAULTS, FIXED_JSON } from './constants.ts';
import { classifyUv, recoverParams, solveHero } from './math.ts';
import type { HeroParams, Sky3Json, TickMap, UvRange, Vec3 } from './schema.ts';

export const SKY3_FILENAME = 'sky3_image.json';

/** Same bytes as reference/pack-example/.../hero.png.mcmeta. */
export const HERO_MCMETA = '{\n  "texture": {\n    "blur": true,\n    "clamp": true\n  }\n}\n';

/** "sasheen:textures/sky/hero.png" → "hero.png.mcmeta" */
export function mcmetaFileName(texture: string): string {
  return `${texture.split(/[/:]/).pop()}.mcmeta`;
}

// --- Build ---------------------------------------------------------------------

/** Assembles a full JSON object from the editable fields plus the fixed ones. */
export function makeSky3(uv: UvRange, mapping: Vec3, texture: string, layer: number): Sky3Json {
  return {
    schemaVersion: FIXED_JSON.schemaVersion,
    type: FIXED_JSON.type,
    properties: {
      layer,
      blend: FIXED_JSON.blend,
      fade: { duration: FIXED_JSON.fadeDuration, keyFrames: {} },
      rotation: {
        speed: FIXED_JSON.speed,
        mapping: { '0': mapping },
        axis: { '0': [...FIXED_JSON.axis] },
        skyboxRotation: FIXED_JSON.skyboxRotation,
      },
      sunSkyTint: FIXED_JSON.sunSkyTint,
      visibleUnderwater: FIXED_JSON.visibleUnderwater,
    },
    conditions: { worlds: { entries: [...FIXED_JSON.worlds] } },
    animatableTextures: [{ texture, uvRange: { ...uv }, gridColumns: 1, gridRows: 1 }],
  };
}

/** Sliders → JSON, via the rounded values from solveHero. */
export function buildSky3(hero: HeroParams): Sky3Json {
  const { uv, mapping } = solveHero(hero);
  return makeSky3(uv, mapping, hero.texture, hero.layer);
}

// --- Serialise -------------------------------------------------------------------
// JSON.stringify can't produce §5: it prints 1.0 as 1, and §5 mixes inline and multi-line objects.

/** Shortest round-trip form, with ".0" appended to integers: 22.47 → "22.47", 30 → "30.0". */
export function fmtFloat(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`Cannot write ${x} to JSON`);
  const s = String(x + 0); // + 0 turns −0 into 0
  return /[.e]/.test(s) ? s : `${s}.0`;
}

function fmtInt(x: number): string {
  if (!Number.isInteger(x)) throw new RangeError(`Expected an integer, got ${x}`);
  return String(x);
}

const fmtStr = (s: string): string => JSON.stringify(s);
const fmtVec3 = (v: Vec3): string => `[${v.map(fmtFloat).join(', ')}]`;

/** Inline map: {} or {"0": [22.47, 0.0, 0.0]} */
function fmtTickMap<T>(map: TickMap<T>, fmtValue: (v: T) => string): string {
  const entries = Object.entries(map).map(([k, v]) => `${fmtStr(k)}: ${fmtValue(v)}`);
  return `{${entries.join(', ')}}`;
}

/** Writes the exact layout of BRIEF §5, ending with a single newline. */
export function serializeSky3(json: Sky3Json): string {
  const p = json.properties;
  const r = p.rotation;
  const t = json.animatableTextures[0];
  const uv = t.uvRange;
  return [
    '{',
    `  "schemaVersion": ${fmtInt(json.schemaVersion)},`,
    `  "type": ${fmtStr(json.type)},`,
    '  "properties": {',
    `    "layer": ${fmtInt(p.layer)},`,
    `    "blend": ${fmtStr(p.blend)},`,
    `    "fade": { "duration": ${fmtInt(p.fade.duration)}, "keyFrames": ${fmtTickMap(p.fade.keyFrames, fmtFloat)} },`,
    '    "rotation": {',
    `      "speed": ${fmtFloat(r.speed)},`,
    `      "mapping": ${fmtTickMap(r.mapping, fmtVec3)},`,
    `      "axis": ${fmtTickMap(r.axis, fmtVec3)},`,
    `      "skyboxRotation": ${r.skyboxRotation}`,
    '    },',
    `    "sunSkyTint": ${p.sunSkyTint},`,
    `    "visibleUnderwater": ${p.visibleUnderwater}`,
    '  },',
    '  "conditions": {',
    `    "worlds": {"entries": [${json.conditions.worlds.entries.map(fmtStr).join(', ')}]}`,
    '  },',
    '  "animatableTextures": [',
    '    {',
    `      "texture": ${fmtStr(t.texture)},`,
    `      "uvRange": {"minU": ${fmtFloat(uv.minU)}, "minV": ${fmtFloat(uv.minV)}, "maxU": ${fmtFloat(uv.maxU)}, "maxV": ${fmtFloat(uv.maxV)}},`,
    `      "gridColumns": ${fmtInt(t.gridColumns)},`,
    `      "gridRows": ${fmtInt(t.gridRows)}`,
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n');
}

// --- Import ------------------------------------------------------------------------

export type ParseResult =
  | {
      ok: true;
      /** Normalised to the fixed fields; uvRange and mapping kept exactly as loaded (pinned). */
      json: Sky3Json;
      /** Slider values to show (§6.3). Has no `mode` when the uvRange fits neither mode. */
      recovered: Partial<HeroParams>;
      /** Everything export will change or drop. */
      warnings: string[];
    }
  | { ok: false; errors: string[] };

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const show = (x: unknown): string => (x === undefined ? 'missing' : JSON.stringify(x));

const ROOT_KEYS = ['schemaVersion', 'type', 'properties', 'conditions', 'animatableTextures', 'blend'];
const PROPERTY_KEYS = ['layer', 'blend', 'fade', 'rotation', 'sunSkyTint', 'visibleUnderwater'];
/** Rounded uvRange values may sit just outside the cell edge (4 dp rounding is ±5e-5). */
const CELL_TOLERANCE = 1e-4;

/** Reads an existing sky3_image.json. Collects every problem instead of stopping at the first. */
export function parseSky3(text: string): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`] };
  }
  if (!isObj(root)) return { ok: false, errors: ['The file must contain a JSON object.'] };
  if (root.type !== FIXED_JSON.type) {
    return { ok: false, errors: [`"type" is ${show(root.type)}; only "${FIXED_JSON.type}" can be imported.`] };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  /** Warns when a fixed field differs from what export writes. Compares by JSON text. */
  const expectFixed = (label: string, actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      warnings.push(`"${label}" is ${show(actual)}; export writes ${JSON.stringify(expected)}.`);
    }
  };

  const extraRoot = Object.keys(root).filter((k) => !ROOT_KEYS.includes(k));
  const props = isObj(root.properties) ? root.properties : {};
  const extraProps = Object.keys(props).filter((k) => !PROPERTY_KEYS.includes(k)).map((k) => `properties.${k}`);
  if (extraRoot.length + extraProps.length > 0) {
    warnings.push(`Export drops these fields: ${[...extraRoot, ...extraProps].join(', ')}.`);
  }
  if ('blend' in root) {
    warnings.push('A top-level "blend" is ignored by Nuit 26.2; export writes "properties.blend" instead.');
  }

  expectFixed('schemaVersion', root.schemaVersion, FIXED_JSON.schemaVersion);
  expectFixed('properties.blend', props.blend, FIXED_JSON.blend);
  const fade = isObj(props.fade) ? props.fade : {};
  expectFixed('properties.fade.duration', fade.duration, FIXED_JSON.fadeDuration);
  expectFixed('properties.fade.keyFrames', fade.keyFrames, {});
  const rotation = isObj(props.rotation) ? props.rotation : {};
  expectFixed('rotation.speed', rotation.speed, FIXED_JSON.speed);
  expectFixed('rotation.skyboxRotation', rotation.skyboxRotation, FIXED_JSON.skyboxRotation);
  expectFixed('properties.sunSkyTint', props.sunSkyTint, FIXED_JSON.sunSkyTint);
  expectFixed('properties.visibleUnderwater', props.visibleUnderwater, FIXED_JSON.visibleUnderwater);
  expectFixed('conditions', root.conditions, { worlds: { entries: FIXED_JSON.worlds } });

  // axis: without a keyframe Nuit skips the daily spin entirely (PLAN §1.2).
  if (!isObj(rotation.axis) || Object.keys(rotation.axis).length === 0) {
    warnings.push('"rotation.axis" is missing, so in game this layer would not spin with the sky. Export adds it.');
  } else {
    expectFixed('rotation.axis', rotation.axis, { '0': FIXED_JSON.axis });
  }

  // layer (editable)
  let layer: number = DEFAULTS.layer;
  if (typeof props.layer === 'number' && Number.isInteger(props.layer)) layer = props.layer;
  else warnings.push(`"properties.layer" is ${show(props.layer)}; using ${DEFAULTS.layer}.`);

  // mapping (editable: X and Y)
  let mapping: Vec3 = [0, 0, 0];
  const mappingKeys = isObj(rotation.mapping) ? Object.keys(rotation.mapping) : [];
  if (mappingKeys.length === 0) {
    warnings.push('"rotation.mapping" has no keyframe; using [0.0, 0.0, 0.0].');
  } else {
    const key = mappingKeys.includes('0') ? '0' : mappingKeys[0];
    if (mappingKeys.length > 1) warnings.push(`"rotation.mapping" has ${mappingKeys.length} keyframes; only "${key}" is kept.`);
    const value = (rotation.mapping as Obj)[key];
    if (Array.isArray(value) && value.length === 3 && value.every(isNum)) {
      if (value[2] !== 0) warnings.push(`Mapping Z is ${value[2]}; export writes 0.0.`);
      mapping = [value[0], value[1], 0];
    } else {
      errors.push(`"rotation.mapping" keyframe "${key}" must be three numbers, got ${show(value)}.`);
    }
  }

  // the texture entry (editable: texture and uvRange)
  const textures: unknown[] = Array.isArray(root.animatableTextures) ? root.animatableTextures : [];
  const entry = textures[0];
  if (!isObj(entry)) {
    errors.push('"animatableTextures" must contain one texture entry.');
    return { ok: false, errors };
  }
  if (textures.length > 1) warnings.push(`"animatableTextures" has ${textures.length} entries; only the first is kept.`);
  expectFixed('gridColumns', entry.gridColumns, 1);
  expectFixed('gridRows', entry.gridRows, 1);

  const texture = typeof entry.texture === 'string' ? entry.texture : '';
  if (texture === '') errors.push(`"texture" must be a non-empty string, got ${show(entry.texture)}.`);

  const uvObj = isObj(entry.uvRange) ? entry.uvRange : {};
  const { minU, minV, maxU, maxV } = uvObj;
  if (!isNum(minU) || !isNum(minV) || !isNum(maxU) || !isNum(maxV)) {
    errors.push(`"uvRange" must have numeric minU, minV, maxU and maxV, got ${show(entry.uvRange)}.`);
    return { ok: false, errors };
  }
  const uv: UvRange = { minU, minV, maxU, maxV };
  if (!(minU < maxU && minV < maxV)) {
    errors.push(`"uvRange" is empty or reversed: ${show(entry.uvRange)}.`);
  } else if (minU < 1 / 3 - CELL_TOLERANCE || maxU > 2 / 3 + CELL_TOLERANCE
          || minV < 1 / 2 - CELL_TOLERANCE || maxV > 1 + CELL_TOLERANCE) {
    errors.push('"uvRange" is not inside the North cell (u from 0.3333 to 0.6667, v from 0.5 to 1); '
              + 'Nuit would split the image across faces.');
  }

  if (errors.length > 0) return { ok: false, errors };

  if (classifyUv(uv, mapping[0]) === 'custom') {
    warnings.push('This uvRange matches neither tilted nor wall mode. The preview shows it as is; '
                + 'moving a size or position slider replaces it.');
  }
  return {
    ok: true,
    json: makeSky3(uv, mapping, texture, layer),
    recovered: { ...recoverParams(uv, mapping), texture, layer },
    warnings,
  };
}
