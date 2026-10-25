// Wiring (PLAN §2): ui → state → math → JSON object → scene, readouts and JSON panel (rule 3).

import './style.css';
import placeholderAtlasUrl from '../reference/samples/placeholder_atlas.png';
import testHeroUrl from '../reference/samples/test_hero_1063x1502.png';
import {
  DEFAULTS, PANO_FACE_RANGE, PANO_LEFT_BEARING_DEG, PANO_LEFT_BEARING_RANGE, RANGES, TICKS_PER_DAY,
} from './constants.ts';
import type { ConvertReply, ConvertRequest } from './convert.worker.ts';
import { clearImages, forgetImage, loadImage, saveImage } from './imagestore.ts';
import {
  applyImport, buildSky3, editPinned, exportProblems, HERO_MCMETA, isJsonFile, mcmetaFileName, parseSky3,
  serializeSky3, SKY3_FILENAME, textureProblem,
} from './json.ts';
import {
  advanceTicks, analyse, atlasLayout, clamp, clampHero, clampPitch, heroCentreDirection, importAspectMismatch,
  kFromHeight, mod, panoramaLayout, scaleK, skyKindFromSize, sunAngleDeg, viewToward, wrapDeg180,
} from './math.ts';
import { assemblePack, isPng, isZipFile, readTemplate, readZip, writeZip, type PackFiles } from './pack.ts';
import { fromSaved, SAVED_KEY, toSaved, type Session } from './saved.ts';
import { SkyScene } from './scene.ts';
import type { AppState, HeroParams, Readouts, SkyTarget, SkyType, ViewState } from './schema.ts';
import { Ui, type DropTarget, type ImportLine } from './ui.ts';
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

