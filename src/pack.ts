// Assemble a resource pack from a template (PLAN §16). Pure apart from fflate's zip code: it works on a map of
// file paths to bytes, so it is tested without a browser. (Java: think Map<String, byte[]>.)

import { unzipSync, zipSync, type Zippable } from 'fflate';
import { FIXED_JSON } from './constants.ts';
import { HERO_MCMETA, textureProblem } from './json.ts';
import type { SkyTarget } from './schema.ts';

/** A pack's files: path inside the zip → bytes. */
export type PackFiles = Map<string, Uint8Array>;

export interface SkyLayer {
  /** The layer's JSON file, e.g. assets/nuit/sky/sky2_day.json. */
  file: string;
  /** Where its texture lives in the zip, e.g. assets/sasheen/textures/sky/day.png; null if it names none. */
  texturePath: string | null;
  /** The always-on layer is the night sky; one that fades is the day sky. */
  role: 'night' | 'day';
}

export interface TemplateInfo {
  /** The hero layer's JSON file: the template's own, or the default name if it has none. */
  heroLayerFile: string;
  /** The texture the template's hero layer used, if any. */
  oldHeroTexturePath: string | null;
  skyLayers: SkyLayer[];
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

/** Reads a template's Nuit layers: which file is the hero layer, and where each sky layer's texture lives. */
export function readTemplate(files: PackFiles): TemplateInfo {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!files.has('pack.mcmeta')) problems.push('The template has no pack.mcmeta, so Minecraft would not list it.');

  const heroLayers: { file: string; texturePath: string | null }[] = [];
  const skyLayers: SkyLayer[] = [];
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
    if (layer.type === 'nuit:multi-textured') {
      const entries = Array.isArray(layer.animatableTextures) ? layer.animatableTextures : [];
      const texture = isObj(entries[0]) && typeof entries[0].texture === 'string' ? entries[0].texture : '';
      heroLayers.push({ file, texturePath: texturePath(texture) });
    } else if (layer.type === 'nuit:square-textured') {
      const texture = typeof layer.texture === 'string' ? layer.texture : '';
      const fade = isObj(props.fade) ? props.fade : {};
      skyLayers.push({ file, texturePath: texturePath(texture), role: fade.alwaysOn === true ? 'night' : 'day' });
      if (!rotationMatches(props.rotation)) {
        warnings.push(`${file} turns differently from the hero layer (speed, axis or skyboxRotation), so the hero `
          + 'would drift against this sky.');
      }
      if ('blend' in layer) {
        warnings.push(`${file} has a top-level "blend", which Nuit 26.2 ignores; it draws with "normal" blending.`);
      }
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
    problems,
    warnings,
  };
}

export interface PackInputs {
  /** The exact sky3_image.json bytes the tool would export (serializeSky3). */
  jsonText: string;
  /** The hero's texture name from the JSON, e.g. "sasheen:textures/sky/hero.png". */
  texture: string;
  /** The hero image as PNG bytes. */
  heroPng: Uint8Array;
  /** The current sky atlas as PNG bytes, and its width (Nuit's atlases stay within 8192 px). */
  skyPng: Uint8Array | null;
  skyWidth: number;
  skyTarget: SkyTarget;
}

export type PackResult =
  | { ok: true; files: PackFiles; warnings: string[] }
  | { ok: false; problems: string[] };

/**
 * The new pack: the template with the hero layer's JSON, the hero image and its .mcmeta, and the sky texture(s)
 * replaced or added. Everything else is copied unchanged.
 */
export function assemblePack(template: PackFiles, inputs: PackInputs): PackResult {
  const info = readTemplate(template);
  const problems = [...info.problems];
  const heroPath = texturePath(inputs.texture);
  if (heroPath === null) problems.push(`The texture "${inputs.texture}" can't be placed in a pack: ${textureProblem(inputs.texture)}`);
  if (problems.length > 0) return { ok: false, problems };

  const warnings = [...info.warnings];
  const files: PackFiles = new Map(template);
  files.set(info.heroLayerFile, encoder.encode(inputs.jsonText));
  files.set(heroPath!, inputs.heroPng);
  files.set(`${heroPath}.mcmeta`, encoder.encode(HERO_MCMETA));
  if (info.oldHeroTexturePath && info.oldHeroTexturePath !== heroPath && template.has(info.oldHeroTexturePath)) {
    warnings.push(`The template's hero texture ${info.oldHeroTexturePath} is no longer used, and was left in the pack.`);
  }

  if (inputs.skyTarget !== 'none') {
    const targets = info.skyLayers.filter((l) => inputs.skyTarget === 'both' || l.role === inputs.skyTarget);
    if (!inputs.skyPng) {
      warnings.push('No sky is loaded, so the template\'s sky textures were kept.');
    } else if (targets.length === 0) {
      warnings.push(`The template has no ${inputs.skyTarget} sky layer, so the sky was not added.`);
    } else {
      for (const layer of targets) {
        if (layer.texturePath) files.set(layer.texturePath, inputs.skyPng);
        else warnings.push(`${layer.file} names no usable texture, so the sky was not added to it.`);
      }
      if (inputs.skyWidth > 8192) {
        warnings.push(`The sky atlas is ${inputs.skyWidth} px wide; Nuit packs usually stay within 8192 px, the limit of many GPUs.`);
      }
    }
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
