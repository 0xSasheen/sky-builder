// Assemble a resource pack from a template (PLAN §16). Pure apart from fflate's zip code: it works on a map of
// file paths to bytes, so it is tested without a browser. (Java: think Map<String, byte[]>.)

import { unzipSync, zipSync, type Zippable } from 'fflate';
import { FIXED_JSON } from './constants.ts';
import { HERO_MCMETA, textureProblem } from './json.ts';
import type { FadeKey, SkyTab } from './schema.ts';
import { layerOutputs, tabNotes, textureIdFromPath } from './tabs.ts';

/** A pack's files: path inside the zip → bytes. */
export type PackFiles = Map<string, Uint8Array>;

export interface SkyLayer {
  /** The layer's JSON file, e.g. assets/nuit/sky/sky2_day.json. */
  file: string;
  /** Where its texture lives in the zip, e.g. assets/sasheen/textures/sky/day.png; null if it names none. */
  texturePath: string | null;
  /** The always-on layer (empty keyFrames) is the night sky; one that fades is the day sky. */
  role: 'night' | 'day';
  /** Its `properties.layer` (Nuit's default is 0), which sets the draw order. */
  layer: number;
  /** Its `fade.keyFrames`, sorted by tick. Entries Nuit couldn't read are left out. */
  keyFrames: FadeKey[];
  /** Its `fade.duration` (Nuit's default is 24000). */
  duration: number;
}

export interface TemplateInfo {
  /** The hero layer's JSON file: the template's own, or the default name if it has none. */
  heroLayerFile: string;
  /** The texture the template's hero layer used, if any. */
  oldHeroTexturePath: string | null;
  skyLayers: SkyLayer[];
  /** Nuit layers that are neither sky nor (the first) hero layer: copied as they are. */
  otherLayers: { file: string; type: string; layer: number }[];
  /** Reasons the template can't be used at all. */
  problems: string[];
  /** Things worth knowing that don't stop assembly. */
  warnings: string[];
}

const NUIT_LAYER = /^assets\/nuit\/sky\/[^/]+\.json$/;
const DEFAULT_HERO_LAYER = 'assets/nuit/sky/sky3_image.json';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

/** "namespace:path" → "assets/namespace/path", or null if the texture name isn't usable. */
export function texturePath(texture: string): string | null {
  if (textureProblem(texture) !== null) return null;
  const colon = texture.indexOf(':');
  return `assets/${texture.slice(0, colon)}/${texture.slice(colon + 1)}`;
}

/** The same rotation as the hero layer writes, so the hero stays put against this sky (BRIEF §2). */
function rotationMatches(rotation: unknown): boolean {
  if (!isObj(rotation)) return false;
  const axis = isObj(rotation.axis) ? Object.values(rotation.axis) : [];
  return rotation.speed === FIXED_JSON.speed
    && rotation.skyboxRotation === FIXED_JSON.skyboxRotation
    && axis.length === 1
    && JSON.stringify(axis[0]) === JSON.stringify(FIXED_JSON.axis);
}

/** A layer's `fade.keyFrames` ({"4000": 1.0, …}) as a list sorted by tick, skipping entries that aren't numbers. */
function readKeyFrames(keyFrames: unknown): FadeKey[] {
  if (!isObj(keyFrames)) return [];
  return Object.entries(keyFrames)
    .map(([tick, alpha]) => ({ tick: Number(tick), alpha }))
    .filter((k): k is FadeKey => Number.isFinite(k.tick) && typeof k.alpha === 'number')
    .sort((a, b) => a.tick - b.tick);
}

