// Wiring (PLAN §2): ui → state → math → JSON object → scene, readouts and JSON panel (rule 3).

import './style.css';
import starterDayLayer from '../reference/samples/starter_pack/assets/nuit/sky/sky2_day.json?raw';
import testHeroUrl from '../reference/samples/test_hero_1063x1502.png';
import {
  DEFAULTS, PANO_FACE_RANGE, PANO_LEFT_BEARING_RANGE, RANGES, TICKS_PER_DAY,
} from './constants.ts';
import type { ConvertReply, ConvertRequest } from './convert.worker.ts';
import { clearImages, forgetImage, loadImage, saveImage } from './imagestore.ts';
import {
  applyImport, buildSky3, editPinned, exportProblems, HERO_MCMETA, isJsonFile, mcmetaFileName, parseSky3,
  serializeSky3, SKY3_FILENAME, textureProblem,
} from './json.ts';
import {
  advanceTicks, analyse, atlasLayout, clamp, clampHero, clampPitch, fadeAlpha, heroCentreDirection,
  importAspectMismatch, kFromHeight, mod, panoramaLayout, roundTo, scaleK, skyKindFromSize, sunAngleDeg, viewToward,
  wrapDeg180,
} from './math.ts';
import { assembleTabs, isPng, isZipFile, readTemplate, readZip, texturePath, writeZip, type PackFiles } from './pack.ts';
import { fromSaved, fromSavedV1, SAVED_KEY, SAVED_KEY_V1, toSaved, type SavedSky, type Session } from './saved.ts';
import { SkyScene } from './scene.ts';
import type { AppState, FadeKey, HeroParams, PreviewMode, Readouts, SkyTab, ViewState } from './schema.ts';
import {
  keyFrameProblems, layerOutputs, layerPlan, mergeTemplate, newTab, nextTabName, previewLayers, skySource,
  tabNameProblem, tabNotes, type LayerOutput,
} from './tabs.ts';
import { Ui, type DropTarget, type ImportLine, type OpenTabView } from './ui.ts';
import { attachDragLook } from './view.ts';

const initialHero: HeroParams = {
  mode: 'tilted',
  imageW: DEFAULTS.imageW,
  imageH: DEFAULTS.imageH,
  k: kFromHeight(DEFAULTS.heightDeg),
  bottomDeg: DEFAULTS.bottomDeg,
  wallTopT: DEFAULTS.wallTopT,
  mappingYDeg: DEFAULTS.mappingYDeg,
  texture: DEFAULTS.texture,
  layer: DEFAULTS.layer,
};

const state: AppState = {
  hero: initialHero,
  view: {
    timeTicks: DEFAULTS.timeTicks,
    playing: false,
    ticksPerSecond: DEFAULTS.ticksPerSecond,
    fovDeg: DEFAULTS.fovDeg,
    yawDeg: DEFAULTS.yawDeg,
    pitchDeg: DEFAULTS.pitchDeg,
    showOverlay: false,
  },
  json: buildSky3(initialHero),
  pinned: false,
};

/** The sky tabs (PLAN §17), in layer order, the open one, and what the preview shows. */
let tabs: SkyTab[] = [];
let openTabId = '';
let previewMode: PreviewMode = 'blend';

const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const scene = new SkyScene(canvas);
const ui = new Ui({
  onView: updateView,
  onHero: updateHero,
  onScale: (factor) => updateHero({ k: scaleK(state.hero.k, factor) }),
  onLookAtHero: lookAtHero,
  onSkyFile: (file) => pickSky(openTabId, file),
  onSkyType: (type) => setTabSky(openTabId, { type, faceSize: null }),
  onFaceSize: (faceSize) => setTabSky(openTabId, { faceSize }),
  onLeftBearingPreview: (deg) => previewLeftBearing(openTabId, deg),
  onLeftBearing: (deg) => {
    const leftBearingDeg = clamp(deg, PANO_LEFT_BEARING_RANGE.min, PANO_LEFT_BEARING_RANGE.max);
    previewLeftBearing(openTabId, leftBearingDeg); // shows at once while the conversion runs
    setTabSky(openTabId, { leftBearingDeg });
  },
  onDownloadAtlas: () => {
    const png = skies.get(openTabId)?.atlasPng;
    if (png) ui.download(png.blob, png.fileName);
  },
  onHeroFile: pickHero,
  onReset: reset,
  onCopy: () => void copyJson(),
  onDownloadJson: () => {
    const text = exportText();
    if (text !== null) ui.download(new Blob([text], { type: 'application/json' }), SKY3_FILENAME);
  },
  onDownloadMcmeta: () => ui.download(new Blob([HERO_MCMETA], { type: 'application/json' }),
    mcmetaFileName(state.json.animatableTextures[0].texture)),
  onImportFile: importFile,
  onImportText: (text) => {
    if (text.trim() === '') ui.showImportStatus([{ level: 'error', text: 'Paste a sky3_image.json first.' }]);
    else importJson(text, 'the pasted JSON');
  },
  onDropFiles: (files, target) => void dropFiles(files, target),
  onPackFile: (file) => void loadPackTemplate(file, file.name, { remember: true, merge: true }),
  onAssemble: () => void assemble(),
  onUseStarter: () => {
    packTemplate = null;
    void forgetImage('pack');
    ui.clearFileInputs();
    showStarterStatus();
    templateChanged(true);
  },
  onTabSelect: selectTab,
  onTabAdd: addTab,
  onTabRename: (name) => {
    const problem = tabNameProblem(name, tabs, openTabId);
    ui.showTabNameProblem(problem);
    if (problem === null) updateOpenTab({ name: name.trim() });
  },
  onTabInclude: (include) => updateOpenTab({ include }),
  onTabMove: moveTab,
  onTabDelete: deleteTab,
  onSkyReset: () => forgetTabSky(openTabId),
  onKeyFrames: (keys) => updateOpenTab({ keyFrames: sortKeys(keys), keyFramesEdited: true }),
  onKeyFrameAdd: addKeyFrameNow,
  onKeyFramesTemplate: () => {
    const ref = openTab()?.templateLayer;
    if (ref) updateOpenTab({ keyFrames: ref.keyFrames.map((k) => ({ ...k })), keyFramesEdited: false });
  },
  onTabCopy: () => void copyLayer(),
  onTabDownload: () => {
    const out = exportLayer();
    if (out) ui.download(new Blob([out.text], { type: 'application/json' }), fileName(out.jsonPath));
  },
  onPreviewMode: (mode) => {
    previewMode = mode;
    refreshPreview();
    scheduleSave();
  },
});

