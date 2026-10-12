// Wiring (PLAN §2): ui → state → math → JSON object → scene, readouts and JSON panel (rule 3).

import './style.css';
import placeholderAtlasUrl from '../reference/samples/placeholder_atlas.png';
import testHeroUrl from '../reference/samples/test_hero_1063x1502.png';
import { DEFAULTS, PANO_FACE_RANGE, PANO_LEFT_BEARING_DEG, PANO_LEFT_BEARING_RANGE, RANGES } from './constants.ts';
import type { ConvertReply, ConvertRequest } from './convert.worker.ts';
import { buildSky3, serializeSky3, textureProblem } from './json.ts';
import {
  analyse, atlasLayout, clamp, clampHero, clampPitch, heroCentreDirection, kFromHeight, panoramaLayout, scaleK,
  skyKindFromSize, sunAngleDeg, viewToward, wrapDeg180,
} from './math.ts';
import { SkyScene } from './scene.ts';
import type { AppState, HeroParams, SkyType, ViewState } from './schema.ts';
import { Ui } from './ui.ts';
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
  onSkyFile: (file) => setSky({ file, name: file.name, faceSize: null }),
  onSkyType: (type) => setSky({ type, faceSize: null }),
  onFaceSize: (faceSize) => setSky({ faceSize }),
  onLeftBearingPreview: previewLeftBearing,
  onLeftBearing: (deg) => {
    const leftBearingDeg = clamp(deg, PANO_LEFT_BEARING_RANGE.min, PANO_LEFT_BEARING_RANGE.max);
    previewLeftBearing(leftBearingDeg); // shows at once while the conversion runs
    setSky({ leftBearingDeg });
  },
  onDownloadAtlas: () => { if (atlasPng) ui.download(atlasPng.blob, atlasPng.fileName); },
  onHeroFile: (file) => loadHero(file, file.name),
  onReset: reset,
});

/** The one place the view changes: wrap and clamp, then show it everywhere. */
function updateView(patch: Partial<ViewState>): void {
  const view = Object.assign(state.view, patch); // like copying a patch object's fields onto the state
  view.yawDeg = wrapDeg180(view.yawDeg);
  view.pitchDeg = clampPitch(view.pitchDeg);
  view.fovDeg = clamp(view.fovDeg, RANGES.fovDeg.min, RANGES.fovDeg.max);
  scene.setView(view);
  scene.setSpinDeg(sunAngleDeg(view.timeTicks)); // 0 at the default noon; the time slider arrives in M4
  scene.setOverlayVisible(view.showOverlay);
  ui.showView(view);
}

/** The one place the hero changes: sliders → math → a new JSON object, which everything else reads. */
function updateHero(patch: Partial<HeroParams>): void {
  state.hero = clampHero({ ...state.hero, ...patch });
  state.json = buildSky3(state.hero);
  state.pinned = false;
  showJson();
}

function showJson(): void {
  const { hero, json } = state;
  const [x] = json.properties.rotation.mapping['0'];
  scene.applyJson(json);
  ui.showHero({
    hero,
    json,
    jsonText: serializeSky3(json),
    readouts: analyse(json.animatableTextures[0].uvRange, x, hero.imageW / hero.imageH),
    textureProblem: textureProblem(json.animatableTextures[0].texture),
  });
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
const sky: { file: Blob | null; name: string; type: SkyType; faceSize: number | null; leftBearingDeg: number } =
  { file: null, name: '', type: 'auto', faceSize: null, leftBearingDeg: PANO_LEFT_BEARING_DEG };
/** Counts loads, so a slow decode that a newer load has overtaken is dropped. */
let skyLoads = 0;
let converter: Worker | null = null;
let atlasPng: { blob: Blob; fileName: string } | null = null;
/** The left edge the atlas on screen was converted with; null when the sky came from an atlas file. */
let shownLeftBearing: number | null = null;

function setSky(patch: Partial<typeof sky>): void {
  Object.assign(sky, patch);
  void loadSky(); // `void` marks a promise we deliberately don't wait for
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

/**
 * The hero keeps its alpha exactly as stored (no premultiplying), as Minecraft does, and is flipped
 * here because WebGL can't flip an ImageBitmap on upload. Its size fills in the W × H boxes.
 */
let heroLoads = 0;

async function loadHero(source: Blob, name: string): Promise<void> {
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
  updateHero({ imageW: image.width, imageH: image.height });
}

// --- The bundled samples (BRIEF §8), until the user picks their own files ---------------------

const SAMPLE_SKY = 'placeholder_atlas.png';
const SAMPLE_HERO = 'test_hero_1063x1502.png';
/** Kept after the first fetch, for the reset button. */
const samples: { sky: Blob | null; hero: Blob | null } = { sky: null, hero: null };

/** Back to the start: the sample sky and test card, and every hero setting. The camera stays where it is. */
function reset(): void {
  ui.clearFileInputs();
  ui.showSkyType('auto');
  if (samples.sky) {
    setSky({ file: samples.sky, name: SAMPLE_SKY, type: 'auto', faceSize: null, leftBearingDeg: PANO_LEFT_BEARING_DEG });
  }
  updateHero(initialHero); // sliders, mode, texture path and layer
  if (samples.hero) void loadHero(samples.hero, SAMPLE_HERO);
}

attachDragLook(canvas, () => state.view, updateView);
new ResizeObserver(() => scene.resize(viewport.clientWidth, viewport.clientHeight)).observe(viewport);
updateView({});
showJson();

fetch(placeholderAtlasUrl)
  .then((response) => response.blob())
  .then((file) => {
    samples.sky = file;
    setSky({ file, name: SAMPLE_SKY });
  })
  .catch(() => ui.showSkyStatus('The default atlas could not be loaded. Choose a sky file.', true));
fetch(testHeroUrl)
  .then((response) => response.blob())
  .then((blob) => {
    samples.hero = blob;
    return loadHero(blob, SAMPLE_HERO);
  })
  .catch(() => ui.showHeroStatus('The default test card could not be loaded. Choose a hero image.', true));
