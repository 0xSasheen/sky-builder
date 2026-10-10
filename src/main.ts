// Wiring (PLAN §2): ui → state → scene. M2 has only the view and the sky; the hero and JSON arrive in M3.

import './style.css';
import placeholderAtlasUrl from '../reference/samples/placeholder_atlas.png';
import { DEFAULTS, RANGES } from './constants.ts';
import { atlasLayout, clamp, clampPitch, sunAngleDeg, wrapDeg180 } from './math.ts';
import { SkyScene } from './scene.ts';
import type { ViewState } from './schema.ts';
import { Ui } from './ui.ts';
import { attachDragLook } from './view.ts';

const view: ViewState = {
  timeTicks: DEFAULTS.timeTicks,
  playing: false,
  fovDeg: DEFAULTS.fovDeg,
  yawDeg: DEFAULTS.yawDeg,
  pitchDeg: DEFAULTS.pitchDeg,
  showOverlay: false,
};

const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const scene = new SkyScene(canvas);
const ui = new Ui({ onView: updateView, onAtlasFile: (file) => loadAtlas(file, file.name) });

/** The one place the view changes: wrap and clamp, then show it everywhere. */
function updateView(patch: Partial<ViewState>): void {
  Object.assign(view, patch); // like copying the non-null fields of a patch object onto the state
  view.yawDeg = wrapDeg180(view.yawDeg);
  view.pitchDeg = clampPitch(view.pitchDeg);
  view.fovDeg = clamp(view.fovDeg, RANGES.fovDeg.min, RANGES.fovDeg.max);
  scene.setView(view);
  scene.setSpinDeg(sunAngleDeg(view.timeTicks)); // 0 at the default noon; the time slider arrives in M4
  scene.setOverlayVisible(view.showOverlay);
  ui.showView(view);
}

/**
 * Decodes an atlas in the browser; nothing is uploaded. colorSpaceConversion 'none' ignores any
 * colour profile in the PNG, as Minecraft's image loader does, so the pixels match the game's.
 */
async function loadAtlas(source: Blob, name: string): Promise<void> {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(source, { colorSpaceConversion: 'none' });
  } catch {
    ui.showAtlasStatus(`${name} could not be read as an image.`, true);
    return;
  }
  const layout = atlasLayout(image.width, image.height);
  if (layout.ok) {
    scene.setAtlas(image, layout.faceSize);
    ui.showAtlasStatus(`${name} · ${image.width} × ${image.height} · faces ${layout.faceSize} px`);
  } else {
    ui.showAtlasStatus(`${name}: ${layout.message} The previous atlas is still shown.`, true);
  }
  image.close(); // the cropped canvases hold their own copies
}

attachDragLook(canvas, () => view, updateView);
new ResizeObserver(() => scene.resize(viewport.clientWidth, viewport.clientHeight)).observe(viewport);
updateView({});

fetch(placeholderAtlasUrl)
  .then((response) => response.blob())
  .then((blob) => loadAtlas(blob, 'placeholder_atlas.png'))
  .catch(() => ui.showAtlasStatus('The default atlas could not be loaded. Choose an atlas file.', true));