/** The one place the view changes: wrap and clamp, then show it everywhere. */
function updateView(patch: Partial<ViewState>): void {
  const view = Object.assign(state.view, patch); // like copying a patch object's fields onto the state
  view.yawDeg = wrapDeg180(view.yawDeg);
  view.pitchDeg = clampPitch(view.pitchDeg);
  view.fovDeg = clamp(view.fovDeg, RANGES.fovDeg.min, RANGES.fovDeg.max);
  view.timeTicks = mod(view.timeTicks, TICKS_PER_DAY);
  scene.setView(view);
  scene.setSpinDeg(sunAngleDeg(view.timeTicks)); // the daily spin, Y(θ) (BRIEF §4.7)
  scene.setOverlayVisible(view.showOverlay);
  ui.showView(view);
  refreshPreview(); // the layers' alphas follow the time (PLAN §17.5)
  syncPlayLoop();
  scheduleSave();
}

// --- Play (PLAN §14.1) ---------------------------------------------------------------------------

/** The pending animation frame while playing, 0 when stopped. */
let playFrame = 0;
let lastFrameTime = 0;

/** Starts or stops the loop to match state.view.playing; like starting or stopping a javax.swing.Timer. */
function syncPlayLoop(): void {
  if (state.view.playing && playFrame === 0) {
    lastFrameTime = performance.now();
    playFrame = requestAnimationFrame(playStep);
  } else if (!state.view.playing && playFrame !== 0) {
    cancelAnimationFrame(playFrame);
    playFrame = 0;
  }
}

/** One frame of Play: advance the time by the frame's length. */
function playStep(now: number): void {
  // At most a quarter second per frame, so coming back to a hidden tab doesn't jump the sky.
  const seconds = Math.min(Math.max(now - lastFrameTime, 0) / 1000, 0.25);
  lastFrameTime = now;
  playFrame = requestAnimationFrame(playStep); // schedule first, so updateView sees the loop running
  updateView({ timeTicks: advanceTicks(state.view.timeTicks, seconds, state.view.ticksPerSecond) });
}

/** The line under the time slider, including each sky layer's alpha and where the hero faces at this time. */
function showTime(): void {
  const theta = sunAngleDeg(state.view.timeTicks);
  const { uvRange } = state.json.animatableTextures[0];
  const facing = viewToward(heroCentreDirection(uvRange, state.json.properties.rotation.mapping['0'], theta));
  const layers = previewLayers(tabs, 'blend', openTabId, state.view.timeTicks)
    .map(({ tabId, alpha }) => ({ name: tabById(tabId)?.name ?? '', alpha }));
  ui.showTime(state.view.timeTicks, theta, facing.yawDeg, layers);
}

// --- Hero and JSON ---------------------------------------------------------------------------------

/** Controls that may change a pinned (imported) JSON without regenerating its uvRange and mapping (PLAN §14.3). */
const PINNED_SAFE: ReadonlySet<string> = new Set<keyof HeroParams>(['texture', 'layer']);
/** The file the pinned JSON came from, for the note above it. */
let importedName = '';

/**
 * The one place the hero changes: controls → math → a new JSON object, which everything else reads.
 * While pinned to an import, texture and layer edits (and loading a hero image) keep the JSON as loaded;
 * any size or position control regenerates it from the controls and unpins it. The layer always comes from
 * the sky tabs: above every included sky (decision 17.3.3).
 */
function updateHero(patch: Partial<HeroParams>, fromImage = false): void {
  state.hero = clampHero({ ...state.hero, ...patch, layer: layerPlan(tabs).heroLayer });
  const keepPinned = state.pinned && (fromImage || Object.keys(patch).every((key) => PINNED_SAFE.has(key)));
  if (keepPinned) {
    state.json = editPinned(state.json, { texture: state.hero.texture, layer: state.hero.layer });
  } else {
    state.json = buildSky3(state.hero);
    state.pinned = false;
  }
  showJson();
}

/** What Nuit would draw, described: computed from the JSON object (rule 3). */
function currentReadouts(): Readouts {
  const { hero, json } = state;
  const [x] = json.properties.rotation.mapping['0'];
  return analyse(json.animatableTextures[0].uvRange, x, hero.imageW / hero.imageH);
}

function showJson(): void {
  const { hero, json } = state;
  scene.applyJson(json);
  ui.showHero({
    hero,
    json,
    jsonText: serializeSky3(json),
    readouts: currentReadouts(),
    textureProblem: textureProblem(json.animatableTextures[0].texture),
  });
  const skyCount = layerPlan(tabs).layers.length;
  ui.showHeroLayer(`Layer ${json.properties.layer}: above the ${skyCount} included sky ${skyCount === 1 ? 'tab' : 'tabs'}. `
    + 'It follows the sky tabs.');
  showTime();
  ui.showExportStatus(''); // a note about the last export no longer applies to a changed JSON
  scheduleSave();

  if (!state.pinned) {
    ui.showPinned(null);
    return;
  }
  let note = `Imported ${importedName}. This JSON stays exactly as loaded until you move a size or position control.`;
  const mismatch = importAspectMismatch(hero.imageW, hero.imageH, json.animatableTextures[0].uvRange);
  if (mismatch) {
    note += ` It was made for an image of aspect ${mismatch.json.toFixed(3)}, but the hero image is `
      + `${hero.imageW} × ${hero.imageH} (${mismatch.image.toFixed(3)}); moving a size control refits it to this image.`;
  }
  ui.showPinned(note);
}

// --- Export and import (PLAN §14.2, §14.3) -------------------------------------------------------

/** The JSON text to export, after asking if it has problems; null if the user says no. */
function exportText(): string | null {
  const problems = exportProblems(currentReadouts(), textureProblem(state.json.animatableTextures[0].texture));
  if (problems.length > 0 && !ui.confirmExport(problems)) return null;
  return serializeSky3(state.json);
}

async function copyJson(): Promise<void> {
  const text = exportText();
  if (text === null) return;
  try {
    await navigator.clipboard.writeText(text); // asynchronous, like waiting on a CompletableFuture
    ui.showExportStatus('Copied sky3_image.json to the clipboard.');
  } catch {
    ui.selectJson();
    ui.showExportStatus('The browser blocked the clipboard. The JSON is selected: press Ctrl+C.', true);
  }
}

