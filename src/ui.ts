// Controls and readouts, in plain DOM (PLAN §8). The UI never changes state itself:
// it reports what the user did through the handlers, and main.ts calls show*() with the result.

import { FACE_WARN_LIMIT, K_RANGE, RANGES } from './constants.ts';
import { heightFromK, kFromHeight, mcFacing, mcYawPitch, noonBearingDeg, quadrantBearing } from './math.ts';
import type { HeroMode, HeroParams, Readouts, Sky3Json, ViewState } from './schema.ts';

export interface UiHandlers {
  onView(patch: Partial<ViewState>): void;
  onHero(patch: Partial<HeroParams>): void;
  /** A scale button: multiply k by this factor (BRIEF §6.1). */
  onScale(factor: number): void;
  onLookAtHero(): void;
  onAtlasFile(file: File): void;
  onHeroFile(file: File): void;
}

/** What the hero part of the panel shows; everything after `hero` comes from the JSON object. */
export interface HeroView {
  hero: HeroParams;
  json: Sky3Json;
  jsonText: string;
  readouts: Readouts;
  textureProblem: string | null;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/** Fixed decimal places, never "-0.00". */
const fixed = (x: number, dp: number): string => {
  const s = x.toFixed(dp);
  return Number(s) === 0 ? (0).toFixed(dp) : s;
};

/**
 * A number box. It calls onInput while typing (when the text is a number), and the returned setter
 * updates it without firing events. A box that has focus is left alone, so the value isn't rewritten
 * while someone is typing; it shows the value actually used when it loses focus.
 */
function bindNumber(num: HTMLInputElement, dp: number, onInput: (value: number) => void): (value: number) => void {
  num.addEventListener('input', () => {
    if (Number.isFinite(num.valueAsNumber)) onInput(num.valueAsNumber);
  });
  let current = 0;
  num.addEventListener('blur', () => { num.value = fixed(current, dp); });
  return (value: number) => {
    current = value;
    if (document.activeElement !== num) num.value = fixed(value, dp);
  };
}

/** Links a slider to its number box, like a small Java listener class registered on both components. */
function bindRange(
  range: HTMLInputElement,
  num: HTMLInputElement,
  limits: { min: number; max: number },
  dp: number,
  onInput: (value: number) => void,
): (value: number) => void {
  for (const el of [range, num]) {
    el.min = String(limits.min);
    el.max = String(limits.max);
  }
  range.addEventListener('input', () => onInput(range.valueAsNumber));
  const setNum = bindNumber(num, dp, onInput);
  return (value: number) => {
    range.value = String(value); // the slider pins itself to its ends; the box shows the real value
    setNum(value);
  };
}

/** A distance to a limit: "0.314 inside", "0.010 over", or "at" when it rounds to zero. */
const margin = (m: number, dp: number, limit: string, unit = ''): string => {
  const size = fixed(Math.abs(m), dp);
  if (Number(size) === 0) return `at the ${limit}${unit} limit`;
  return `${size}${unit} ${m > 0 ? 'inside' : 'over'} the ${limit}${unit} limit`;
};

export class Ui {
  private readonly setYaw: (v: number) => void;
  private readonly setPitch: (v: number) => void;
  private readonly setFov: (v: number) => void;
  private readonly setHeight: (v: number) => void;
  private readonly setK: (v: number) => void;
  private readonly setWallTop: (v: number) => void;
  private readonly setBottom: (v: number) => void;
  private readonly setTurn: (v: number) => void;
  private readonly setImageW: (v: number) => void;
  private readonly setImageH: (v: number) => void;
  private readonly setLayer: (v: number) => void;
  private readonly overlay = byId<HTMLInputElement>('overlay');
  private readonly hud = byId<HTMLDivElement>('hud');
  private readonly atlasStatus = byId<HTMLParagraphElement>('atlas-status');
  private readonly heroStatus = byId<HTMLParagraphElement>('hero-status');
  private readonly modes = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
  private readonly modeRows = [...document.querySelectorAll<HTMLElement>('[data-mode]')];
  private readonly texture = byId<HTMLInputElement>('texture');
  private readonly textureProblem = byId<HTMLParagraphElement>('texture-problem');
  private readonly turnHint = byId<HTMLParagraphElement>('turn-hint');
  private readonly readouts = byId<HTMLDListElement>('readouts');
  private readonly warnings = byId<HTMLUListElement>('warnings');
  private readonly jsonOut = byId<HTMLPreElement>('json-out');

