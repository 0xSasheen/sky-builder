// Sky tabs (PLAN §17.4): one tab per sky layer of the pack, in layer order. The first included tab is the
// always-on base; the others fade over it by their keyframes. Pure: no DOM or Three.js, so vitest drives it.
// (Java: a class of static methods over plain records.)

import { DEFAULTS, PANO_LEFT_BEARING_DEG, TICKS_PER_DAY } from './constants.ts';
import type { PackFiles, SkyLayer } from './pack.ts';
import type { FadeKey, SkyTab, TemplateLayerRef } from './schema.ts';

/** Makes a fresh tab id. Passed in, so these functions stay pure and tests can count. */
export type NewId = () => string;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const decoder = new TextDecoder();

// --- Names ----------------------------------------------------------------------------------

/** A tab name from a layer file: sky2_day.json → "Day", sky4_late_sunset.json → "Late sunset", sky1.json → "Layer 1". */
export function tabNameFromFile(file: string, layer: number): string {
  const base = file.slice(file.lastIndexOf('/') + 1)
    .replace(/\.json$/i, '')
    .replace(/^sky\d*[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return base === '' ? `Layer ${layer}` : base[0].toUpperCase() + base.slice(1);
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The name, or the name with " 2", " 3"… if a tab already has it (names are compared ignoring case). */
export function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.some((t) => sameName(t, name))) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.some((t) => sameName(t, candidate))) return candidate;
  }
}

/** The name for a tab added with "+": "Sky 3", "Sky 4"… */
export function nextTabName(tabs: readonly SkyTab[]): string {
  return uniqueName(`Sky ${tabs.length + 1}`, tabs.map((t) => t.name));
}

/** Why a tab can't be called this, or null if it can. */
export function tabNameProblem(name: string, tabs: readonly SkyTab[], tabId: string): string | null {
  if (name.trim() === '') return 'A tab needs a name.';
  if (tabs.some((t) => t.id !== tabId && sameName(t.name, name))) return `Another tab is already called "${name.trim()}".`;
  return null;
}

/** A file-safe name for a new layer's files: lower case, spaces to "_", only a–z, 0–9, "_" and "-". */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
}

// --- Making and merging tabs ----------------------------------------------------------------------

/** A tab with only the essentials: no sky, no keyframes, included, and the default sky settings. */
export function newTab(id: string, name: string): SkyTab {
  return {
    id,
    name,
    include: true,
    sky: { user: null, type: 'auto', faceSize: null, leftBearingDeg: PANO_LEFT_BEARING_DEG },
    keyFrames: [],
    keyFramesEdited: false,
    templateLayer: null,
  };
}

function refFrom(layer: SkyLayer): TemplateLayerRef {
  return {
    file: layer.file,
    texturePath: layer.texturePath,
    duration: layer.duration,
    keyFrames: layer.keyFrames.map((k) => ({ ...k })),
  };
}

/**
 * Links tabs to a template's sky layers (decision 17.3.6). Each layer goes to the tab that wrote the same file
 * before, or else to a tab with the layer's name (sky2_day.json → "Day"). A linked tab takes the layer's
 * keyframes unless the user has edited its own; its sky, name and Include stay as they are. Tabs left without a
 * layer become new layers. With `addMissing`, each layer no tab took becomes a new tab at the end, in layer
 * order; without it (restoring a session), they are left out, so a deleted tab doesn't come back.
 */
export function mergeTemplate(
  tabs: readonly SkyTab[], skyLayers: readonly SkyLayer[], newId: NewId, options: { addMissing: boolean },
): SkyTab[] {
  const result = tabs.map((t) => ({ ...t, templateLayer: null as TemplateLayerRef | null }));
  const linked = new Set<number>();
  const layers = [...skyLayers].sort((a, b) => a.layer - b.layer || a.file.localeCompare(b.file));
  const link = (i: number, layer: SkyLayer): void => {
    const tab = result[i];
    tab.templateLayer = refFrom(layer);
    if (!tab.keyFramesEdited) tab.keyFrames = layer.keyFrames.map((k) => ({ ...k }));
    linked.add(i);
  };

  const unmatched: SkyLayer[] = [];
  for (const layer of layers) {
    const i = tabs.findIndex((t, j) => !linked.has(j) && t.templateLayer?.file === layer.file);
    if (i >= 0) link(i, layer);
    else unmatched.push(layer);
  }
  const missing: SkyLayer[] = [];
  for (const layer of unmatched) {
    const name = tabNameFromFile(layer.file, layer.layer);
    const i = result.findIndex((t, j) => !linked.has(j) && sameName(t.name, name));
    if (i >= 0) link(i, layer);
    else missing.push(layer);
  }
  if (options.addMissing) {
    for (const layer of missing) {
      const tab = newTab(newId(), uniqueName(tabNameFromFile(layer.file, layer.layer), result.map((t) => t.name)));
      result.push(tab);
      link(result.length - 1, layer);
    }
  }
  return result;
}