function importFile(file: File): void {
  file.text()
    .then((text) => importJson(text, file.name))
    .catch(() => ui.showImportStatus([{ level: 'error', text: `${file.name} could not be read.` }]));
}

/** Reads a sky3_image.json; on success it becomes the output exactly as loaded (decision 11.9). */
function importJson(text: string, name: string): void {
  const result = parseSky3(text);
  if (!result.ok) {
    const errors: ImportLine[] = result.errors.map((e) => ({ level: 'error', text: e }));
    ui.showImportStatus([{ level: 'error', text: `${name} was not imported:` }, ...errors]);
    return;
  }
  const { hero, json } = applyImport(state.hero, result);
  const heroLayer = layerPlan(tabs).heroLayer;
  state.hero = { ...hero, layer: heroLayer };
  state.json = editPinned(json, { texture: hero.texture, layer: heroLayer });
  state.pinned = true;
  importedName = name;
  const warnings: ImportLine[] = result.warnings.map((w) => ({ level: 'warn', text: w }));
  if (json.properties.layer !== heroLayer) {
    warnings.push({ level: 'warn', text: `Its layer ${json.properties.layer} is now ${heroLayer}, above the included sky tabs.` });
  }
  ui.showImportStatus([{ level: 'ok', text: `Imported ${name}.` }, ...warnings]);
  showJson();
}

/** Points the camera at the middle of the hero, wherever the spin has taken it. */
function lookAtHero(): void {
  const { uvRange } = state.json.animatableTextures[0];
  const direction = heroCentreDirection(uvRange, state.json.properties.rotation.mapping['0'], sunAngleDeg(state.view.timeTicks));
  updateView(viewToward(direction));
}

/**
 * Decodes an image in the browser; nothing is uploaded. colorSpaceConversion 'none' ignores any
 * colour profile in the PNG, as Minecraft's image loader does. Returns null and reports if it fails.
 */
async function decode(source: Blob, options: ImageBitmapOptions, onError: (message: string) => void, name: string): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(source, { colorSpaceConversion: 'none', ...options });
  } catch {
    onError(`${name} could not be read as an image.`);
    return null;
  }
}

// --- Sky tabs (PLAN §17) ---------------------------------------------------------------------------

/** A fresh tab id. randomUUID needs a secure page (https or localhost); the fallback is unique enough here. */
function newId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const tabById = (id: string): SkyTab | undefined => tabs.find((t) => t.id === id);
const openTab = (): SkyTab | undefined => tabById(openTabId);
const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const sortKeys = (keys: readonly FadeKey[]): FadeKey[] =>
  keys.map((k) => ({ tick: k.tick, alpha: clamp(k.alpha, 0, 1) })).sort((a, b) => a.tick - b.tick);

/** Changes the open tab, then shows everything that depends on the tabs. */
function updateOpenTab(patch: Partial<SkyTab>): void {
  tabs = tabs.map((t) => (t.id === openTabId ? { ...t, ...patch } : t));
  tabsChanged();
}

/** After any change to the tabs: the skies on screen, the panel, the preview, the hero's layer, and saving. */
function tabsChanged(): void {
  syncSkies();
  refreshTabs();
  if (state.hero.layer !== layerPlan(tabs).heroLayer) updateHero({});
  else showJson(); // the layer read-out counts the included tabs
}

function selectTab(tabId: string): void {
  if (tabId === openTabId || !tabById(tabId)) return;
  openTabId = tabId;
  ui.clearSkyInput();
  ui.showTabExportStatus('');
  showOpenSky();
  refreshTabs();
  saveNow(); // decision 17.3.12: moving away from a tab saves it
}

function addTab(): void {
  const tab = newTab(newId(), nextTabName(tabs));
  tabs = [...tabs, tab];
  openTabId = tab.id;
  ui.clearSkyInput();
  ui.showTabExportStatus('');
  tabsChanged();
  showOpenSky();
  saveNow();
}

function moveTab(from: number, to: number): void {
  const target = clamp(to, 0, tabs.length - 1);
  if (from === target || from < 0 || from >= tabs.length) return;
  const next = [...tabs];
  const [tab] = next.splice(from, 1);
  next.splice(target, 0, tab);
  tabs = next;
  tabsChanged();
}

function deleteTab(): void {
  if (tabs.length <= 1) return;
  const index = tabs.findIndex((t) => t.id === openTabId);
  const id = openTabId;
  skies.get(id)?.converter?.terminate();
  skies.delete(id);
  scene.removeSkyLayer(id);
  void forgetImage(`sky:${id}`);
  tabs = tabs.filter((t) => t.id !== id);
  openTabId = tabs[Math.min(index, tabs.length - 1)].id;
  ui.clearSkyInput();
  tabsChanged();
  showOpenSky();
  saveNow();
}

/** Adds a keyframe at the preview's time, with the alpha the tab has there now, so the curve doesn't change. */
function addKeyFrameNow(): void {
  const tab = openTab();
  if (!tab) return;
  const tick = Math.floor(state.view.timeTicks);
  if (tab.keyFrames.some((k) => k.tick === tick)) {
    ui.showTabExportStatus(`There is a keyframe at tick ${tick} already.`, true);
    return;
  }
  const alpha = roundTo(fadeAlpha(tab.keyFrames, tick), 2);
  updateOpenTab({ keyFrames: sortKeys([...tab.keyFrames, { tick, alpha }]), keyFramesEdited: true });
}

/** Every included tab's layer file, as the pack and the per-tab export write it (PLAN §17.8). */
function currentLayerOutputs(): LayerOutput[] {
  return layerOutputs(tabs, templateFiles(), {
    heroTexturePath: texturePath(state.json.animatableTextures[0].texture),
    newLayerText: starterDayLayer,
  });
}

/** The open tab's layer file, after asking about its red problems; null if there is none or the user says no. */
function exportLayer(): LayerOutput | null {
  const out = currentLayerOutputs().find((o) => o.tabId === openTabId);
  if (!out) return null;
  const problems = tabNotes(tabs, templateFiles()).filter((n) => n.tabId === openTabId && n.level === 'error').map((n) => n.text);
  if (problems.length > 0 && !ui.confirmExport(problems)) return null;
  return out;
}

