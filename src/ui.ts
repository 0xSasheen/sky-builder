// Controls and readouts, in plain DOM (PLAN §8). The UI never changes state itself:
// it reports what the user did through the handlers, and main.ts calls show*() with the result.

import { RANGES } from './constants.ts';
import { mcFacing, mcYawPitch } from './math.ts';
import type { ViewState } from './schema.ts';

export interface UiHandlers {
  onView(patch: Partial<ViewState>): void;
  onAtlasFile(file: File): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/**
 * Links a slider to its number box. Either one calls onInput; the returned setter updates both
 * without firing events. Like a small Java listener class registered on two components.
 * A box that has focus is left alone, so the value isn't rewritten while someone is typing.
 */
function bindRange(
  range: HTMLInputElement,
  num: HTMLInputElement,
  limits: { min: number; max: number },
  onInput: (value: number) => void,
): (value: number) => void {
  for (const el of [range, num]) {
    el.min = String(limits.min);
    el.max = String(limits.max);
  }
  range.addEventListener('input', () => onInput(range.valueAsNumber));
  num.addEventListener('input', () => {
    if (Number.isFinite(num.valueAsNumber)) onInput(num.valueAsNumber);
  });
  let current = 0;
  num.addEventListener('blur', () => { num.value = fmt(current); }); // show the value actually used
  return (value: number) => {
    current = value;
    range.value = String(value);
    if (document.activeElement !== num) num.value = fmt(value);
  };
}

/** One decimal place, never "-0.0". */
const fmt = (x: number): string => (Math.round(x * 10) / 10 + 0).toFixed(1);

export class Ui {
  private readonly setYaw: (v: number) => void;
  private readonly setPitch: (v: number) => void;
  private readonly setFov: (v: number) => void;
  private readonly overlay = byId<HTMLInputElement>('overlay');
  private readonly hud = byId<HTMLDivElement>('hud');
  private readonly atlasStatus = byId<HTMLParagraphElement>('atlas-status');

  constructor(handlers: UiHandlers) {
    this.setYaw = bindRange(byId('yaw'), byId('yaw-num'), RANGES.yawDeg, (yawDeg) => handlers.onView({ yawDeg }));
    this.setPitch = bindRange(byId('pitch'), byId('pitch-num'), RANGES.pitchDeg, (pitchDeg) => handlers.onView({ pitchDeg }));
    this.setFov = bindRange(byId('fov'), byId('fov-num'), RANGES.fovDeg, (fovDeg) => handlers.onView({ fovDeg }));
    this.overlay.addEventListener('change', () => handlers.onView({ showOverlay: this.overlay.checked }));
    byId('look-north').addEventListener('click', () => handlers.onView({ yawDeg: 0, pitchDeg: 0 }));

    const atlasFile = byId<HTMLInputElement>('atlas-file');
    atlasFile.addEventListener('change', () => {
      const file = atlasFile.files?.[0];
      if (file) handlers.onAtlasFile(file);
    });
  }

  showView(view: ViewState): void {
    this.setYaw(view.yawDeg);
    this.setPitch(view.pitchDeg);
    this.setFov(view.fovDeg);
    this.overlay.checked = view.showOverlay;

    // Also what Minecraft's F3 screen would show for the same view, to line the preview up with the game.
    const mc = mcYawPitch(view.yawDeg, view.pitchDeg);
    this.hud.textContent =
      `Bearing ${fmt(view.yawDeg)}° · pitch ${fmt(view.pitchDeg)}° · FOV ${Math.round(view.fovDeg)}\n`
      + `In game (F3): Facing ${mcFacing(view.yawDeg)} (${fmt(mc.yaw)} / ${fmt(mc.pitch)})`;
  }

  showAtlasStatus(text: string, isError = false): void {
    this.atlasStatus.textContent = text;
    this.atlasStatus.classList.toggle('error', isError);
  }
}