const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const scene = new SkyScene(canvas);
const ui = new Ui({
  onView: updateView,
  onHero: updateHero,
  onScale: (factor) => updateHero({ k: scaleK(state.hero.k, factor) }),
  onLookAtHero: lookAtHero,
  onSkyFile: pickSky,
  onSkyType: (type) => setSky({ type, faceSize: null }),
  onFaceSize: (faceSize) => setSky({ faceSize }),
  onLeftBearingPreview: previewLeftBearing,
  onLeftBearing: (deg) => {
    const leftBearingDeg = clamp(deg, PANO_LEFT_BEARING_RANGE.min, PANO_LEFT_BEARING_RANGE.max);
    previewLeftBearing(leftBearingDeg); // shows at once while the conversion runs
    setSky({ leftBearingDeg });
  },
  onDownloadAtlas: () => { if (atlasPng) ui.download(atlasPng.blob, atlasPng.fileName); },
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
  onPackFile: (file) => void loadPackTemplate(file, file.name, true),
  onPackSky: (target) => {
    packSky = target;
    scheduleSave();
  },
  onAssemble: () => void assemble(),
  onUseStarter: () => {
    packTemplate = null;
    void forgetImage('pack');
    ui.clearFileInputs();
    showStarterStatus();
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
  showTime();
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

/** The line under the time slider, including where the hero faces at this time. */
function showTime(): void {
  const theta = sunAngleDeg(state.view.timeTicks);
  const { uvRange } = state.json.animatableTextures[0];
  const facing = viewToward(heroCentreDirection(uvRange, state.json.properties.rotation.mapping['0'], theta));
  ui.showTime(state.view.timeTicks, theta, facing.yawDeg);
}

// --- Hero and JSON ---------------------------------------------------------------------------------

/** Controls that may change a pinned (imported) JSON without regenerating its uvRange and mapping (PLAN §14.3). */
const PINNED_SAFE: ReadonlySet<string> = new Set<keyof HeroParams>(['texture', 'layer']);
/** The file the pinned JSON came from, for the note above it. */
let importedName = '';

/**
 * The one place the hero changes: controls → math → a new JSON object, which everything else reads.
 * While pinned to an import, texture and layer edits (and loading a hero image) keep the JSON as loaded;
 * any size or position control regenerates it from the controls and unpins it.
 */
function updateHero(patch: Partial<HeroParams>, fromImage = false): void {
  state.hero = clampHero({ ...state.hero, ...patch });
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
  state.hero = hero;
  state.json = json;
  state.pinned = true;
  importedName = name;
  const warnings: ImportLine[] = result.warnings.map((w) => ({ level: 'warn', text: w }));
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

// --- Sky: an atlas, or a panorama converted to one (PLAN §13) -------------------------------

/**
 * The current sky file and its settings, kept so a new type, face size or left edge can re-read it.
 * Preview only; never in the JSON. The left edge carries over to the next panorama, which usually
 * comes from the same tool.
 */
const sky: {
  file: Blob | null; name: string; type: SkyType; faceSize: number | null; leftBearingDeg: number;
  /** True for a file the user picked: it is stored for the next visit once it has loaded (PLAN §15.2). */
  remember: boolean;
} = { file: null, name: '', type: 'auto', faceSize: null, leftBearingDeg: PANO_LEFT_BEARING_DEG, remember: false };
/** Counts loads, so a slow decode that a newer load has overtaken is dropped. */
let skyLoads = 0;
let converter: Worker | null = null;
let atlasPng: { blob: Blob; fileName: string } | null = null;
/** The left edge the atlas on screen was converted with; null when the sky came from an atlas file. */
let shownLeftBearing: number | null = null;

function setSky(patch: Partial<typeof sky>): void {
  Object.assign(sky, patch);
  scheduleSave();
  void loadSky(); // `void` marks a promise we deliberately don't wait for
}

function pickSky(file: File): void {
  setSky({ file, name: file.name, faceSize: null, remember: true });
}

/** Stores the sky file for the next visit, once, after it has loaded. */
function rememberSky(): void {
  if (!sky.remember || !sky.file) return;
  sky.remember = false;
  void saveImage('sky', { name: sky.name, blob: sky.file });
}

/** While the left-edge slider moves, turn the sky by the difference instead of converting (PLAN §13.7). */
function previewLeftBearing(leftBearingDeg: number): void {
  if (shownLeftBearing !== null) scene.setSkyTurnDeg(leftBearingDeg - shownLeftBearing);
}

async function loadSky(): Promise<void> {
  const { file, name, type } = sky;
  if (!file) return;
  const load = ++skyLoads;
  converter?.terminate(); // stop a conversion that is still running, like interrupting a thread
  converter = null;
  atlasPng = null;
  ui.showAtlasDownload(false);

  const image = await decode(file, {}, (m) => ui.showSkyStatus(m, true), name);
  if (!image) return;
  if (load !== skyLoads) {
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
      const faceSize = clamp(Math.round(sky.faceSize ?? layout.faceSize), PANO_FACE_RANGE.min, PANO_FACE_RANGE.max);
      const { leftBearingDeg } = sky;
      ui.showPanoramaOptions({ faceSize, leftBearingDeg });
      convertPanorama(image, faceSize, leftBearingDeg, `${name} · ${size} panorama, left edge ${leftBearingDeg}°`, name);
      return;
    }
    const hint = shape === 'atlas' ? ' It is 3:2, so choose Atlas or Auto.' : '';
    ui.showSkyStatus(`${name}: ${layout.message}${hint} ${keep}`, true);
  } else if (kind === 'atlas') {
    const layout = atlasLayout(image.width, image.height);
    if (layout.ok) {
      scene.setAtlas(image, layout.faceSize);
      shownLeftBearing = null;
      skyForPack = { blob: file, width: image.width };
      rememberSky();
      ui.showSkyStatus(`${name} · ${size} atlas · faces ${layout.faceSize} px`);
    } else {
      const hint = shape === 'panorama' ? ' It is 2:1, so choose Panorama or Auto.' : '';
      ui.showSkyStatus(`${name}: ${layout.message}${hint} ${keep}`, true);
    }
  } else {
    ui.showSkyStatus(`${name} is ${size}: a sky must be a 3:2 atlas or a 2:1 panorama. ${keep}`, true);
  }
  ui.showPanoramaOptions(null);
  scene.setSkyTurnDeg(0); // drop any left-edge preview; the sky on screen is unchanged or a new atlas
  image.close(); // the cropped canvases hold their own copies
}

/** Runs the conversion in a worker (PLAN §13.3); the image is handed over to it. */
function convertPanorama(image: ImageBitmap, faceSize: number, leftBearingDeg: number, label: string, name: string): void {
  const started = performance.now();
  const worker = new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' });
  converter = worker;
  ui.showSkyStatus(`${label}: converting…`);

  const finish = (): void => {
    worker.terminate();
    if (converter === worker) converter = null;
  };
  worker.onmessage = (event: MessageEvent<ConvertReply>) => {
    const reply = event.data;
    if (reply.type === 'progress') {
      ui.showSkyStatus(reply.stage === 'convert'
        ? `${label}: converting, face ${reply.done} of ${reply.total}…`
        : `${label}: writing the atlas PNG…`);
      return;
    }
    finish();
    if (reply.type === 'done') {
      scene.setAtlas(reply.atlas, faceSize); // also ends the preview turn
      shownLeftBearing = leftBearingDeg;
      reply.atlas.close();
      atlasPng = { blob: reply.png, fileName: `${name.replace(/\.[^.]*$/, '')}_atlas.png` };
      ui.showAtlasDownload(true);
      skyForPack = { blob: reply.png, width: 3 * faceSize };
      rememberSky();
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      ui.showSkyStatus(`${label} → atlas ${3 * faceSize} × ${2 * faceSize} (faces ${faceSize} px) · ${seconds} s`);
    } else {
      scene.setSkyTurnDeg(0);
      ui.showSkyStatus(`${label}: the conversion failed (${reply.message}). The previous sky is still shown.`, true);
    }
  };
  worker.onerror = () => {
    finish();
    scene.setSkyTurnDeg(0);
    ui.showSkyStatus(`${label}: the converter stopped unexpectedly. The previous sky is still shown.`, true);
  };
  const request: ConvertRequest = { image, faceSize, leftBearingDeg };
  worker.postMessage(request, [image]);
}

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
 * Import, a 3:2 or 2:1 image to the Sky, any other image to the Hero; the note says where each went.
 */
async function dropFiles(files: File[], target: DropTarget): Promise<void> {
  const notes: string[] = [];
  let problem = false;
  for (const file of files) {
    if (target === 'import' || (target === 'auto' && isJsonFile(file.name, file.type))) importFile(file);
    else if (target === 'pack' || (target === 'auto' && isZipFile(file.name, file.type))) {
      void loadPackTemplate(file, file.name, true);
      if (target === 'auto') notes.push(`${file.name} is the pack template now.`);
    }
    else if (target === 'sky') pickSky(file);
    else if (target === 'hero') pickHero(file);
    else {
      const size = await imageSize(file);
      const shape = size && skyKindFromSize(size.width, size.height);
      if (!size) {
        notes.push(`${file.name} is neither an image nor a .json, so it wasn't used.`);
        problem = true;
      } else if (shape) {
        pickSky(file);
        notes.push(`${file.name} went to the Sky, as it is ${shape === 'atlas' ? '3:2' : '2:1'}. `
          + 'Drop it on the Hero row to use it as the hero.');
      } else {
        pickHero(file);
        notes.push(`${file.name} went to the Hero. Drop it on the Sky row to use it as the sky.`);
      }
    }
  }
  ui.showDropStatus(notes.join(' '), problem);
}

// --- Remembering the last session (PLAN §15.2) -------------------------------------------------

let saveTimer = 0;

/** Saves the settings half a second after the last change; during Play that means once it pauses. */
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(SAVED_KEY, toSaved(currentSession()));
    } catch {
      // Storage blocked or full: the settings just won't be remembered.
    }
  }, 500);
}