async function copyLayer(): Promise<void> {
  const out = exportLayer();
  if (!out) return;
  try {
    await navigator.clipboard.writeText(out.text);
    ui.showTabExportStatus(`Copied ${fileName(out.jsonPath)} to the clipboard.`);
  } catch {
    ui.showTabExportStatus('The browser blocked the clipboard. Use Download instead.', true);
  }
}

/** The panel for the open tab, the strip, the pack summary and the preview. */
function refreshTabs(): void {
  const tab = openTab();
  if (!tab) return; // before the template has loaded
  const template = templateFiles();
  const plan = layerPlan(tabs);
  const outputs = currentLayerOutputs();
  const notes = tabNotes(tabs, template);
  const planned = plan.layers.find((l) => l.tab.id === tab.id);
  const out = outputs.find((o) => o.tabId === tab.id);
  const source = skySource(tab, template);

  const view: OpenTabView = {
    id: tab.id,
    name: tab.name,
    include: tab.include,
    layerText: planned && out
      ? `Layer ${planned.layer}${planned.base ? ', the base: always on' : ''} · ${out.jsonPath}`
      : 'Not included, so this layer is left out of the pack.',
    base: planned?.base ?? false,
    keyFrames: tab.keyFrames,
    problems: keyFrameProblems(tab.keyFrames),
    hasTemplateKeyFrames: tab.templateLayer !== null,
    notes: notes.filter((n) => n.tabId === tab.id),
    exportName: out ? fileName(out.jsonPath) : null,
    skyResetLabel: tab.sky.user === null ? null
      : tab.templateLayer?.texturePath && template.has(tab.templateLayer.texturePath) ? 'Use the template\'s sky' : 'Use the default sky',
    canDelete: tabs.length > 1,
    index: tabs.indexOf(tab),
    count: tabs.length,
  };
  ui.showTabs(tabs.map((t) => ({ id: t.id, name: t.name, include: t.include, base: plan.layers[0]?.tab.id === t.id })), view);
  if (source === 'default' && !runningLoad(tab.id)) {
    setSkyStatus(tab.id, `No sky of its own: showing the default sky (the starter's ${isBase(tab.id) ? 'night' : 'day'} guide atlas).`);
  }

  const describe = (t: SkyTab): string => {
    const s = skySource(t, template);
    return s === 'user' ? `your sky, ${t.sky.user!.name}` : s === 'template' ? 'the template\'s texture' : 'the default sky';
  };
  const summary: ImportLine[] = [
    ...plan.layers.map(({ tab: t, layer, base }) => ({
      level: 'ok' as const,
      text: `${t.name}: layer ${layer}${base ? ' (base, always on)' : ''}, ${describe(t)}.`,
    })),
    ...tabs.filter((t) => !t.include).map((t) => ({ level: 'ok' as const, text: `${t.name}: not included.` })),
    { level: 'ok', text: `Hero: layer ${plan.heroLayer}.` },
    ...notes.map((n) => ({ level: n.level, text: n.text })),
  ];
  ui.showPackSummary(summary);
  refreshPreview();
  scheduleSave();
}

/** The sky layers on screen and their alphas at the preview's time, and a note on what the preview shows. */
function refreshPreview(): void {
  scene.setSkyLayers(previewLayers(tabs, previewMode, openTabId, state.view.timeTicks));
  const tab = openTab();
  const included = layerPlan(tabs).layers.length;
  let note = '';
  if (previewMode === 'tab') note = tab ? `Showing only the ${tab.name} tab, as if it were always on.` : '';
  else if (included === 0) note = 'No tab is included, so there is no sky.';
  else if (tab && !tab.include) note = `${tab.name} isn't included, so the blend leaves it out. Choose This tab only to see it.`;
  else if (included === 1) note = 'One tab is included, so it is always on and only spins.';
  ui.showPreviewMode(previewMode, note);
  if (tab) ui.showFadeGraph(isBase(tab.id) ? null : tab.keyFrames, state.view.timeTicks);
  showTime();
}

// --- Each tab's sky: its own file (an atlas, or a panorama converted to one), the template's, or the default

interface TabSkyState {
  /** The user's file for this tab (picked, dropped or restored), or null. */
  file: Blob | null;
  /** Counts loads, so a slow decode that a newer load has overtaken is dropped. */
  loads: number;
  converter: Worker | null;
  /** A panorama's converted atlas, for its download. */
  atlasPng: { blob: Blob; fileName: string } | null;
  /** The left edge the atlas on screen was converted with; null when it came from an atlas file. */
  shownLeftBearing: number | null;
  /** The user's sky as it goes into a pack: the loaded atlas file, or the converted PNG. */
  forPack: { blob: Blob; width: number } | null;
  /** What is on screen: "user", "template:<template>:<path>", "default:<path>", or "" before anything. */
  shown: string;
  status: { text: string; isError: boolean };
  /** The panorama controls' values while the sky comes from a panorama, else null. */
  panorama: { faceSize: number; leftBearingDeg: number } | null;
  /** True for a file the user just picked: stored for the next visit once it has loaded (PLAN §15.2). */
  remember: boolean;
}

const skies = new Map<string, TabSkyState>();

function skyState(tabId: string): TabSkyState {
  let s = skies.get(tabId);
  if (!s) {
    s = { file: null, loads: 0, converter: null, atlasPng: null, shownLeftBearing: null, forPack: null, shown: '',
      status: { text: '', isError: false }, panorama: null, remember: false };
    skies.set(tabId, s);
  }
  return s;
}

const isBase = (tabId: string): boolean => layerPlan(tabs).layers[0]?.tab.id === tabId;
const runningLoad = (tabId: string): boolean => skies.get(tabId)?.converter != null;

/** A tab's status line; shown at once if it is the open tab. */
function setSkyStatus(tabId: string, text: string, isError = false): void {
  skyState(tabId).status = { text, isError };
  if (tabId === openTabId) ui.showSkyStatus(text, isError);
}

/** The open tab's sky controls: type, status, panorama options and atlas download. */
function showOpenSky(): void {
  const tab = openTab();
  if (!tab) return;
  const s = skyState(tab.id);
  ui.showSkyType(tab.sky.type);
  ui.showSkyStatus(s.status.text, s.status.isError);
  ui.showPanoramaOptions(s.panorama);
  ui.showAtlasDownload(s.atlasPng !== null);
}

/**
 * Puts the right atlas on each tab's faces, where it isn't there already: the tab's own sky, the template's
 * texture, or the default (decision 17.3.9). Run after anything that can change where a sky comes from.
 */