/** Reads a template's Nuit layers: which file is the hero layer, and where each sky layer's texture lives. */
export function readTemplate(files: PackFiles): TemplateInfo {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!files.has('pack.mcmeta')) problems.push('The template has no pack.mcmeta, so Minecraft would not list it.');

  const heroLayers: { file: string; texturePath: string | null; layer: number }[] = [];
  const skyLayers: SkyLayer[] = [];
  const otherLayers: TemplateInfo['otherLayers'] = [];
  for (const file of [...files.keys()].filter((p) => NUIT_LAYER.test(p)).sort()) {
    let layer: unknown;
    try {
      layer = JSON.parse(decoder.decode(files.get(file)));
    } catch {
      warnings.push(`${file} is not valid JSON, so it was copied as it is.`);
      continue;
    }
    if (!isObj(layer)) continue;
    const props = isObj(layer.properties) ? layer.properties : {};
    const layerValue = typeof props.layer === 'number' ? props.layer : 0;
    if (layer.type === 'nuit:multi-textured') {
      const entries = Array.isArray(layer.animatableTextures) ? layer.animatableTextures : [];
      const texture = isObj(entries[0]) && typeof entries[0].texture === 'string' ? entries[0].texture : '';
      heroLayers.push({ file, texturePath: texturePath(texture), layer: layerValue });
    } else if (layer.type === 'nuit:square-textured') {
      const texture = typeof layer.texture === 'string' ? layer.texture : '';
      // Nuit 26.2's Fade has no "alwaysOn" field (it is dropped when read): a layer is always on exactly
      // when its keyFrames are empty (AbstractSkybox.updateAlpha, PLAN §17.1).
      const fade = isObj(props.fade) ? props.fade : {};
      const alwaysOn = !isObj(fade.keyFrames) || Object.keys(fade.keyFrames).length === 0;
      skyLayers.push({
        file,
        texturePath: texturePath(texture),
        role: alwaysOn ? 'night' : 'day',
        layer: layerValue,
        keyFrames: readKeyFrames(fade.keyFrames),
        duration: typeof fade.duration === 'number' ? fade.duration : 24000,
      });
      if (!rotationMatches(props.rotation)) {
        warnings.push(`${file} turns differently from the hero layer (speed, axis or skyboxRotation), so the hero `
          + 'would drift against this sky.');
      }
      if ('blend' in layer) {
        warnings.push(`${file} has a top-level "blend", which Nuit 26.2 ignores; it draws with "normal" blending. `
          + 'An assembled pack leaves it out.');
      }
    } else {
      otherLayers.push({ file, type: typeof layer.type === 'string' ? layer.type : '(no type)', layer: layerValue });
    }
  }
  if (heroLayers.length + skyLayers.length === 0) problems.push('The template has no Nuit layers in assets/nuit/sky/.');
  if (heroLayers.length > 1) {
    warnings.push(`The template has ${heroLayers.length} hero layers; ${heroLayers[0].file} is replaced and the others are kept.`);
  }

  return {
    heroLayerFile: heroLayers[0]?.file ?? DEFAULT_HERO_LAYER,
    oldHeroTexturePath: heroLayers[0]?.texturePath ?? null,
    skyLayers,
    otherLayers: [...otherLayers, ...heroLayers.slice(1).map((h) => ({ file: h.file, type: 'nuit:multi-textured', layer: h.layer }))],
    problems,
    warnings,
  };
}

export type PackResult =
  | { ok: true; files: PackFiles; warnings: string[] }
  | { ok: false; problems: string[] };

export interface TabPackInputs {
  /** The exact sky3_image.json bytes the tool would export (serializeSky3), with the hero's layer from layerPlan. */
  jsonText: string;
  /** The hero's texture name from the JSON, e.g. "sasheen:textures/sky/hero.png". */
  texture: string;
  /** The hero image as PNG bytes. */
  heroPng: Uint8Array;
  tabs: readonly SkyTab[];
  /** Each tab's own sky as PNG bytes, by tab id, with its width (Nuit's atlases stay within 8192 px). */
  skyPngs: ReadonlyMap<string, { png: Uint8Array; width: number }>;
  /** The default skies (PLAN §17.6): the starter's night atlas for the base, its day atlas for the others. */
  defaultSky: { base: Uint8Array; other: Uint8Array };
  /** The JSON a new tab's layer starts from: the starter's day layer. */
  newLayerText: string;
}

/**
 * The new pack from sky tabs (PLAN §17.8): the template with each included tab's layer file and texture written,
 * every template sky layer that no included tab writes removed (with its texture, unless something else still
 * uses it), and the hero layer, image and .mcmeta put in as before. Everything else is copied unchanged.
 */
