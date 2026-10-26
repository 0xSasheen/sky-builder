// Remembering the last session (PLAN §15.2, §17.9).

import { describe, expect, it } from 'vitest';
import sky3Text from '../reference/pack-example/assets/nuit/sky/sky3_image.json?raw';
import { DEFAULTS, K_RANGE, PLAY_SPEEDS } from '../src/constants.ts';
import { buildSky3, parseSky3, serializeSky3 } from '../src/json.ts';
import { fromSaved, fromSavedV1, toSaved, type Session } from '../src/saved.ts';
import type { SkyTab } from '../src/schema.ts';
import { newTab } from '../src/tabs.ts';
import { cases, params } from './vectors.ts';

const defaults: Session = {
  hero: params(cases[0], { k: cases[0].k! }),
  view: { timeTicks: 6000, ticksPerSecond: DEFAULTS.ticksPerSecond, fovDeg: 70, yawDeg: 0, pitchDeg: 0, showOverlay: false },
  tabs: [],
  openTabId: '',
  previewMode: 'blend',
  pinned: null,
};

const night: SkyTab = {
  ...newTab('n1', 'Night'),
  templateLayer: { file: 'assets/nuit/sky/sky1_night.json', texturePath: 'assets/sasheen/textures/sky/night.png', duration: 24000, keyFrames: [] },
};
const day: SkyTab = {
  ...newTab('d1', 'Day'),
  include: false,
  sky: { user: { name: 'pano.png' }, type: 'panorama', faceSize: 1024, leftBearingDeg: -180 },
  keyFrames: [{ tick: 4000, alpha: 1 }, { tick: 16000, alpha: 0 }],
  keyFramesEdited: true,
  templateLayer: { file: 'assets/nuit/sky/sky2_day.json', texturePath: null, duration: 12000, keyFrames: [{ tick: 4000, alpha: 1 }] },
};

const changed: Session = {
  hero: params(cases[2], { mode: 'tilted', mappingYDeg: 30, texture: 'mine:textures/sky/a.png', layer: 5, imageW: 300, imageH: 400 }),
  view: { timeTicks: 18000, ticksPerSecond: PLAY_SPEEDS[0].ticksPerSecond, fovDeg: 90, yawDeg: -45, pitchDeg: 22.47, showOverlay: true },
  tabs: [night, day],
  openTabId: 'd1',
  previewMode: 'tab',
  pinned: null,
};

/** Edits a saved entry as an object and writes it back. */
function tamper(session: Session, edit: (o: Record<string, any>) => void): string {
  const o = JSON.parse(toSaved(session));
  edit(o);
  return JSON.stringify(o);
}