function syncSkies(): void {
  const template = templateFiles();
  for (const tab of tabs) {
    const s = skyState(tab.id);
    const source = skySource(tab, template);
    if (source === 'user') {
      if (s.shown !== 'user' && s.file && s.converter === null) void loadUserSky(tab.id);
      continue;
    }
    const path = source === 'template' ? tab.templateLayer!.texturePath! : isBase(tab.id) ? NIGHT_PNG : DAY_PNG;
    const bytes = source === 'template' ? template.get(path) : starter.get(path);
    const key = source === 'template' ? `template:${templateName()}:${path}` : `default:${path}`;
    if (s.shown === key || !bytes) continue;
    s.shown = key;
    const label = source === 'template' ? `${fileName(path)} from the template` : `the default sky (${fileName(path)})`;
    void loadAtlasBytes(tab.id, bytes, label);
  }
}

/** Shows a template texture or the default sky on a tab's faces. It must be a 3:2 atlas, as Nuit needs. */
async function loadAtlasBytes(tabId: string, bytes: Uint8Array, label: string): Promise<void> {
  const s = skyState(tabId);
  const load = ++s.loads;
  s.converter?.terminate();
  s.converter = null;
  s.atlasPng = null;
  s.panorama = null;
  s.forPack = null;
  const image = await decode(new Blob([bytes as Uint8Array<ArrayBuffer>]), {}, (m) => setSkyStatus(tabId, m, true), label);
  if (!image) return;
  if (load !== s.loads || !skies.has(tabId)) {
    image.close();
    return;
  }
  const layout = atlasLayout(image.width, image.height);
  if (layout.ok) {
    scene.setAtlas(tabId, image, layout.faceSize);
    s.shownLeftBearing = null;
    setSkyStatus(tabId, `Showing ${label} · ${image.width} × ${image.height} atlas.`);
  } else {
    setSkyStatus(tabId, `${label}: ${layout.message}`, true);
  }
  image.close();
  if (tabId === openTabId) showOpenSky();
}

function pickSky(tabId: string, file: File): void {
  if (!tabById(tabId)) return;
  const s = skyState(tabId);
  s.file = file;
  s.remember = true;
  tabs = tabs.map((t) => (t.id === tabId ? { ...t, sky: { ...t.sky, user: { name: file.name }, faceSize: null } } : t));
  void loadUserSky(tabId);
  refreshTabs();
}

/** New sky settings for a tab (type, face size, left edge): its own file is read again with them. */
function setTabSky(tabId: string, patch: Partial<SkyTab['sky']>): void {
  tabs = tabs.map((t) => (t.id === tabId ? { ...t, sky: { ...t.sky, ...patch } } : t));
  scheduleSave();
  if (skyState(tabId).file) void loadUserSky(tabId);
}

/** Forgets a tab's own sky, so it shows the template's texture or the default again. */
function forgetTabSky(tabId: string): void {
  const s = skyState(tabId);
  s.converter?.terminate();
  Object.assign(s, { file: null, converter: null, atlasPng: null, forPack: null, panorama: null, shown: '', remember: false });
  s.loads++;
  void forgetImage(`sky:${tabId}`);
  tabs = tabs.map((t) => (t.id === tabId ? { ...t, sky: { ...t.sky, user: null, faceSize: null } } : t));
  ui.clearSkyInput();
  tabsChanged();
  showOpenSky();
}

/** Stores a tab's picked file for the next visit, once, after it has loaded. */
function rememberSky(tabId: string): void {
  const s = skyState(tabId);
  const name = tabById(tabId)?.sky.user?.name;
  if (!s.remember || !s.file || !name) return;
  s.remember = false;
  void saveImage(`sky:${tabId}`, { name, blob: s.file });
}

/** While the left-edge slider moves, turn the tab's sky by the difference instead of converting (PLAN §13.7). */
function previewLeftBearing(tabId: string, leftBearingDeg: number): void {
  const shown = skies.get(tabId)?.shownLeftBearing;
  if (shown !== null && shown !== undefined) scene.setSkyTurnDeg(tabId, leftBearingDeg - shown);
}

/** Reads a tab's own file: an atlas goes straight on, a panorama is converted first (PLAN §13). */
async function loadUserSky(tabId: string): Promise<void> {
  const tab = tabById(tabId);
  const s = skyState(tabId);
  if (!tab || !s.file) return;
  const { type, leftBearingDeg } = tab.sky;
  const name = tab.sky.user?.name ?? 'sky';
  const load = ++s.loads;
  s.converter?.terminate(); // stop a conversion that is still running, like interrupting a thread
  s.converter = null;
  s.atlasPng = null;
  s.shown = 'user';
  if (tabId === openTabId) ui.showAtlasDownload(false);

  const image = await decode(s.file, {}, (m) => setSkyStatus(tabId, m, true), name);
  if (!image) return;
  if (load !== s.loads || !skies.has(tabId)) {
    image.close();
    return;
  }
  const size = `${image.width} × ${image.height}`;
  const shape = skyKindFromSize(image.width, image.height);
  const kind = type === 'auto' ? shape : type;
  const keep = 'The previous sky is still shown.';

  if (kind === 'panorama') {
    const layout = panoramaLayout(image.width, image.height);
    if (layout.ok) {
      const faceSize = clamp(Math.round(tab.sky.faceSize ?? layout.faceSize), PANO_FACE_RANGE.min, PANO_FACE_RANGE.max);
      s.panorama = { faceSize, leftBearingDeg };
      if (tabId === openTabId) ui.showPanoramaOptions(s.panorama);
      convertPanorama(tabId, image, faceSize, leftBearingDeg, `${name} · ${size} panorama, left edge ${leftBearingDeg}°`, name);
      return;
    }
    const hint = shape === 'atlas' ? ' It is 3:2, so choose Atlas or Auto.' : '';
    setSkyStatus(tabId, `${name}: ${layout.message}${hint} ${keep}`, true);
  } else if (kind === 'atlas') {
    const layout = atlasLayout(image.width, image.height);
    if (layout.ok) {
      scene.setAtlas(tabId, image, layout.faceSize);
      s.shownLeftBearing = null;
      s.forPack = { blob: s.file, width: image.width };
      rememberSky(tabId);
      setSkyStatus(tabId, `${name} · ${size} atlas · faces ${layout.faceSize} px`);
    } else {
      const hint = shape === 'panorama' ? ' It is 2:1, so choose Panorama or Auto.' : '';
      setSkyStatus(tabId, `${name}: ${layout.message}${hint} ${keep}`, true);
    }
  } else {
    setSkyStatus(tabId, `${name} is ${size}: a sky must be a 3:2 atlas or a 2:1 panorama. ${keep}`, true);
  }
  s.panorama = null;
  if (tabId === openTabId) ui.showPanoramaOptions(null);
  scene.setSkyTurnDeg(tabId, 0); // drop any left-edge preview; the sky on screen is unchanged or a new atlas
  image.close(); // the cropped canvases hold their own copies
  refreshTabs();
}

