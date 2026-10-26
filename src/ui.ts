// Controls and readouts, in plain DOM (PLAN §8). The UI never changes state itself:
// it reports what the user did through the handlers, and main.ts calls show*() with the result.

import {
  FACE_WARN_LIMIT, K_RANGE, PANO_FACE_RANGE, PANO_LEFT_BEARING_RANGE, PLAY_SPEEDS, RANGES, TICKS_PER_DAY, TIME_MARKS,
} from './constants.ts';
import {
  fadeAlpha, heightFromK, kFromHeight, mcFacing, mcYawPitch, noonBearingDeg, quadrantBearing, ticksToClock,
} from './math.ts';
import type { FadeKey, HeroMode, HeroParams, PreviewMode, Readouts, Sky3Json, SkyType, ViewState } from './schema.ts';
import type { TabNote } from './tabs.ts';

export interface UiHandlers {
  onView(patch: Partial<ViewState>): void;
  onHero(patch: Partial<HeroParams>): void;
  /** A scale button: multiply k by this factor (BRIEF §6.1). */
  onScale(factor: number): void;
  onLookAtHero(): void;
  onSkyFile(file: File): void;
  /** The sky type dropdown: auto, atlas or panorama (PLAN §13.4). */
  onSkyType(type: SkyType): void;
  /** A new face size for a panorama's atlas, committed with Enter or by leaving the box. */
  onFaceSize(faceSize: number): void;
  /** The left-edge slider is moving: preview by turning the sky, without converting (PLAN §13.7). */
  onLeftBearingPreview(leftBearingDeg: number): void;
  /** A left-edge bearing to convert with: the slider was let go, or the box was committed. */
  onLeftBearing(leftBearingDeg: number): void;
  onDownloadAtlas(): void;
  onHeroFile(file: File): void;
  /** Back to the sample sky, the test card and the starting hero settings. */
  onReset(): void;
  onCopy(): void;
  onDownloadJson(): void;
  onDownloadMcmeta(): void;
  onImportFile(file: File): void;
  onImportText(text: string): void;
  /** Files dropped on a row, or anywhere else ('auto': routed by type and shape, PLAN §15.1). */
  onDropFiles(files: File[], target: DropTarget): void;
  /** A pack template (.zip) chosen in the Resource pack section (PLAN §16). */
  onPackFile(file: File): void;
  onAssemble(): void;
  /** Back to the bundled starter template. */
  onUseStarter(): void;
  // --- Sky tabs (PLAN §17.7). Everything a tab does acts on the open tab.
  onTabSelect(tabId: string): void;
  onTabAdd(): void;
  /** Called while typing; main.ts renames the tab only if the name is usable. */
  onTabRename(name: string): void;
  onTabInclude(include: boolean): void;
  /** Moves the tab at one place in the strip to another (dragging, or the Move buttons). */
  onTabMove(fromIndex: number, toIndex: number): void;
  onTabDelete(): void;
  /** Forget the open tab's own sky, so it shows the template's (or the default). */
  onSkyReset(): void;
  /** The whole list of keyframes after an edit, in row order. */
  onKeyFrames(keys: FadeKey[]): void;
  onKeyFrameAdd(): void;
  onKeyFramesTemplate(): void;
  onTabCopy(): void;
  onTabDownload(): void;
  onPreviewMode(mode: PreviewMode): void;
}

/** One button in the tab strip. */
export interface TabStripItem { id: string; name: string; include: boolean; base: boolean }

/** What the open tab's panel shows (PLAN §17.7). */
export interface OpenTabView {
  id: string;
  name: string;
  include: boolean;
  /** Its layer and file, or why it isn't in the pack. */
  layerText: string;
  base: boolean;
  keyFrames: FadeKey[];
  /** Rows Nuit can't read, by row. */
  problems: { index: number; message: string }[];
  hasTemplateKeyFrames: boolean;
  /** This tab's amber and red notes. */
  notes: TabNote[];
  /** The layer file's name for Download, or null when the tab isn't included. */
  exportName: string | null;
  /** The "Use the template's sky" button's label, or null to hide it (the tab has no sky of its own). */
  skyResetLabel: string | null;
  canDelete: boolean;
  index: number;
  count: number;
}

export type DropTarget = 'sky' | 'hero' | 'import' | 'pack' | 'auto';