// --- Layers -------------------------------------------------------------------------------------

export interface PlannedLayer {
  tab: SkyTab;
  /** Nuit's `layer` value: 1, 2, … in tab order. */
  layer: number;
  /** The first included tab: always on, written with empty keyframes. */
  base: boolean;
}

/** The included tabs as layers 1…m in tab order, and the hero's layer m + 1 (decision 17.3.3). */
export function layerPlan(tabs: readonly SkyTab[]): { layers: PlannedLayer[]; heroLayer: number } {
  const layers = tabs.filter((t) => t.include).map((tab, i) => ({ tab, layer: i + 1, base: i === 0 }));
  return { layers, heroLayer: layers.length + 1 };
}

/** The keyframes a layer's file gets, and the preview uses: none for the base, which is always on. */
export function effectiveKeyFrames(planned: PlannedLayer): FadeKey[] {
  return planned.base ? [] : planned.tab.keyFrames;
}

/** Rows Nuit can't read (red): a tick that isn't a whole number in [0, 24000), or one used twice. */
export function keyFrameProblems(keys: readonly FadeKey[]): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = [];
  keys.forEach((k, index) => {
    if (!Number.isInteger(k.tick) || k.tick < 0 || k.tick >= TICKS_PER_DAY) {
      problems.push({ index, message: `Tick ${k.tick} must be a whole number from 0 to ${TICKS_PER_DAY - 1}.` });
    } else if (keys.findIndex((other) => other.tick === k.tick) !== index) {
      problems.push({ index, message: `Tick ${k.tick} is used twice.` });
    }
  });
  return problems;
}

/** Where a tab's sky comes from: its own file, the template's texture, or the default sky (decision 17.3.9). */
export function skySource(tab: SkyTab, template: PackFiles): 'user' | 'template' | 'default' {
  if (tab.sky.user) return 'user';
  const path = tab.templateLayer?.texturePath;
  return path && template.has(path) ? 'template' : 'default';
}

export interface TabNote {
  /** The tab it is about, or null for the pack as a whole. */
  tabId: string | null;
  level: 'warn' | 'error';
  text: string;
}

/** Amber and red notes about the included tabs (PLAN §17.4), for the tab and the pack summary. */
export function tabNotes(tabs: readonly SkyTab[], template: PackFiles): TabNote[] {
  const notes: TabNote[] = [];
  const { layers } = layerPlan(tabs);
  if (layers.length === 0) {
    notes.push({ tabId: null, level: 'warn', text: 'No sky tab is included, so the pack has no Nuit sky behind the hero.' });
  }
  for (const { tab, base } of layers) {
    if (!base && tab.keyFrames.length === 0) {
      notes.push({ tabId: tab.id, level: 'warn',
        text: `${tab.name} has no keyframes, so it is always on and hides every layer below it.` });
    }
    if (!base) {
      for (const p of keyFrameProblems(tab.keyFrames)) {
        notes.push({ tabId: tab.id, level: 'error', text: `${tab.name}: ${p.message} Nuit would not load this layer.` });
      }
    }
    if (skySource(tab, template) === 'default') {
      notes.push({ tabId: tab.id, level: 'warn', text: `${tab.name} has no sky of its own, so the default sky goes in.` });
    }
    const duration = tab.templateLayer?.duration ?? TICKS_PER_DAY;
    if (duration !== TICKS_PER_DAY) {
      notes.push({ tabId: tab.id, level: 'warn',
        text: `${tab.name}: the template's fade lasts ${duration} ticks; it is written as ${TICKS_PER_DAY}, one day.` });
    }
  }
  return notes;
}

// --- Layer files ---------------------------------------------------------------------------------