/** Runs the conversion in a worker (PLAN §13.3); the image is handed over to it. */
function convertPanorama(tabId: string, image: ImageBitmap, faceSize: number, leftBearingDeg: number, label: string, name: string): void {
  const s = skyState(tabId);
  const started = performance.now();
  const worker = new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' });
  s.converter = worker;
  setSkyStatus(tabId, `${label}: converting…`);

  const finish = (): void => {
    worker.terminate();
    if (s.converter === worker) s.converter = null;
  };
  worker.onmessage = (event: MessageEvent<ConvertReply>) => {
    const reply = event.data;
    if (reply.type === 'progress') {
      setSkyStatus(tabId, reply.stage === 'convert'
        ? `${label}: converting, face ${reply.done} of ${reply.total}…`
        : `${label}: writing the atlas PNG…`);
      return;
    }
    finish();
    if (!skies.has(tabId)) return; // the tab was deleted meanwhile
    if (reply.type === 'done') {
      scene.setAtlas(tabId, reply.atlas, faceSize); // also ends the preview turn
      s.shownLeftBearing = leftBearingDeg;
      reply.atlas.close();
      s.atlasPng = { blob: reply.png, fileName: `${name.replace(/\.[^.]*$/, '')}_atlas.png` };
      if (tabId === openTabId) ui.showAtlasDownload(true);
      s.forPack = { blob: reply.png, width: 3 * faceSize };
      rememberSky(tabId);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      setSkyStatus(tabId, `${label} → atlas ${3 * faceSize} × ${2 * faceSize} (faces ${faceSize} px) · ${seconds} s`);
      refreshTabs();
    } else {
      scene.setSkyTurnDeg(tabId, 0);
      setSkyStatus(tabId, `${label}: the conversion failed (${reply.message}). The previous sky is still shown.`, true);
    }
  };
  worker.onerror = () => {
    finish();
    scene.setSkyTurnDeg(tabId, 0);
    setSkyStatus(tabId, `${label}: the converter stopped unexpectedly. The previous sky is still shown.`, true);
  };
  const request: ConvertRequest = { image, faceSize, leftBearingDeg };
  worker.postMessage(request, [image]);
}

// --- Hero image ------------------------------------------------------------------------------------

let heroLoads = 0;

function pickHero(file: File): void {
  void loadHero(file, file.name, { remember: true });
}

/**
 * The hero keeps its alpha exactly as stored (no premultiplying), as Minecraft does, and is flipped
 * here because WebGL can't flip an ImageBitmap on upload. Its size fills in the W × H boxes, unless
 * keepSize says the boxes already hold the right (remembered) size. `remember` stores it for next time;
 * `standIn` marks the test card shown in place of a remembered image that is missing.
 */
async function loadHero(
  source: Blob, name: string, options: { remember?: boolean; keepSize?: boolean; standIn?: boolean } = {},
): Promise<void> {
  const load = ++heroLoads;
  const image = await decode(source, { premultiplyAlpha: 'none', imageOrientation: 'flipY' },
    (m) => ui.showHeroStatus(m, true), name);
  if (!image) return;
  if (load !== heroLoads) {
    image.close(); // a newer load (or a reset) has overtaken this one
    return;
  }
  scene.setHeroImage(image); // the scene owns the image from here on
  ui.showHeroStatus(`${name} · ${image.width} × ${image.height}`);
  heroForPack = source;
  if (options.remember) void saveImage('hero', { name, blob: source });
  if (!options.keepSize) {
    updateHero({ imageW: image.width, imageH: image.height }, true);
  } else if (options.standIn && (image.width !== state.hero.imageW || image.height !== state.hero.imageH)) {
    ui.showHeroStatus(`${name} · ${image.width} × ${image.height}, standing in at your saved size `
      + `${state.hero.imageW} × ${state.hero.imageH}. Load your hero image again to see it.`);
  }
}

// --- Drag and drop (PLAN §15.1) ----------------------------------------------------------------

/** An image's size, or null if the file isn't an image. */
async function imageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const image = await createImageBitmap(file);
    const size = { width: image.width, height: image.height };
    image.close();
    return size;
  } catch {
    return null;
  }
}

/**
 * Files dropped on a row go there. Files dropped anywhere else are routed by what they are: a .json to
 * Import, a .zip to the pack template, a 3:2 or 2:1 image to the open tab's sky, any other image to the Hero;
 * the note says where each went.
 */
async function dropFiles(files: File[], target: DropTarget): Promise<void> {
  const notes: string[] = [];
  let problem = false;
  const tabName = openTab()?.name ?? 'open';
  for (const file of files) {
    if (target === 'import' || (target === 'auto' && isJsonFile(file.name, file.type))) importFile(file);
    else if (target === 'pack' || (target === 'auto' && isZipFile(file.name, file.type))) {
      void loadPackTemplate(file, file.name, { remember: true, merge: true });
      if (target === 'auto') notes.push(`${file.name} is the pack template now.`);
    }
    else if (target === 'sky') pickSky(openTabId, file);
    else if (target === 'hero') pickHero(file);
    else {
      const size = await imageSize(file);
      const shape = size && skyKindFromSize(size.width, size.height);
      if (!size) {
        notes.push(`${file.name} is neither an image, a .json nor a .zip, so it wasn't used.`);
        problem = true;
      } else if (shape) {
        pickSky(openTabId, file);
        notes.push(`${file.name} went to the ${tabName} tab's sky, as it is ${shape === 'atlas' ? '3:2' : '2:1'}. `
          + 'Drop it on the Hero row to use it as the hero.');
      } else {
        pickHero(file);
        notes.push(`${file.name} went to the Hero. Drop it on the Sky row to use it as the sky.`);
      }
    }
  }
  ui.showDropStatus(notes.join(' '), problem);
}

// --- Remembering the last session (PLAN §15.2, §17.9) ------------------------------------------

let saveTimer = 0;