/** One line of the import report (PLAN §14.3). */
export interface ImportLine { level: 'ok' | 'warn' | 'error'; text: string }

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

/** "06:00" for tick 0, "18:30" for tick 12500. */
function clockText(ticks: number): string {
  const { h, m } = ticksToClock(ticks);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "due north", "N 30.00° W", "S 12.50° E": a bearing as words. */
function facingText(bearingDeg: number): string {
  const q = quadrantBearing(bearingDeg);
  const deg = fixed(q.deg, 2); // judge "due" on the shown value: at midnight the bearing is a hair off 180°
  if (Number(deg) === 0) return `due ${q.from === 'N' ? 'north' : 'south'}`;
  if (Number(deg) === 90) return `due ${q.to === 'E' ? 'east' : 'west'}`;
  return `${q.from} ${deg}° ${q.to}`;
}

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
  private readonly overlay = byId<HTMLInputElement>('overlay');
  private readonly hud = byId<HTMLDivElement>('hud');
  private readonly skyStatus = byId<HTMLParagraphElement>('sky-status');
  private readonly skyType = byId<HTMLSelectElement>('sky-type');
  private readonly panoOptions = byId<HTMLDivElement>('pano-options');
  private readonly faceSize = byId<HTMLInputElement>('face-size');
  private readonly leftBearing = byId<HTMLInputElement>('left-bearing');
  private readonly leftBearingNum = byId<HTMLInputElement>('left-bearing-num');
  private readonly fileInputs = ['sky-file', 'hero-file', 'import-file', 'pack-file'].map((id) => byId<HTMLInputElement>(id));
  private readonly packSummary = byId<HTMLUListElement>('pack-summary');
  private readonly heroLayer = byId<HTMLParagraphElement>('hero-layer');
  private readonly tabStrip = byId<HTMLDivElement>('tab-strip');
  private readonly tabName = byId<HTMLInputElement>('tab-name');
  private readonly tabNameProblem = byId<HTMLParagraphElement>('tab-name-problem');
  private readonly tabInclude = byId<HTMLInputElement>('tab-include');
  private readonly tabLayer = byId<HTMLParagraphElement>('tab-layer');
  private readonly skyResetRow = byId<HTMLDivElement>('sky-reset-row');
  private readonly skyReset = byId<HTMLButtonElement>('sky-reset');
  private readonly fadeBase = byId<HTMLParagraphElement>('fade-base');
  private readonly fadeEditor = byId<HTMLDivElement>('fade-editor');
  private readonly fadeGraph = byId<HTMLElement>('fade-graph');
  private readonly fadeRows = byId<HTMLTableSectionElement>('fade-rows');
  private readonly fadeTemplate = byId<HTMLButtonElement>('fade-template');
  private readonly tabNotes = byId<HTMLUListElement>('tab-notes');
  private readonly tabCopy = byId<HTMLButtonElement>('tab-copy');
  private readonly tabDownload = byId<HTMLButtonElement>('tab-download');
  private readonly tabExportStatus = byId<HTMLParagraphElement>('tab-export-status');
  private readonly tabLeft = byId<HTMLButtonElement>('tab-left');
  private readonly tabRight = byId<HTMLButtonElement>('tab-right');
  private readonly tabDelete = byId<HTMLButtonElement>('tab-delete');
  private readonly previewMode = byId<HTMLSelectElement>('preview-mode');
  private readonly previewNote = byId<HTMLParagraphElement>('preview-note');
  /** The open tab as last shown: its name for the name box, its place for the Move buttons. */
  private openTab: OpenTabView | null = null;
  private readonly handlers: UiHandlers;
  private readonly packStatus = byId<HTMLParagraphElement>('pack-status');
  private readonly packStarter = byId<HTMLButtonElement>('pack-starter');
  private readonly packReport = byId<HTMLUListElement>('pack-report');
  private readonly panoDownload = byId<HTMLDivElement>('pano-download');
  private readonly heroStatus = byId<HTMLParagraphElement>('hero-status');
  private readonly modes = [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')];
  private readonly modeRows = [...document.querySelectorAll<HTMLElement>('[data-mode]')];
  private readonly texture = byId<HTMLInputElement>('texture');
  private readonly textureProblem = byId<HTMLParagraphElement>('texture-problem');
  private readonly turnHint = byId<HTMLParagraphElement>('turn-hint');
  private readonly readouts = byId<HTMLDListElement>('readouts');
  private readonly warnings = byId<HTMLUListElement>('warnings');
  private readonly jsonOut = byId<HTMLPreElement>('json-out');
  private readonly play = byId<HTMLButtonElement>('play');
  private readonly time = byId<HTMLInputElement>('time');
  private readonly speed = byId<HTMLSelectElement>('speed');
  private readonly timeReadout = byId<HTMLParagraphElement>('time-readout');
  private readonly exportStatus = byId<HTMLParagraphElement>('export-status');
  private readonly pinnedNote = byId<HTMLParagraphElement>('pinned-note');
  private readonly importStatus = byId<HTMLUListElement>('import-status');
  private readonly importText = byId<HTMLTextAreaElement>('import-text');
  private readonly dropStatus = byId<HTMLParagraphElement>('drop-status');
  /** Whether the last view shown was playing, so the play button knows which way to toggle. */
  private playing = false;
  private exportStatusTimer = 0;

  constructor(handlers: UiHandlers) {
    this.handlers = handlers;
    // --- Preview
    this.setYaw = bindRange(byId('yaw'), byId('yaw-num'), RANGES.yawDeg, 1, (yawDeg) => handlers.onView({ yawDeg }));
    this.setPitch = bindRange(byId('pitch'), byId('pitch-num'), RANGES.pitchDeg, 1, (pitchDeg) => handlers.onView({ pitchDeg }));
    this.setFov = bindRange(byId('fov'), byId('fov-num'), RANGES.fovDeg, 0, (fovDeg) => handlers.onView({ fovDeg }));
    this.overlay.addEventListener('change', () => handlers.onView({ showOverlay: this.overlay.checked }));
    byId('look-north').addEventListener('click', () => handlers.onView({ yawDeg: 0, pitchDeg: 0 }));
    byId('look-hero').addEventListener('click', () => handlers.onLookAtHero());

    // --- Time (PLAN §14.1): play/pause, one slider with marks to snap to, and the speed
    this.time.min = String(RANGES.timeTicks.min);
    this.time.max = String(RANGES.timeTicks.max);
    byId<HTMLDataListElement>('time-marks').replaceChildren(...TIME_MARKS.map((ticks) => new Option('', String(ticks))));
    this.speed.replaceChildren(...PLAY_SPEEDS.map((sp) => new Option(sp.label, String(sp.ticksPerSecond))));
    this.play.addEventListener('click', () => handlers.onView({ playing: !this.playing }));
    this.time.addEventListener('input', () => handlers.onView({ timeTicks: this.time.valueAsNumber, playing: false }));
    this.speed.addEventListener('change', () => handlers.onView({ ticksPerSecond: Number(this.speed.value) }));

    // --- Files
    for (const [id, handler] of [['sky-file', handlers.onSkyFile], ['hero-file', handlers.onHeroFile]] as const) {
      const input = byId<HTMLInputElement>(id);
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file) handler(file);
      });
    }
    this.skyType.addEventListener('change', () => handlers.onSkyType(this.skyType.value as SkyType));
    this.faceSize.min = String(PANO_FACE_RANGE.min);
    this.faceSize.max = String(PANO_FACE_RANGE.max);
    // 'change', not 'input': a conversion takes seconds, so don't start one on every keystroke.
    this.faceSize.addEventListener('change', () => {
      if (Number.isFinite(this.faceSize.valueAsNumber)) handlers.onFaceSize(this.faceSize.valueAsNumber);
    });
    // The left edge: the slider previews while it moves and converts when let go; the box converts when committed.
    for (const el of [this.leftBearing, this.leftBearingNum]) {
      el.min = String(PANO_LEFT_BEARING_RANGE.min);
      el.max = String(PANO_LEFT_BEARING_RANGE.max);
    }
    this.leftBearing.addEventListener('input', () => {
      this.leftBearingNum.value = String(this.leftBearing.valueAsNumber);
      handlers.onLeftBearingPreview(this.leftBearing.valueAsNumber);
    });
    this.leftBearing.addEventListener('change', () => handlers.onLeftBearing(this.leftBearing.valueAsNumber));
    this.leftBearingNum.addEventListener('change', () => {
      if (Number.isFinite(this.leftBearingNum.valueAsNumber)) handlers.onLeftBearing(this.leftBearingNum.valueAsNumber);
    });
    byId('download-atlas').addEventListener('click', () => handlers.onDownloadAtlas());
    // --- Export and import (PLAN §14.2, §14.3)
    byId('copy-json').addEventListener('click', () => handlers.onCopy());
    byId('download-json').addEventListener('click', () => handlers.onDownloadJson());
    byId('download-mcmeta').addEventListener('click', () => handlers.onDownloadMcmeta());
    const importFile = byId<HTMLInputElement>('import-file');
    importFile.addEventListener('change', () => {
      const file = importFile.files?.[0];
      if (file) handlers.onImportFile(file);
      importFile.value = ''; // so choosing the same file again imports it again
    });
    byId('import-button').addEventListener('click', () => handlers.onImportText(this.importText.value));

    // --- Resource pack (PLAN §16)
    const packFile = byId<HTMLInputElement>('pack-file');
    packFile.addEventListener('change', () => {
      const file = packFile.files?.[0];
      if (file) handlers.onPackFile(file);
    });
    byId('assemble').addEventListener('click', () => handlers.onAssemble());
    this.packStarter.addEventListener('click', () => handlers.onUseStarter());

    // --- Drag and drop (PLAN §15.1). Without preventDefault the browser would open a dropped file in place of the page.
    const zones = [...document.querySelectorAll<HTMLElement>('[data-drop]')];
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') ?? false;
    let depth = 0; // dragenter and dragleave also fire for every child element crossed, so count them
    const endDrag = (): void => {
      depth = 0;
      document.body.classList.remove('dragging');
      for (const zone of zones) zone.classList.remove('drop-over');
    };
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      document.body.classList.add('dragging');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) endDrag();
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allows the drop
      e.dataTransfer!.dropEffect = 'copy';
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      endDrag();
      handlers.onDropFiles([...e.dataTransfer!.files], 'auto');
    });
    for (const zone of zones) {
      zone.addEventListener('dragover', (e) => { if (hasFiles(e)) zone.classList.add('drop-over'); });
      zone.addEventListener('dragleave', (e) => {
        if (!zone.contains(e.relatedTarget as Node | null)) zone.classList.remove('drop-over');
      });
      zone.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation(); // handled here, not as an 'auto' drop on the page
        endDrag();
        handlers.onDropFiles([...e.dataTransfer!.files], zone.dataset.drop as DropTarget);
      });
    }

    byId('reset').addEventListener('click', () => {
      if (window.confirm('Reset to the starter\'s sky tabs, the test card and the starting hero settings? '
        + 'Your sky tabs, their skies, the hero image and your settings will be replaced.')) handlers.onReset();
    });

    // --- Sky tabs (PLAN §17.7)
    this.tabName.addEventListener('input', () => handlers.onTabRename(this.tabName.value));
    this.tabName.addEventListener('blur', () => {
      // A name that couldn't be used goes back to the tab's real one.
      if (this.openTab) this.tabName.value = this.openTab.name;
      this.showTabNameProblem(null);
    });
    this.tabInclude.addEventListener('change', () => handlers.onTabInclude(this.tabInclude.checked));
    this.skyReset.addEventListener('click', () => handlers.onSkyReset());
    byId('fade-add').addEventListener('click', () => handlers.onKeyFrameAdd());
    this.fadeTemplate.addEventListener('click', () => handlers.onKeyFramesTemplate());
    this.tabCopy.addEventListener('click', () => handlers.onTabCopy());
    this.tabDownload.addEventListener('click', () => handlers.onTabDownload());
    this.tabLeft.addEventListener('click', () => {
      if (this.openTab) handlers.onTabMove(this.openTab.index, this.openTab.index - 1);
    });
    this.tabRight.addEventListener('click', () => {
      if (this.openTab) handlers.onTabMove(this.openTab.index, this.openTab.index + 1);
    });
    this.tabDelete.addEventListener('click', () => {
      if (this.openTab && window.confirm(`Delete the ${this.openTab.name} tab? Its sky and keyframes will be forgotten.`)) {
        handlers.onTabDelete();
      }
    });
    this.previewMode.addEventListener('change', () => handlers.onPreviewMode(this.previewMode.value as PreviewMode));
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
  }

  showView(view: ViewState): void {
    this.setYaw(view.yawDeg);
    this.setPitch(view.pitchDeg);
    this.setFov(view.fovDeg);
    this.overlay.checked = view.showOverlay;
    this.playing = view.playing;
    this.play.textContent = view.playing ? '❚❚' : '▶';
    this.play.setAttribute('aria-label', view.playing ? 'Pause' : 'Play');
    this.time.value = String(Math.round(view.timeTicks));
    this.speed.value = String(view.ticksPerSecond);

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
    if (document.activeElement !== this.texture) this.texture.value = hero.texture;
    this.textureProblem.textContent = textureProblem ?? '';

    // Everything below describes the JSON, the values Nuit will read.
    const [x, y] = json.properties.rotation.mapping['0'];
    this.turnHint.textContent = `At noon the hero faces ${facingText(noonBearingDeg(y))}. Positive ψ turns it toward the west.`;

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

  /**
   * The line under the time slider: clock, the spin θ, each sky layer's alpha (PLAN §17.5), and where the hero
   * faces at this time.
   */
  showTime(ticks: number, thetaDeg: number, heroBearingDeg: number, layers: readonly { name: string; alpha: number }[]): void {
    const alphas = layers.map((l) => ` · ${l.name} ${fixed(l.alpha, 2)}`).join('');
    this.timeReadout.textContent = `${clockText(ticks)} (tick ${Math.round(ticks)}) · θ ${fixed(thetaDeg, 1)}°${alphas}`
      + ` · the hero faces ${facingText(heroBearingDeg)}`;
  }

  // --- Sky tabs (PLAN §17.7) ------------------------------------------------------------------

  /** The tab strip and the open tab's panel. */
  showTabs(items: readonly TabStripItem[], open: OpenTabView): void {
    this.openTab = open;
    this.tabStrip.replaceChildren(...items.map((item, index) => this.tabButton(item, index, item.id === open.id)), this.addButton());

    if (document.activeElement !== this.tabName) this.tabName.value = open.name;
    this.tabInclude.checked = open.include;
    this.tabLayer.textContent = open.layerText;
    this.skyResetRow.hidden = open.skyResetLabel === null;
    this.skyReset.textContent = open.skyResetLabel ?? '';

    this.fadeBase.hidden = !open.base;
    this.fadeEditor.hidden = open.base;
    this.fadeTemplate.hidden = !open.hasTemplateKeyFrames;
    this.fadeRows.replaceChildren(...open.keyFrames.map((key, index) =>
      this.keyRow(key, index, open.problems.some((p) => p.index === index))));
    this.showList(this.tabNotes, open.notes.map((n) => ({ level: n.level, text: n.text })));

    this.tabCopy.disabled = this.tabDownload.disabled = open.exportName === null;
    this.tabDownload.textContent = open.exportName ? `Download ${open.exportName}` : 'Download';
    const notIncluded = 'Include this tab to export its layer file.';
    if (open.exportName === null) this.showTabExportStatus(notIncluded);
    else if (this.tabExportStatus.textContent === notIncluded) this.showTabExportStatus('');
    this.tabLeft.disabled = open.index === 0;
    this.tabRight.disabled = open.index === open.count - 1;
    this.tabDelete.disabled = !open.canDelete;
  }

  private tabButton(item: TabStripItem, index: number, selected: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(selected));
    button.classList.toggle('excluded', !item.include);
    button.title = item.include ? (item.base ? 'The base layer: always on' : 'Fades over the layers before it') : 'Not included in the pack';
    const name = document.createElement('span');
    name.textContent = item.name;
    button.append(name);
    if (item.base) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'base';
      button.append(tag);
    }
    button.addEventListener('click', () => this.handlers.onTabSelect(item.id));

    // Dragging a tab onto another moves it there. These drags carry no files, so the page's file drop ignores them.
    const TAB_DRAG = 'application/x-sky-builder-tab';
    button.draggable = true;
    button.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData(TAB_DRAG, String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    button.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(TAB_DRAG)) return;
      e.preventDefault();
      button.classList.add('drag-over');
    });
    button.addEventListener('dragleave', () => button.classList.remove('drag-over'));
    button.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types.includes(TAB_DRAG)) return;
      e.preventDefault();
      button.classList.remove('drag-over');
      const from = Number(e.dataTransfer.getData(TAB_DRAG));
      if (Number.isInteger(from) && from !== index) this.handlers.onTabMove(from, index);
    });
    return button;
  }

  private addButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'add';
    button.textContent = '+';
    button.title = 'Add a sky tab';
    button.setAttribute('aria-label', 'Add a sky tab');
    button.addEventListener('click', () => this.handlers.onTabAdd());
    return button;
  }

  /** One keyframe row. An edit is committed (Enter, or leaving the box) as the whole list, in row order. */
  private keyRow(key: FadeKey, index: number, bad: boolean): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.classList.toggle('error', bad);
    const tick = document.createElement('input');
    tick.type = 'number';
    tick.step = '1';
    tick.min = '0';
    tick.max = String(RANGES.timeTicks.max);
    tick.value = String(key.tick);
    tick.setAttribute('aria-label', `Keyframe ${index + 1} tick`);
    const alpha = document.createElement('input');
    alpha.type = 'number';
    alpha.step = '0.05';
    alpha.min = '0';
    alpha.max = '1';
    alpha.value = String(key.alpha);
    alpha.setAttribute('aria-label', `Keyframe ${index + 1} alpha`);
    const clock = document.createElement('td');
    clock.className = 'clock';
    clock.textContent = Number.isFinite(key.tick) ? clockText(key.tick) : '';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Delete keyframe ${index + 1}`);

    const commit = (): void => {
      const keys = this.readKeyRows();
      if (keys) this.handlers.onKeyFrames(keys);
    };
    tick.addEventListener('change', commit);
    alpha.addEventListener('change', commit);
    remove.addEventListener('click', () => {
      const keys = this.readKeyRows();
      if (keys) this.handlers.onKeyFrames(keys.filter((_, i) => i !== index));
    });

    const cell = (child: HTMLElement): HTMLTableCellElement => {
      const td = document.createElement('td');
      td.append(child);
      return td;
    };
    row.append(cell(tick), clock, cell(alpha), cell(remove));
    return row;
  }

  /** The keyframe rows as typed, or null if a box doesn't hold a number. */
  private readKeyRows(): FadeKey[] | null {
    const keys: FadeKey[] = [];
    for (const row of this.fadeRows.rows) {
      const [tick, alpha] = [...row.querySelectorAll('input')].map((input) => input.valueAsNumber);
      if (!Number.isFinite(tick) || !Number.isFinite(alpha)) return null;
      keys.push({ tick, alpha });
    }
    return keys;
  }

  /**
   * The open tab's alpha over the day, from tick 0 (6 AM) on the left, with dots at its keyframes and a line at
   * the preview time. Null hides it (the base, which is always on).
   */
  showFadeGraph(keys: readonly FadeKey[] | null, ticks: number): void {
    if (keys === null) {
      this.fadeGraph.replaceChildren();
      return;
    }
    const W = 240;
    const H = 64;
    const x = (t: number): number => (t / TICKS_PER_DAY) * W;
    const y = (a: number): number => H - 4 - a * (H - 8);
    const svg = (tag: string, attrs: Record<string, string | number>): SVGElement => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    };
    const parts: SVGElement[] = [];
    for (const t of [6000, 12000, 18000]) parts.push(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: 0, y2: H }));
    const points: string[] = [];
    for (let t = 0; t <= TICKS_PER_DAY; t += 100) points.push(`${x(t).toFixed(1)},${y(fadeAlpha(keys, t)).toFixed(1)}`);
    parts.push(svg('polyline', { class: 'curve', points: points.join(' ') }));
    for (const k of keys) {
      if (Number.isFinite(k.tick) && k.tick >= 0 && k.tick < TICKS_PER_DAY) {
        parts.push(svg('circle', { class: 'key', cx: x(k.tick), cy: y(Math.min(1, Math.max(0, k.alpha))), r: 2.5 }));
      }
    }
    parts.push(svg('line', { class: 'now', x1: x(ticks), x2: x(ticks), y1: 0, y2: H }));
    this.fadeGraph.replaceChildren(...parts);
  }

  /** Why the name being typed can't be used; null clears it. */
  showTabNameProblem(problem: string | null): void {
    this.tabNameProblem.textContent = problem ?? '';
  }

  showTabExportStatus(text: string, isError = false): void {
    this.tabExportStatus.textContent = text;
    this.tabExportStatus.classList.toggle('error', isError);
  }

  /** The Show dropdown, and a note when what it shows needs explaining. */
  showPreviewMode(mode: PreviewMode, note: string): void {
    this.previewMode.value = mode;
    this.previewNote.textContent = note;
  }

  /** The hero's layer, now set by the included tabs (decision 17.3.3). */
  showHeroLayer(text: string): void {
    this.heroLayer.textContent = text;
  }

  /** What Assemble pack will put in, and anything to look at first. */
  showPackSummary(lines: readonly ImportLine[]): void {
    this.showList(this.packSummary, lines);
  }

  private showList(list: HTMLUListElement, lines: readonly ImportLine[]): void {
    list.replaceChildren(...lines.map(({ level, text }) => {
      const li = document.createElement('li');
      li.className = level;
      li.textContent = text;
      return li;
    }));
  }

  /** Asks before exporting a JSON with problems (PLAN §14.2). True means go ahead. */
  confirmExport(problems: readonly string[]): boolean {
    return window.confirm(`This JSON has problems:\n\n• ${problems.join('\n• ')}\n\nExport anyway?`);
  }

  /** A short note under the export buttons; a success note clears itself after a few seconds. */
  showExportStatus(text: string, isError = false): void {
    window.clearTimeout(this.exportStatusTimer);
    this.exportStatus.textContent = text;
    this.exportStatus.classList.toggle('error', isError);
    if (!isError && text) this.exportStatusTimer = window.setTimeout(() => this.showExportStatus(''), 3000);
  }

  /** Selects the JSON text, for copying by hand when the clipboard is refused. */
  selectJson(): void {
    const range = document.createRange();
    range.selectNodeContents(this.jsonOut);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.jsonOut.focus();
  }

  /** The note above the JSON while it is pinned to an import; null hides it. */
  showPinned(text: string | null): void {
    this.pinnedNote.hidden = text === null;
    this.pinnedNote.textContent = text ?? '';
  }

  showImportStatus(lines: readonly ImportLine[]): void {
    this.importStatus.replaceChildren(...lines.map(({ level, text }) => {
      const li = document.createElement('li');
      li.className = level;
      li.textContent = text;
      return li;
    }));
  }

  /** Which template Assemble pack will use; `uploaded` offers the way back to the starter. */
  showPackStatus(text: string, isError = false, uploaded = false): void {
    this.packStatus.textContent = text;
    this.packStatus.classList.toggle('error', isError);
    this.packStarter.hidden = !uploaded;
  }

  /** The outcome of the last Assemble pack: what went in, and anything worth knowing. */
  showPackReport(lines: readonly ImportLine[]): void {
    this.packReport.replaceChildren(...lines.map(({ level, text }) => {
      const li = document.createElement('li');
      li.className = level;
      li.textContent = text;
      return li;
    }));
  }

  /** Where dropped files went, or why they weren't used. */
  showDropStatus(text: string, isError = false): void {
    this.dropStatus.textContent = text;
    this.dropStatus.classList.toggle('error', isError);
  }

  showSkyStatus(text: string, isError = false): void {
    this.skyStatus.textContent = text;
    this.skyStatus.classList.toggle('error', isError);
  }

  /** The face size and left-edge controls, shown while the sky comes from a panorama; null hides them. */
  showPanoramaOptions(options: { faceSize: number; leftBearingDeg: number } | null): void {
    this.panoOptions.hidden = options === null;
    if (options === null) return;
    this.faceSize.value = String(options.faceSize);
    this.leftBearing.value = String(options.leftBearingDeg);
    if (document.activeElement !== this.leftBearingNum) this.leftBearingNum.value = String(options.leftBearingDeg);
  }

  showSkyType(type: SkyType): void {
    this.skyType.value = type;
  }

  /** Empties the file pickers, so they don't name a file that is no longer shown. */
  clearFileInputs(): void {
    for (const input of this.fileInputs) input.value = '';
  }

  /** Empties the sky file picker, for a newly opened tab. */
  clearSkyInput(): void {
    this.fileInputs[0].value = '';
  }

  showAtlasDownload(visible: boolean): void {
    this.panoDownload.hidden = !visible;
  }

  /** Saves a file through the browser's download, from memory; nothing is uploaded. */
  download(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); // some browsers read the URL just after the click
  }

  showHeroStatus(text: string, isError = false): void {
    this.heroStatus.textContent = text;
    this.heroStatus.classList.toggle('error', isError);
  }
}
