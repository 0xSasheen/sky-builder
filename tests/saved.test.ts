// Remembering the last session (PLAN §15.2).

import { describe, expect, it } from 'vitest';
import sky3Text from '../reference/pack-example/assets/nuit/sky/sky3_image.json?raw';
import { DEFAULTS, K_RANGE, PLAY_SPEEDS } from '../src/constants.ts';
import { buildSky3, parseSky3, serializeSky3 } from '../src/json.ts';
import { fromSaved, toSaved, type Session } from '../src/saved.ts';
import { cases, params } from './vectors.ts';

const defaults: Session = {
  hero: params(cases[0], { k: cases[0].k! }),
  view: { timeTicks: 6000, ticksPerSecond: DEFAULTS.ticksPerSecond, fovDeg: 70, yawDeg: 0, pitchDeg: 0, showOverlay: false },
  sky: { type: 'auto', faceSize: null, leftBearingDeg: -135 },
  pinned: null,
  packSky: 'day',
};

const changed: Session = {
  hero: params(cases[2], { mode: 'tilted', mappingYDeg: 30, texture: 'mine:textures/sky/a.png', layer: 5, imageW: 300, imageH: 400 }),
  view: { timeTicks: 18000, ticksPerSecond: PLAY_SPEEDS[0].ticksPerSecond, fovDeg: 90, yawDeg: -45, pitchDeg: 22.47, showOverlay: true },
  sky: { type: 'panorama', faceSize: 1024, leftBearingDeg: -180 },
  pinned: null,
  packSky: 'both',
};

/** Edits a saved entry as an object and writes it back. */
function tamper(session: Session, edit: (o: Record<string, any>) => void): string {
  const o = JSON.parse(toSaved(session));
  edit(o);
  return JSON.stringify(o);
}

describe('saved session (PLAN §15.2)', () => {
  it('round-trips every field', () => {
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
    expect(fromSaved(tamper(changed, (o) => { o.version = 2; }), defaults)).toBe(defaults);
  });

  it('a bad field takes its default and leaves the rest', () => {
    const restored = fromSaved(tamper(changed, (o) => {
      o.hero.mode = 'sideways';
      o.hero.k = 'big';
      o.view.ticksPerSecond = 123;
      o.sky.type = 'cube';
      o.packSky = 'sideways';
    }), defaults);
    expect(restored.hero.mode).toBe(defaults.hero.mode);
    expect(restored.hero.k).toBe(defaults.hero.k);
    expect(restored.hero.bottomDeg).toBe(changed.hero.bottomDeg);
    expect(restored.view.ticksPerSecond).toBe(defaults.view.ticksPerSecond);
    expect(restored.view.timeTicks).toBe(18000);
    expect(restored.sky.type).toBe('auto');
    expect(restored.sky.faceSize).toBe(1024);
    expect(restored.packSky).toBe('day');
  });

  it('an entry saved before packSky existed gets the default', () => {
    expect(fromSaved(tamper(changed, (o) => { delete o.packSky; }), defaults).packSky).toBe('day');
  });

  it('values are clamped as if typed in', () => {
    const restored = fromSaved(tamper(changed, (o) => {
      o.hero.k = 99;
      o.view.pitchDeg = 120;
      o.view.timeTicks = 30000;
      o.view.yawDeg = 270;
      o.sky.faceSize = 99999;
      o.sky.leftBearingDeg = -500;
    }), defaults);
    expect(restored.hero.k).toBe(K_RANGE.max);
    expect(restored.view.pitchDeg).toBe(89);
    expect(restored.view.timeTicks).toBe(6000);
    expect(restored.view.yawDeg).toBe(-90);
    expect(restored.sky.faceSize).toBe(2730);
    expect(restored.sky.leftBearingDeg).toBe(-180);
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