/** Saves the settings half a second after the last change; during Play that means once it pauses. */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 500);
}

/** Saves the settings now, as when moving to another tab (decision 17.3.12). */
function saveNow(): void {
  window.clearTimeout(saveTimer);
  if (tabs.length === 0) return; // still starting: nothing to save over what is stored
  try {
    localStorage.setItem(SAVED_KEY, toSaved(currentSession()));
  } catch {
    // Storage blocked or full: the settings just won't be remembered.
  }
}

function currentSession(): Session {
  const { timeTicks, ticksPerSecond, fovDeg, yawDeg, pitchDeg, showOverlay } = state.view;
  return {
    hero: state.hero,
    view: { timeTicks, ticksPerSecond, fovDeg, yawDeg, pitchDeg, showOverlay },
    tabs,
    openTabId,
    previewMode,
    pinned: state.pinned ? { json: state.json, name: importedName } : null,
  };
}

function readSaved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function fetchBlob(url: string): Promise<Blob | null> {
  try {
    return await (await fetch(url)).blob();
  } catch {
    return null;
  }
}

// --- Resource pack (PLAN §16, §17.8) -------------------------------------------------------------

/** The uploaded template, if any; without one, the bundled starter is used. */
let packTemplate: { name: string; files: PackFiles } | null = null;
/** The bundled starter's files: the template without an upload, and the default skies (PLAN §17.6). */
let starter: PackFiles = new Map();
let heroForPack: Blob | null = null;

const templateFiles = (): PackFiles => packTemplate?.files ?? starter;
const templateName = (): string => packTemplate?.name ?? STARTER_NAME;

/** The starter template's files, bundled by Vite: path in the repo → URL on the site. */
const STARTER_NAME = 'NuitSkyTestPack_26_2.zip';
const STARTER_PREFIX = '../reference/samples/starter_pack/';
const starterUrls = import.meta.glob('../reference/samples/starter_pack/**/*',
  { query: '?url', import: 'default', eager: true }) as Record<string, string>;
/** The default skies: the starter's guide atlases (PLAN §17.6). */
const NIGHT_PNG = 'assets/sasheen/textures/sky/night.png';
const DAY_PNG = 'assets/sasheen/textures/sky/day.png';