describe('saved session (PLAN §15.2, §17.9)', () => {
  it('round-trips every field, tabs included', () => {
    expect(fromSaved(toSaved(changed), defaults)).toEqual(changed);
  });

  it('keeps a pinned JSON byte for byte', () => {
    const parsed = parseSky3(sky3Text);
    if (!parsed.ok) throw new Error('expected ok');
    const restored = fromSaved(toSaved({ ...changed, pinned: { json: parsed.json, name: 'sky3_image.json' } }), defaults);
    expect(restored.pinned!.name).toBe('sky3_image.json');
    expect(serializeSky3(restored.pinned!.json)).toBe(sky3Text);
  });

  it('nothing saved, broken text, or another version gives the defaults', () => {
    expect(fromSaved(null, defaults)).toBe(defaults);
    expect(fromSaved('{ not json', defaults)).toBe(defaults);
    expect(fromSaved('[]', defaults)).toBe(defaults);
    expect(fromSaved(tamper(changed, (o) => { o.version = 1; }), defaults)).toBe(defaults);
  });

  it('a bad field takes its default and leaves the rest', () => {
    const restored = fromSaved(tamper(changed, (o) => {
      o.hero.mode = 'sideways';
      o.hero.k = 'big';
      o.view.ticksPerSecond = 123;
      o.previewMode = 'sideways';
      o.tabs[1].sky.type = 'cube';
      o.tabs[1].include = 'yes';
    }), defaults);
    expect(restored.hero.mode).toBe(defaults.hero.mode);
    expect(restored.hero.k).toBe(defaults.hero.k);
    expect(restored.hero.bottomDeg).toBe(changed.hero.bottomDeg);
    expect(restored.view.ticksPerSecond).toBe(defaults.view.ticksPerSecond);
    expect(restored.view.timeTicks).toBe(18000);
    expect(restored.previewMode).toBe('blend');
    expect(restored.tabs[1].sky).toEqual({ ...day.sky, type: 'auto' });
    expect(restored.tabs[1].include).toBe(true);
  });

  it('drops a tab without an id or name, or with a repeated id; renames a repeated name; keeps the open tab valid', () => {
    const restored = fromSaved(tamper(changed, (o) => {
      o.tabs.push({ id: '', name: 'X' }, { id: 'z', name: ' ' }, { ...o.tabs[0] }, { ...o.tabs[0], id: 'n2' });
      o.openTabId = 'gone';
    }), defaults);
    expect(restored.tabs.map((t) => [t.id, t.name])).toEqual([['n1', 'Night'], ['d1', 'Day'], ['n2', 'Night 2']]);
    expect(restored.openTabId).toBe('n1');
  });

  it('no tabs saved gives the default tabs; broken keyframes are dropped and alphas clamped', () => {
    expect(fromSaved(tamper(changed, (o) => { o.tabs = 'none'; }), defaults).tabs).toEqual([]);
    const restored = fromSaved(tamper(changed, (o) => {
      o.tabs[1].keyFrames = [{ tick: 4000, alpha: 3 }, { tick: 'x', alpha: 0 }, { tick: 99999, alpha: 0.5 }];
      o.tabs[1].templateLayer = 'broken';
    }), defaults);
    expect(restored.tabs[1].keyFrames).toEqual([{ tick: 4000, alpha: 1 }, { tick: 99999, alpha: 0.5 }]);
    expect(restored.tabs[1].templateLayer).toBeNull();
  });

  it('values are clamped as if typed in', () => {
    const restored = fromSaved(tamper(changed, (o) => {
      o.hero.k = 99;
      o.view.pitchDeg = 120;
      o.view.timeTicks = 30000;
      o.view.yawDeg = 270;
      o.tabs[1].sky.faceSize = 99999;
      o.tabs[1].sky.leftBearingDeg = -500;
    }), defaults);
    expect(restored.hero.k).toBe(K_RANGE.max);
    expect(restored.view.pitchDeg).toBe(89);
    expect(restored.view.timeTicks).toBe(6000);
    expect(restored.view.yawDeg).toBe(-90);
    expect(restored.tabs[1].sky.faceSize).toBe(2730);
    expect(restored.tabs[1].sky.leftBearingDeg).toBe(-180);
  });

  it('a damaged pinned JSON is dropped, not shown', () => {
    const json = buildSky3(changed.hero);
    const restored = fromSaved(tamper({ ...changed, pinned: { json, name: 'x.json' } }, (o) => {
      o.pinned.json = o.pinned.json.replace('nuit:multi-textured', 'nuit:square-textured');
    }), defaults);
    expect(restored.pinned).toBeNull();
    expect(restored.hero).toEqual(changed.hero);
  });
});

describe('a session from before sky tabs (decision 17.3.13)', () => {
  /** What v1 wrote (PLAN §15.2). */
  const v1 = (edit: (o: Record<string, any>) => void = () => {}): string => {
    const o: Record<string, any> = {
      version: 1,
      hero: changed.hero,
      view: changed.view,
      sky: { type: 'panorama', faceSize: 1024, leftBearingDeg: -150 },
      pinned: { name: 'sky3_image.json', json: sky3Text },
      packSky: 'both',
    };
    edit(o);
    return JSON.stringify(o);
  };

  it('keeps the hero, view and pinned JSON, and hands back the sky settings for the Day tab', () => {
    const old = fromSavedV1(v1(), defaults)!;
    expect(old.session.hero).toEqual(changed.hero);
    expect(old.session.view).toEqual(changed.view);
    expect(serializeSky3(old.session.pinned!.json)).toBe(sky3Text);
    expect(old.session.tabs).toEqual([]); // the tabs come from the template
    expect(old.sky).toEqual({ type: 'panorama', faceSize: 1024, leftBearingDeg: -150 });
  });

  it('is null when there is none, or it isn\'t version 1', () => {
    expect(fromSavedV1(null, defaults)).toBeNull();
    expect(fromSavedV1(toSaved(changed), defaults)).toBeNull();
    expect(fromSavedV1(v1((o) => { o.sky = 'x'; }), defaults)!.sky).toEqual({ type: 'auto', faceSize: null, leftBearingDeg: -135 });
  });
});