export interface LayerOutput {
  tabId: string;
  layer: number;
  base: boolean;
  /** The layer's JSON file in the pack, and its text. */
  jsonPath: string;
  text: string;
  /** Where its texture goes, and what goes there: the user's sky, the default sky, or nothing (the template's stays). */
  texturePath: string;
  textureFrom: 'user' | 'default' | 'template';
}

/** "assets/<namespace>/<path>" → "<namespace>:<path>", the form Nuit's `texture` field takes. */
export function textureIdFromPath(path: string): string {
  const rest = path.slice('assets/'.length);
  const slash = rest.indexOf('/');
  return `${rest.slice(0, slash)}:${rest.slice(slash + 1)}`;
}

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

/** The path, or the path with _2, _3… before its extension if it is taken. */
function freePath(path: string, taken: (p: string) => boolean): string {
  if (!taken(path)) return path;
  const dot = path.lastIndexOf('.');
  for (let n = 2; ; n++) {
    const candidate = `${path.slice(0, dot)}_${n}${path.slice(dot)}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * A layer file's text (decision 17.3.8): the given JSON with `layer` and `fade.keyFrames` set (and `texture`, if
 * given), fade.duration set to one day, and the ignored `fade.alwaysOn` and top-level `blend` removed. Every other
 * field is kept. Written with two-space indents and a final newline.
 */
export function layerJson(text: string, changes: { layer: number; keyFrames: readonly FadeKey[]; texture?: string }): string {
  const parsed: unknown = JSON.parse(text);
  const json: Obj = isObj(parsed) ? parsed : {};
  if (changes.texture !== undefined) json.texture = changes.texture;
  delete json.blend;
  const props: Obj = isObj(json.properties) ? json.properties : (json.properties = {});
  props.layer = changes.layer;
  const fade: Obj = isObj(props.fade) ? props.fade : (props.fade = {});
  delete fade.alwaysOn;
  fade.duration = TICKS_PER_DAY;
  fade.keyFrames = Object.fromEntries([...changes.keyFrames]
    .sort((a, b) => a.tick - b.tick)
    .map((k) => [String(k.tick), k.alpha]));
  return `${JSON.stringify(json, null, 2)}\n`;
}

/**
 * Every included tab's layer file and texture, in layer order (PLAN §17.8). A tab from the template writes its
 * template file and texture path; a new tab gets assets/nuit/sky/sky<layer>_<name>.json and <folder>/<name>.png,
 * where the folder is that of the template's sky textures (or of the hero's texture). A path already in the
 * template, or already given out, gets _2, _3…; so does a texture the template shares between layers, when this
 * tab's sky differs from the template's.
 */
export function layerOutputs(
  tabs: readonly SkyTab[], template: PackFiles, options: { heroTexturePath: string | null; newLayerText: string },
): LayerOutput[] {
  const { layers } = layerPlan(tabs);
  const firstSkyTexture = tabs.find((t) => t.templateLayer?.texturePath)?.templateLayer?.texturePath;
  const folder = folderOf(firstSkyTexture ?? options.heroTexturePath ?? `assets/${DEFAULTS.texture.replace(':', '/')}`);
  const usedJson = new Set<string>();
  const usedTextures = new Set<string>(options.heroTexturePath ? [options.heroTexturePath] : []);
  const outputs: LayerOutput[] = [];

  for (const planned of layers) {
    const { tab, layer, base } = planned;
    const source = skySource(tab, template);
    const slug = slugify(tab.name) || `sky${layer}`;
    const ref = tab.templateLayer;
    const jsonPath = ref?.file ?? freePath(`assets/nuit/sky/sky${layer}_${slug}.json`, (p) => template.has(p) || usedJson.has(p));
    usedJson.add(jsonPath);

    let texturePath = ref?.texturePath ?? null;
    if (texturePath && source !== 'template' && usedTextures.has(texturePath)) texturePath = null;
    texturePath ??= freePath(`${folder}/${slug}.png`, (p) => template.has(p) || usedTextures.has(p));
    usedTextures.add(texturePath);

    const baseText = ref && template.has(ref.file) ? decoder.decode(template.get(ref.file)) : options.newLayerText;
    const changes = { layer, keyFrames: effectiveKeyFrames(planned) };
    const text = layerJson(baseText, texturePath === ref?.texturePath ? changes : { ...changes, texture: textureIdFromPath(texturePath) });
    outputs.push({ tabId: tab.id, layer, base, jsonPath, text, texturePath, textureFrom: source });
  }
  return outputs;
}