async function starterFiles(): Promise<PackFiles> {
  try {
    const entries = await Promise.all(Object.entries(starterUrls).map(async ([path, url]) =>
      [path.slice(STARTER_PREFIX.length), new Uint8Array(await (await fetch(url)).arrayBuffer())] as const));
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function showStarterStatus(): void {
  ui.showPackStatus(`Template: the starter (${STARTER_NAME}), with placeholder skies and a test hero. `
    + 'Choose or drop your own template to use it instead.');
}

/**
 * After the template changes: tabs follow its sky layers (decision 17.3.6). `addMissing` adds a tab for each
 * layer no tab takes; restoring a session doesn't, so a deleted tab stays deleted.
 */
function templateChanged(addMissing: boolean): void {
  const layers = readTemplate(templateFiles()).skyLayers;
  tabs = mergeTemplate(tabs, layers, newId, { addMissing });
  if (tabs.length === 0) tabs = [newTab(newId(), 'Night'), newTab(newId(), 'Day')];
  if (!tabById(openTabId)) openTabId = tabs[0].id;
  tabsChanged();
  showOpenSky();
}

/** Reads a template zip. A bad one is reported, and the template in use stays. */
async function loadPackTemplate(source: Blob, name: string, options: { remember: boolean; merge: boolean }): Promise<boolean> {
  const keep = packTemplate ? `${packTemplate.name} is still used.` : 'The starter template is still used.';
  let files: PackFiles;
  try {
    files = readZip(new Uint8Array(await source.arrayBuffer()));
  } catch {
    ui.showPackStatus(`${name} could not be read as a zip. ${keep}`, true, packTemplate !== null);
    return false;
  }
  const info = readTemplate(files);
  if (info.problems.length > 0) {
    ui.showPackStatus(`${name}: ${info.problems.join(' ')} ${keep}`, true, packTemplate !== null);
    return false;
  }
  packTemplate = { name, files };
  if (options.remember) void saveImage('pack', { name, blob: source });
  const count = info.skyLayers.length;
  ui.showPackStatus(`Template: ${name} · ${files.size} files · ${count} sky ${count === 1 ? 'layer' : 'layers'} and a hero layer.`, false, true);
  ui.showPackReport(info.warnings.map((text) => ({ level: 'warn', text })));
  if (options.merge) templateChanged(true);
  return true;
}

/** An image file as PNG bytes: as it is if it is a PNG already, otherwise re-encoded from its pixels. */
async function pngBytes(blob: Blob): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (isPng(bytes)) return bytes;
  try {
    const image = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(image.width, image.height);
    canvas.getContext('2d')!.drawImage(image, 0, 0);
    image.close();
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } catch {
    return null;
  }
}

/** Builds the pack and downloads it (PLAN §17.8). Red errors are asked about first, as for export. */
async function assemble(): Promise<void> {
  const errors = [
    ...currentReadouts().warnings.filter((w) => w.level === 'error').map((w) => w.message),
    ...tabNotes(tabs, templateFiles()).filter((n) => n.level === 'error').map((n) => n.text),
  ];
  if (errors.length > 0 && !ui.confirmExport(errors)) return;
  if (!heroForPack) {
    ui.showPackReport([{ level: 'error', text: 'Load a hero image first.' }]);
    return;
  }
  const night = starter.get(NIGHT_PNG);
  const day = starter.get(DAY_PNG);
  if (!night || !day) {
    ui.showPackReport([{ level: 'error', text: 'The default skies could not be loaded. Reload the page and try again.' }]);
    return;
  }
  ui.showPackReport([{ level: 'ok', text: 'Assembling…' }]);
  const skyPngs = new Map<string, { png: Uint8Array; width: number }>();
  for (const tab of tabs) {
    const forPack = tab.include && tab.sky.user ? skies.get(tab.id)?.forPack : undefined;
    const png = forPack ? await pngBytes(forPack.blob) : null;
    if (forPack && png) skyPngs.set(tab.id, { png, width: forPack.width });
  }
  const heroPng = await pngBytes(heroForPack);
  if (!heroPng) {
    ui.showPackReport([{ level: 'error', text: 'The hero image could not be read.' }]);
    return;
  }
  const result = assembleTabs(templateFiles(), {
    jsonText: serializeSky3(state.json),
    texture: state.json.animatableTextures[0].texture,
    heroPng,
    tabs,
    skyPngs,
    defaultSky: { base: night, other: day },
    newLayerText: starterDayLayer,
  });
  if (!result.ok) {
    ui.showPackReport(result.problems.map((text) => ({ level: 'error', text })));
    return;
  }
  const name = `${templateName().replace(/\.zip$/i, '')}_skybuilder.zip`;
  // fflate always returns a plain ArrayBuffer-backed array; the cast tells TypeScript so for Blob.
  const zip = writeZip(result.files) as Uint8Array<ArrayBuffer>;
  ui.download(new Blob([zip], { type: 'application/zip' }), name);
  const size = (zip.length / 2 ** 20).toFixed(1);
  ui.showPackReport([
    { level: 'ok', text: `Saved ${name} (${result.files.size} files, ${size} MB). Put it in resourcepacks/, then press F3 + T in game.` },
    ...result.warnings.map((text): ImportLine => ({ level: 'warn', text })),
  ]);
}

// --- Reset and start-up ----------------------------------------------------------------------------

const SAMPLE_HERO = 'test_hero_1063x1502.png';
/** Kept after the first fetch, for the reset button. */
let sampleHero: Blob | null = null;

/** Drops every tab's sky from the screen and memory. */
function dropAllSkies(): void {
  for (const [id, s] of skies) {
    s.converter?.terminate();
    scene.removeSkyLayer(id);
  }
  skies.clear();
}

/**
 * Back to the start: the starter's sky tabs, the test card, and every hero setting. The camera stays where it
 * is. The stored images are forgotten too, and the saved settings become the defaults.
 */
function reset(): void {
  void clearImages();
  ui.clearFileInputs();
  ui.showDropStatus('');
  dropAllSkies();
  packTemplate = null;
  showStarterStatus();
  ui.showPackReport([]);
  tabs = [];
  openTabId = '';
  previewMode = 'blend';
  templateChanged(true);
  updateHero(initialHero); // sliders, mode and texture path; also unpins an import
  ui.showImportStatus([]);
  if (sampleHero) void loadHero(sampleHero, SAMPLE_HERO);
  saveNow();
}

/** Restores the last session's settings at once; the tabs follow once the template has loaded (restoreFiles). */
function restoreSettings(): { session: Session; v1Sky: SavedSky | null } {
  const defaults: Session = { hero: initialHero, view: { ...state.view }, tabs: [], openTabId: '', previewMode: 'blend', pinned: null };
  const saved = readSaved(SAVED_KEY);
  const old = saved === null ? fromSavedV1(readSaved(SAVED_KEY_V1), defaults) : null;
  const session = old?.session ?? fromSaved(saved, defaults);
  state.hero = session.hero;
  Object.assign(state.view, session.view);
  if (session.pinned) {
    state.json = session.pinned.json;
    state.pinned = true;
    importedName = session.pinned.name;
  } else {
    state.json = buildSky3(state.hero);
  }
  previewMode = session.previewMode;
  return { session, v1Sky: old?.sky ?? null };
}

async function restoreFiles(session: Session, hadSaved: boolean, v1Sky: SavedSky | null): Promise<void> {
  const [storedPack, storedHero, heroSample, starterMap] = await Promise.all([
    loadImage('pack'), loadImage('hero'), fetchBlob(testHeroUrl), starterFiles(),
  ]);
  starter = starterMap;
  sampleHero = heroSample;
  if (!(storedPack && await loadPackTemplate(storedPack.blob, storedPack.name, { remember: false, merge: false }))) {
    showStarterStatus();
  }

  // The tabs: as saved, re-linked to the template's layers; or, the first time, one per template layer.
  tabs = session.tabs;
  openTabId = session.openTabId;
  const layers = readTemplate(templateFiles()).skyLayers;
  tabs = mergeTemplate(tabs, layers, newId, { addMissing: tabs.length === 0 });
  if (tabs.length === 0) tabs = [newTab(newId(), 'Night'), newTab(newId(), 'Day')];
  if (!tabById(openTabId)) openTabId = tabs[0].id;

  // A session from before sky tabs: its single sky becomes the Day tab's (decision 17.3.13).
  if (v1Sky) {
    const oldSky = await loadImage('sky');
    const day = tabs.find((t) => t.name.toLowerCase() === 'day') ?? tabs[tabs.length - 1];
    if (oldSky) {
      tabs = tabs.map((t) => (t.id === day.id ? { ...t, sky: { user: { name: oldSky.name }, ...v1Sky } } : t));
      await saveImage(`sky:${day.id}`, oldSky);
    }
    void forgetImage('sky');
    try {
      localStorage.removeItem(SAVED_KEY_V1);
    } catch {
      // Storage blocked: the old entry stays, and is read again only if no new one gets saved.
    }
  }

  // Each tab's own sky. One that has gone missing from storage falls back to the template's or the default.
  const missing: string[] = [];
  await Promise.all(tabs.filter((t) => t.sky.user).map(async (t) => {
    const stored = await loadImage(`sky:${t.id}`);
    if (stored) skyState(t.id).file = stored.blob;
    else missing.push(t.id);
  }));
  if (missing.length > 0) {
    const names = tabs.filter((t) => missing.includes(t.id)).map((t) => t.name);
    tabs = tabs.map((t) => (missing.includes(t.id) ? { ...t, sky: { ...t.sky, user: null } } : t));
    ui.showDropStatus(`The sky images of ${names.join(', ')} weren't found in this browser, so those tabs show `
      + 'the template\'s or the default sky. Load them again.', true);
  }
  tabsChanged();
  showOpenSky();
  saveNow();

  if (storedHero) void loadHero(storedHero.blob, storedHero.name, { keepSize: true });
  else if (heroSample) void loadHero(heroSample, SAMPLE_HERO, { keepSize: hadSaved, standIn: hadSaved });
  else ui.showHeroStatus('The default test card could not be loaded. Choose a hero image.', true);
}

attachDragLook(canvas, () => state.view, updateView);
new ResizeObserver(() => scene.resize(viewport.clientWidth, viewport.clientHeight)).observe(viewport);
const hadSaved = readSaved(SAVED_KEY) !== null || readSaved(SAVED_KEY_V1) !== null;
const restored = restoreSettings();
updateView({});
showJson();
void restoreFiles(restored.session, hadSaved, restored.v1Sky);