export function assembleTabs(template: PackFiles, inputs: TabPackInputs): PackResult {
  const info = readTemplate(template);
  const problems = [...info.problems];
  const heroPath = texturePath(inputs.texture);
  if (heroPath === null) problems.push(`The texture "${inputs.texture}" can't be placed in a pack: ${textureProblem(inputs.texture)}`);
  if (problems.length > 0) return { ok: false, problems };

  const warnings = [...info.warnings, ...tabNotes(inputs.tabs, template).map((n) => n.text)];
  const files: PackFiles = new Map(template);
  const outputs = layerOutputs(inputs.tabs, template, { heroTexturePath: heroPath, newLayerText: inputs.newLayerText });
  const written = new Set(outputs.map((o) => o.jsonPath));

  // Template sky layers no included tab writes: excluded or deleted tabs (decision 17.3.7).
  const dropped = info.skyLayers.filter((l) => !written.has(l.file));
  for (const layer of dropped) files.delete(layer.file);
  if (dropped.length > 0) {
    warnings.push(`Left out, as their tabs are not included: ${dropped.map((l) => l.file).join(', ')}.`);
  }

  for (const out of outputs) {
    files.set(out.jsonPath, encoder.encode(out.text));
    if (out.textureFrom === 'user') {
      const sky = inputs.skyPngs.get(out.tabId);
      if (sky) {
        files.set(out.texturePath, sky.png);
        if (sky.width > 8192) {
          warnings.push(`${out.texturePath} is ${sky.width} px wide; Nuit packs usually stay within 8192 px, the limit of many GPUs.`);
        }
      } else {
        files.set(out.texturePath, out.base ? inputs.defaultSky.base : inputs.defaultSky.other);
        warnings.push(`The sky for ${out.texturePath} isn't loaded yet, so the default sky went in.`);
      }
    } else if (out.textureFrom === 'default') {
      files.set(out.texturePath, out.base ? inputs.defaultSky.base : inputs.defaultSky.other);
    }
  }

  // A dropped layer's texture goes too, unless the hero, a written layer, or another Nuit layer still names it.
  for (const layer of dropped) {
    const path = layer.texturePath;
    if (path === null || !files.has(path) || path === heroPath || outputs.some((o) => o.texturePath === path)) continue;
    const id = `"${textureIdFromPath(path)}"`;
    const stillUsed = [...files].some(([p, bytes]) => NUIT_LAYER.test(p) && p !== info.heroLayerFile && decoder.decode(bytes).includes(id));
    if (!stillUsed) files.delete(path);
  }

  const heroLayer = outputs.length + 1;
  for (const other of info.otherLayers) {
    if (other.layer >= 1 && other.layer <= heroLayer) {
      warnings.push(`${other.file} (${other.type}) is layer ${other.layer}, among the sky and hero layers (1 to ${heroLayer}); `
        + 'it was copied as it is, so check the draw order.');
    }
  }

  files.set(info.heroLayerFile, encoder.encode(inputs.jsonText));
  files.set(heroPath!, inputs.heroPng);
  files.set(`${heroPath}.mcmeta`, encoder.encode(HERO_MCMETA));
  if (info.oldHeroTexturePath && info.oldHeroTexturePath !== heroPath && template.has(info.oldHeroTexturePath)) {
    warnings.push(`The template's hero texture ${info.oldHeroTexturePath} is no longer used, and was left in the pack.`);
  }
  return { ok: true, files, warnings };
}

/** Whether bytes are a PNG file, by its 8-byte signature. Minecraft only loads PNG textures. */
export function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= 8 && signature.every((b, i) => bytes[i] === b);
}

/** Whether a dropped file is a zip, by its type or its name (PLAN §16.1). */
export function isZipFile(name: string, mimeType: string): boolean {
  return mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed' || /\.zip$/i.test(name);
}

// --- Zip files (fflate) ------------------------------------------------------------------------

/** Reads a zip into a file map. Folders are dropped; only files matter. Throws if it isn't a zip. */
export function readZip(bytes: Uint8Array): PackFiles {
  const entries = unzipSync(bytes);
  return new Map(Object.entries(entries).filter(([path]) => !path.endsWith('/')));
}

/**
 * Writes a file map as a zip. PNGs are stored as they are (they are compressed already); everything else is
 * deflated. Paths are sorted, so the same pack always gives the same file order.
 */
export function writeZip(files: PackFiles): Uint8Array {
  const zippable: Zippable = {};
  for (const path of [...files.keys()].sort()) {
    zippable[path] = [files.get(path)!, { level: path.toLowerCase().endsWith('.png') ? 0 : 6 }];
  }
  return zipSync(zippable);
}