function currentSession(): Session {
  const { timeTicks, ticksPerSecond, fovDeg, yawDeg, pitchDeg, showOverlay } = state.view;
  return {
    hero: state.hero,
    view: { timeTicks, ticksPerSecond, fovDeg, yawDeg, pitchDeg, showOverlay },
    sky: { type: sky.type, faceSize: sky.faceSize, leftBearingDeg: sky.leftBearingDeg },
    pinned: state.pinned ? { json: state.json, name: importedName } : null,
    packSky,
  };
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(SAVED_KEY);
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

// --- Resource pack (PLAN §16) ----------------------------------------------------------------------

/** The uploaded template, if any; without one, the bundled starter is used. */
let packTemplate: { name: string; files: PackFiles } | null = null;
let packSky: SkyTarget = 'day';
/** What Assemble pack puts in: the current sky as loaded (or as converted) and the hero's own file. */
let skyForPack: { blob: Blob; width: number } | null = null;
let heroForPack: Blob | null = null;

/** The starter template's files, bundled by Vite: path in the repo → URL on the site. Fetched only when used. */
const STARTER_NAME = 'NuitSkyTestPack_26_2.zip';
const STARTER_PREFIX = '../reference/samples/starter_pack/';
const starterUrls = import.meta.glob('../reference/samples/starter_pack/**/*',
  { query: '?url', import: 'default', eager: true }) as Record<string, string>;

async function starterFiles(): Promise<PackFiles> {
  const entries = await Promise.all(Object.entries(starterUrls).map(async ([path, url]) =>
    [path.slice(STARTER_PREFIX.length), new Uint8Array(await (await fetch(url)).arrayBuffer())] as const));
  return new Map(entries);
}

function showStarterStatus(): void {
  ui.showPackStatus(`Template: the starter (${STARTER_NAME}), with placeholder skies and a test hero. `
    + 'Choose or drop your own template to use it instead.');
}

/** Reads a template zip. A bad one is reported, and the template in use stays. */
async function loadPackTemplate(source: Blob, name: string, remember: boolean): Promise<void> {
  const keep = packTemplate ? `${packTemplate.name} is still used.` : 'The starter template is still used.';
  let files: PackFiles;
  try {
    files = readZip(new Uint8Array(await source.arrayBuffer()));
  } catch {
    ui.showPackStatus(`${name} could not be read as a zip. ${keep}`, true, packTemplate !== null);
    return;
  }
  const info = readTemplate(files);
  if (info.problems.length > 0) {
    ui.showPackStatus(`${name}: ${info.problems.join(' ')} ${keep}`, true, packTemplate !== null);
    return;
  }
  packTemplate = { name, files };
  if (remember) void saveImage('pack', { name, blob: source });
  const skies = info.skyLayers.map((l) => l.role).join(' and ') || 'no';
  ui.showPackStatus(`Template: ${name} · ${files.size} files · ${skies} sky layers and a hero layer.`, false, true);
  ui.showPackReport(info.warnings.map((text) => ({ level: 'warn', text })));
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

/** Builds the pack and downloads it (PLAN §16.2). Red errors are asked about first, as for export. */
async function assemble(): Promise<void> {
  const errors = currentReadouts().warnings.filter((w) => w.level === 'error').map((w) => w.message);
  if (errors.length > 0 && !ui.confirmExport(errors)) return;
  if (!heroForPack) {
    ui.showPackReport([{ level: 'error', text: 'Load a hero image first.' }]);
    return;
  }
  ui.showPackReport([{ level: 'ok', text: 'Assembling…' }]);
  const [template, heroPng, skyPng] = await Promise.all([
    packTemplate ? Promise.resolve(packTemplate.files) : starterFiles(),
    pngBytes(heroForPack),
    skyForPack ? pngBytes(skyForPack.blob) : Promise.resolve(null),
  ]);
  if (!heroPng) {
    ui.showPackReport([{ level: 'error', text: 'The hero image could not be read.' }]);
    return;
  }
  const result = assemblePack(template, {
    jsonText: serializeSky3(state.json),
    texture: state.json.animatableTextures[0].texture,
    heroPng,
    skyPng,
    skyWidth: skyForPack?.width ?? 0,
    skyTarget: packSky,
  });
  if (!result.ok) {
    ui.showPackReport(result.problems.map((text) => ({ level: 'error', text })));
    return;
  }
  const fileName = `${(packTemplate?.name ?? STARTER_NAME).replace(/\.zip$/i, '')}_skybuilder.zip`;
  // fflate always returns a plain ArrayBuffer-backed array; the cast tells TypeScript so for Blob.
  const zip = writeZip(result.files) as Uint8Array<ArrayBuffer>;
  ui.download(new Blob([zip], { type: 'application/zip' }), fileName);
  const size = (zip.length / 2 ** 20).toFixed(1);
  ui.showPackReport([
    { level: 'ok', text: `Saved ${fileName} (${result.files.size} files, ${size} MB). Put it in resourcepacks/, then press F3 + T in game.` },
    ...result.warnings.map((text): ImportLine => ({ level: 'warn', text })),
  ]);
}

// --- The bundled samples (BRIEF §8), until the user picks their own files ---------------------

const SAMPLE_SKY = 'placeholder_atlas.png';
const SAMPLE_HERO = 'test_hero_1063x1502.png';
/** Kept after the first fetch, for the reset button. */
const samples: { sky: Blob | null; hero: Blob | null } = { sky: null, hero: null };

/**
 * Back to the start: the sample sky and test card, and every hero setting. The camera stays where it is.
 * The stored images are forgotten too, and the saved settings become the defaults.
 */
function reset(): void {
  void clearImages();
  ui.clearFileInputs();
  ui.showSkyType('auto');
  ui.showDropStatus('');
  if (samples.sky) {
    setSky({ file: samples.sky, name: SAMPLE_SKY, type: 'auto', faceSize: null, leftBearingDeg: PANO_LEFT_BEARING_DEG, remember: false });
  }
  updateHero(initialHero); // sliders, mode, texture path and layer; also unpins an import
  ui.showImportStatus([]);
  packTemplate = null;
  packSky = 'day';
  ui.showPackSky(packSky);
  ui.showPackReport([]);
  showStarterStatus();
  if (samples.hero) void loadHero(samples.hero, SAMPLE_HERO);
}

/** Restores the last session's settings at once, then its files (or the samples) as they load. */
function restoreSettings(): Session {
  const saved = readSaved();
  const session = fromSaved(saved, {
    hero: initialHero,
    view: { ...state.view },
    sky: { type: 'auto', faceSize: null, leftBearingDeg: PANO_LEFT_BEARING_DEG },
    pinned: null,
    packSky: 'day',
  });
  packSky = session.packSky;
  ui.showPackSky(packSky);
  state.hero = session.hero;
  Object.assign(state.view, session.view);
  if (session.pinned) {
    state.json = session.pinned.json;
    state.pinned = true;
    importedName = session.pinned.name;
  } else {
    state.json = buildSky3(state.hero);
  }
  return session;
}

async function restoreFiles(session: Session, hadSaved: boolean): Promise<void> {
  const [storedSky, storedHero, storedPack, sampleSky, sampleHero] = await Promise.all([
    loadImage('sky'), loadImage('hero'), loadImage('pack'), fetchBlob(placeholderAtlasUrl), fetchBlob(testHeroUrl),
  ]);
  if (storedPack) void loadPackTemplate(storedPack.blob, storedPack.name, false);
  else showStarterStatus();
  samples.sky = sampleSky;
  samples.hero = sampleHero;

  if (storedSky) {
    ui.showSkyType(session.sky.type);
    setSky({ ...session.sky, file: storedSky.blob, name: storedSky.name, remember: false });
  } else if (sampleSky) {
    setSky({ file: sampleSky, name: SAMPLE_SKY });
  } else {
    ui.showSkyStatus('The default atlas could not be loaded. Choose a sky file.', true);
  }

  if (storedHero) void loadHero(storedHero.blob, storedHero.name, { keepSize: true });
  else if (sampleHero) void loadHero(sampleHero, SAMPLE_HERO, { keepSize: hadSaved, standIn: hadSaved });
  else ui.showHeroStatus('The default test card could not be loaded. Choose a hero image.', true);
}

attachDragLook(canvas, () => state.view, updateView);
new ResizeObserver(() => scene.resize(viewport.clientWidth, viewport.clientHeight)).observe(viewport);
const hadSaved = readSaved() !== null;
const session = restoreSettings();
updateView({});
showJson();
void restoreFiles(session, hadSaved);