  constructor(handlers: UiHandlers) {
    // --- Preview
    this.setYaw = bindRange(byId('yaw'), byId('yaw-num'), RANGES.yawDeg, 1, (yawDeg) => handlers.onView({ yawDeg }));
    this.setPitch = bindRange(byId('pitch'), byId('pitch-num'), RANGES.pitchDeg, 1, (pitchDeg) => handlers.onView({ pitchDeg }));
    this.setFov = bindRange(byId('fov'), byId('fov-num'), RANGES.fovDeg, 0, (fovDeg) => handlers.onView({ fovDeg }));
    this.overlay.addEventListener('change', () => handlers.onView({ showOverlay: this.overlay.checked }));
    byId('look-north').addEventListener('click', () => handlers.onView({ yawDeg: 0, pitchDeg: 0 }));
    byId('look-hero').addEventListener('click', () => handlers.onLookAtHero());

    // --- Files
    for (const [id, handler] of [['atlas-file', handlers.onAtlasFile], ['hero-file', handlers.onHeroFile]] as const) {
      const input = byId<HTMLInputElement>(id);
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) handler(file);
      });
    }
    this.setImageW = bindNumber(byId('image-w'), 0, (imageW) => handlers.onHero({ imageW }));
    this.setImageH = bindNumber(byId('image-h'), 0, (imageH) => handlers.onHero({ imageH }));

    // --- Hero. Size is stored as k; the β controls are a view of it (PLAN §3).
    for (const radio of this.modes) {
      radio.addEventListener('change', () => handlers.onHero({ mode: radio.value as HeroMode }));
    }
    this.setHeight = bindRange(byId('height'), byId('height-num'), RANGES.heightDeg, 2,
      (heightDeg) => handlers.onHero({ k: kFromHeight(heightDeg) }));
    byId<HTMLInputElement>('height-num').max = String(heightFromK(K_RANGE.max)); // the box may go past the slider
    this.setK = bindNumber(byId('k-num'), 6, (k) => handlers.onHero({ k }));
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-scale]')) {
      const f = Number(button.dataset.scale);
      button.addEventListener('click', () => handlers.onScale('divide' in button.dataset ? 1 / f : f));
    }
    this.setWallTop = bindRange(byId('wall-top'), byId('wall-top-num'), RANGES.wallTopT, 3, (wallTopT) => handlers.onHero({ wallTopT }));
    this.setBottom = bindRange(byId('bottom'), byId('bottom-num'), RANGES.bottomDeg, 2, (bottomDeg) => handlers.onHero({ bottomDeg }));
    this.setTurn = bindRange(byId('turn'), byId('turn-num'), RANGES.mappingYDeg, 2, (mappingYDeg) => handlers.onHero({ mappingYDeg }));

    // --- Output
    this.texture.addEventListener('input', () => handlers.onHero({ texture: this.texture.value }));
    this.setLayer = bindNumber(byId('layer'), 0, (layer) => handlers.onHero({ layer }));
  }

  showView(view: ViewState): void {
    this.setYaw(view.yawDeg);
    this.setPitch(view.pitchDeg);
    this.setFov(view.fovDeg);
    this.overlay.checked = view.showOverlay;

    // Also what Minecraft's F3 screen would show for the same view, to line the preview up with the game.
    const mc = mcYawPitch(view.yawDeg, view.pitchDeg);
    this.hud.textContent =
      `Bearing ${fixed(view.yawDeg, 1)}° · pitch ${fixed(view.pitchDeg, 1)}° · FOV ${Math.round(view.fovDeg)}\n`
      + `In game (F3): Facing ${mcFacing(view.yawDeg)} (${fixed(mc.yaw, 1)} / ${fixed(mc.pitch, 1)})`;
  }

  showHero({ hero, json, jsonText, readouts: r, textureProblem }: HeroView): void {
    for (const radio of this.modes) radio.checked = radio.value === hero.mode;
    for (const row of this.modeRows) row.hidden = row.dataset.mode !== hero.mode;
    this.setHeight(heightFromK(hero.k));
    this.setK(hero.k);
    this.setWallTop(hero.wallTopT);
    this.setBottom(hero.bottomDeg);
    this.setTurn(hero.mappingYDeg);
    this.setImageW(hero.imageW);
    this.setImageH(hero.imageH);
    this.setLayer(hero.layer);
    if (document.activeElement !== this.texture) this.texture.value = hero.texture;
    this.textureProblem.textContent = textureProblem ?? '';

    // Everything below describes the JSON, the values Nuit will read.
    const [x, y] = json.properties.rotation.mapping['0'];
    const q = quadrantBearing(noonBearingDeg(y));
    const facing = q.deg === 0 ? `due ${q.from === 'N' ? 'north' : 'south'}`
      : q.deg === 90 ? `due ${q.to === 'E' ? 'east' : 'west'}`
      : `${q.from} ${fixed(q.deg, 2)}° ${q.to}`;
    this.turnHint.textContent = `At noon the hero faces ${facing}. Positive ψ turns it toward the west.`;

    // The cell-edge limits apply to how far the hero reaches on the face, max |t| and max |s|.
    // In tilted mode those are exactly k and ak; in wall mode the top edge t_t sets the vertical one.
    // A hero with no height (the 'empty' error) has no meaningful size, so those rows show a dash.
    const empty = r.warnings.some((w) => w.code === 'empty');
    const sized = (text: string): string => (empty ? '—' : text);
    const rows: [string, string][] = [
      ['Image aspect a', `${fixed(r.aspect, 4)} (${hero.imageW} × ${hero.imageH})`],
      ['Half-size k, ak', sized(`${fixed(r.k, 4)} high, ${fixed(r.ak, 4)} wide (face units)`)],
      ['Reach |t|', sized(`${fixed(FACE_WARN_LIMIT - r.margins.k, 4)} · ${margin(r.margins.k, 3, String(FACE_WARN_LIMIT))}`)],
      ['Reach |s|', sized(`${fixed(FACE_WARN_LIMIT - r.margins.ak, 4)} · ${margin(r.margins.ak, 3, String(FACE_WARN_LIMIT))}`)],
      ['Angular size', sized(`${fixed(r.heightDeg, 2)}° high × ${fixed(r.widthDeg, 2)}° wide`)],
      ['Top edge', `${fixed(r.topDeg, 2)}° · ${margin(r.margins.zenithDeg, 2, '90', '°')}`],
      ['Bottom edge', `${fixed(r.bottomDeg, 2)}°`],
      ['Mapping', `X ${fixed(x, 2)} · Y ${fixed(y, 2)}`],
    ];
    this.readouts.replaceChildren(...rows.flatMap(([term, value]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      return [dt, dd];
    }));

    this.warnings.replaceChildren(...(r.warnings.length > 0 ? r.warnings : [null]).map((w) => {
      const li = document.createElement('li');
      li.className = w ? w.level : 'ok';
      li.textContent = w ? w.message : 'No warnings.';
      return li;
    }));

    this.jsonOut.textContent = jsonText;
  }

  showAtlasStatus(text: string, isError = false): void {
    this.atlasStatus.textContent = text;
    this.atlasStatus.classList.toggle('error', isError);
  }

  showHeroStatus(text: string, isError = false): void {
    this.heroStatus.textContent = text;
    this.heroStatus.classList.toggle('error', isError);
  }
}
