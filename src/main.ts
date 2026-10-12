// Wiring (PLAN §2): ui → state → math → JSON object → scene, readouts and JSON panel (rule 3).

import './style.css';
import placeholderAtlasUrl from '../reference/samples/placeholder_atlas.png';
import testHeroUrl from '../reference/samples/test_hero_1063x1502.png';
import { DEFAULTS, RANGES } from './constants.ts';
import { buildSky3, serializeSky3, textureProblem } from './json.ts';
import {
  analyse, atlasLayout, clamp, clampHero, clampPitch, heroCentreDirection, kFromHeight, scaleK, sunAngleDeg,
  viewToward, wrapDeg180,
} from './math.ts';
import { SkyScene } from './scene.ts';
import type { AppState, HeroParams, ViewState } from './schema.ts';
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
  onAtlasFile: (file) => loadAtlas(file, file.name),
  onHeroFile: (file) => loadHero(file, file.name),
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

async function loadAtlas(source: Blob, name: string): Promise<void> {
  const image = await decode(source, {}, (m) => ui.showAtlasStatus(m, true), name);
  if (!image) return;
  const layout = atlasLayout(image.width, image.height);
  if (layout.ok) {
    scene.setAtlas(image, layout.faceSize);
    ui.showAtlasStatus(`${name} · ${image.width} × ${image.height} · faces ${layout.faceSize} px`);
  } else {
    ui.showAtlasStatus(`${name}: ${layout.message} The previous atlas is still shown.`, true);
  }
  image.close(); // the cropped canvases hold their own copies
}

/**
 * The hero keeps its alpha exactly as stored (no premultiplying), as Minecraft does, and is flipped
 * here because WebGL can't flip an ImageBitmap on upload. Its size fills in the W × H boxes.
 */
async function loadHero(source: Blob, name: string): Promise<void> {
  const image = await decode(source, { premultiplyAlpha: 'none', imageOrientation: 'flipY' },
    (m) => ui.showHeroStatus(m, true), name);
  if (!image) return;
  scene.setHeroImage(image); // the scene owns the image from here on
  ui.showHeroStatus(`${name} · ${image.width} × ${image.height}`);
  updateHero({ imageW: image.width, imageH: image.height });
}

attachDragLook(canvas, () => state.view, updateView);
new ResizeObserver(() => scene.resize(viewport.clientWidth, viewport.clientHeight)).observe(viewport);
updateView({});
showJson();

// The bundled samples (BRIEF §8), until the user picks their own files.
fetch(placeholderAtlasUrl)
  .then((response) => response.blob())
  .then((blob) => loadAtlas(blob, 'placeholder_atlas.png'))
  .catch(() => ui.showAtlasStatus('The default atlas could not be loaded. Choose an atlas file.', true));
fetch(testHeroUrl)
  .then((response) => response.blob())
  .then((blob) => loadHero(blob, 'test_hero_1063x1502.png'))
  .catch(() => ui.showHeroStatus('The default test card could not be loaded. Choose a hero image.', true));
