// Sky tabs (PLAN §17.4), with the starter's and the pack example's real layer files and tiny stand-in images.

import { describe, expect, it } from 'vitest';
import exampleNightText from '../reference/pack-example/assets/nuit/sky/sky1_night.json?raw';
import starterNightText from '../reference/samples/starter_pack/assets/nuit/sky/sky1_night.json?raw';
import starterDayText from '../reference/samples/starter_pack/assets/nuit/sky/sky2_day.json?raw';
import { readTemplate, type PackFiles } from '../src/pack.ts';
import type { SkyTab } from '../src/schema.ts';
import {
  keyFrameProblems, layerJson, layerOutputs, layerPlan, mergeTemplate, newTab, nextTabName, skySource, slugify,
  tabNameFromFile, tabNameProblem, tabNotes, textureIdFromPath, uniqueName,
} from '../src/tabs.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const DAY_KEYS = [{ tick: 4000, alpha: 1 }, { tick: 8000, alpha: 1 }, { tick: 16000, alpha: 0 }, { tick: 20000, alpha: 0 }];

/** The starter's layout, with stand-in bytes for the images. */
function starter(): PackFiles {
  return new Map([
    ['pack.mcmeta', enc('{}')],
    ['assets/nuit/sky/sky1_night.json', enc(starterNightText)],
    ['assets/nuit/sky/sky2_day.json', enc(starterDayText)],
    ['assets/sasheen/textures/sky/night.png', new Uint8Array([1])],
    ['assets/sasheen/textures/sky/day.png', new Uint8Array([2])],
    ['assets/sasheen/textures/sky/hero.png', new Uint8Array([3])],
  ]);
}

function counter(): () => string {
  let n = 0;
  return () => `t${++n}`;
}

const fromTemplate = (files: PackFiles): SkyTab[] =>
  mergeTemplate([], readTemplate(files).skyLayers, counter(), { addMissing: true });

const OPTIONS = { heroTexturePath: 'assets/sasheen/textures/sky/hero.png', newLayerText: starterDayText };

describe('tab names', () => {
  it('come from the layer file', () => {
    expect(tabNameFromFile('assets/nuit/sky/sky2_day.json', 2)).toBe('Day');
    expect(tabNameFromFile('assets/nuit/sky/sky4_late_sunset.json', 4)).toBe('Late sunset');
    expect(tabNameFromFile('assets/nuit/sky/aurora.json', 3)).toBe('Aurora');
    expect(tabNameFromFile('assets/nuit/sky/sky1.json', 1)).toBe('Layer 1');
  });

  it('are unique ignoring case, and new tabs count up', () => {
    expect(uniqueName('Day', ['night', 'day'])).toBe('Day 2');
    expect(uniqueName('Dawn', ['Night', 'Day'])).toBe('Dawn');
    const tabs = [newTab('a', 'Night'), newTab('b', 'Day')];
    expect(nextTabName(tabs)).toBe('Sky 3');
    expect(tabNameProblem('  ', tabs, 'a')).toMatch(/needs a name/);
    expect(tabNameProblem('DAY', tabs, 'a')).toMatch(/already called/);
    expect(tabNameProblem('Day', tabs, 'b')).toBeNull(); // its own name
  });

  it('slugify to file-safe names', () => {
    expect(slugify(' Late Sunset! ')).toBe('late_sunset');
    expect(slugify('Ñ')).toBe('');
  });
});

describe('tabs from a template (decision 17.3.6)', () => {
  it('the starter gives Night, then Day with its keyframes, each linked to its file and texture', () => {
    const tabs = fromTemplate(starter());
    expect(tabs.map((t) => [t.id, t.name, t.include])).toEqual([['t1', 'Night', true], ['t2', 'Day', true]]);
    expect(tabs[0].keyFrames).toEqual([]);
    expect(tabs[1].keyFrames).toEqual(DAY_KEYS);
    expect(tabs[1].templateLayer).toEqual({
      file: 'assets/nuit/sky/sky2_day.json', texturePath: 'assets/sasheen/textures/sky/day.png', duration: 24000, keyFrames: DAY_KEYS,
    });
    expect(tabs[0].sky.user).toBeNull();
  });

  it('orders tabs by the layers\' own layer values, not by file name, and needs no "alwaysOn" (PLAN §17.1)', () => {
    const files = starter();
    files.set('assets/nuit/sky/sky1_night.json', enc(starterDayText.replace('"layer": 2', '"layer": 5')));
    files.set('assets/nuit/sky/sky2_day.json', enc(starterNightText.replace('"alwaysOn": true,', '')));
    expect(fromTemplate(files).map((t) => [t.name, t.keyFrames.length])).toEqual([['Day', 0], ['Night', 4]]);
  });

  it('keeps the user\'s sky, name, Include and edited keyframes when a template is loaded again', () => {
    const tabs = fromTemplate(starter());
    tabs[0] = { ...tabs[0], name: 'Midnight', include: false, sky: { ...tabs[0].sky, user: { name: 'mine.png' } } };
    tabs[1] = { ...tabs[1], keyFrames: [{ tick: 0, alpha: 1 }], keyFramesEdited: true };
    const merged = mergeTemplate(tabs, readTemplate(starter()).skyLayers, counter(), { addMissing: true });
    expect(merged.map((t) => t.name)).toEqual(['Midnight', 'Day']); // linked by file, so no new "Night" tab
    expect(merged[0]).toMatchObject({ include: false, sky: { user: { name: 'mine.png' } } });
    expect(merged[0].templateLayer?.file).toBe('assets/nuit/sky/sky1_night.json');
    expect(merged[1].keyFrames).toEqual([{ tick: 0, alpha: 1 }]);
  });

  it('a new template\'s keyframes replace unedited ones, by name; unmatched tabs become new layers', () => {
    const tabs = [...fromTemplate(starter()), newTab('x', 'Sunrise')];
    const other: PackFiles = new Map([
      ['assets/nuit/sky/sky7_day.json', enc(starterDayText.replace('"4000": 1.0', '"5000": 1.0'))],
    ]);
    const merged = mergeTemplate(tabs, readTemplate(other).skyLayers, counter(), { addMissing: true });
    expect(merged.map((t) => [t.name, t.templateLayer?.file ?? null])).toEqual([
      ['Night', null], ['Day', 'assets/nuit/sky/sky7_day.json'], ['Sunrise', null],
    ]);
    expect(merged[1].keyFrames[0]).toEqual({ tick: 5000, alpha: 1 });
  });

  it('restoring a session doesn\'t bring back a deleted tab; loading a template does', () => {
    const night = fromTemplate(starter()).slice(0, 1);
    const layers = readTemplate(starter()).skyLayers;
    expect(mergeTemplate(night, layers, counter(), { addMissing: false }).map((t) => t.name)).toEqual(['Night']);
    expect(mergeTemplate(night, layers, counter(), { addMissing: true }).map((t) => t.name)).toEqual(['Night', 'Day']);
  });
});

describe('layers (decision 17.3.3)', () => {
  it('included tabs are layers 1…m in tab order, the first is the base, and the hero is m + 1', () => {
    const [night, day] = fromTemplate(starter());
    const sunrise = newTab('s', 'Sunrise');
    expect(layerPlan([night, day, sunrise]).layers.map((l) => [l.tab.name, l.layer, l.base]))
      .toEqual([['Night', 1, true], ['Day', 2, false], ['Sunrise', 3, false]]);
    expect(layerPlan([night, day, sunrise]).heroLayer).toBe(4);
    const plan = layerPlan([{ ...night, include: false }, sunrise, day]);
    expect(plan.layers.map((l) => [l.tab.name, l.layer, l.base])).toEqual([['Sunrise', 1, true], ['Day', 2, false]]);
    expect(layerPlan([{ ...night, include: false }]).heroLayer).toBe(1);
  });

  it('flags keyframes Nuit can\'t read', () => {
    expect(keyFrameProblems(DAY_KEYS)).toEqual([]);
    expect(keyFrameProblems([{ tick: 24000, alpha: 1 }, { tick: 1.5, alpha: 0 }, { tick: -1, alpha: 0 }]).map((p) => p.index))
      .toEqual([0, 1, 2]);
    expect(keyFrameProblems([{ tick: 100, alpha: 1 }, { tick: 100, alpha: 0 }])).toEqual([{ index: 1, message: 'Tick 100 is used twice.' }]);
  });

  it('knows where each sky comes from, and notes what needs attention', () => {
    const files = starter();
    const [night, day] = fromTemplate(files);
    const sunrise = newTab('s', 'Sunrise');
    expect(skySource(night, files)).toBe('template');
    expect(skySource({ ...night, sky: { ...night.sky, user: { name: 'a.png' } } }, files)).toBe('user');
    expect(skySource(sunrise, files)).toBe('default');

    expect(tabNotes([night, day], files)).toEqual([]);
    const notes = tabNotes([night, day, sunrise, { ...newTab('b', 'Bad'), keyFrames: [{ tick: 30000, alpha: 1 }] }], files);
    expect(notes.map((n) => [n.tabId, n.level])).toEqual([
      ['s', 'warn'], ['s', 'warn'], // always on; default sky
      ['b', 'error'], ['b', 'warn'], // tick out of range; default sky
    ]);
    // The base needs no keyframes, and keyframes it keeps are not checked.
    expect(tabNotes([{ ...day, keyFrames: [{ tick: 99999, alpha: 1 }] }], files)).toEqual([]);
    expect(tabNotes([{ ...night, include: false }], files)[0].tabId).toBeNull();
  });
});

describe('layer files (decision 17.3.8)', () => {
  it('change only layer and keyFrames, and drop the ignored alwaysOn', () => {
    const out = JSON.parse(layerJson(starterDayText, { layer: 3, keyFrames: [{ tick: 9000, alpha: 0.5 }, { tick: 1000, alpha: 1 }] }));
    const expected = JSON.parse(starterDayText);
    expected.properties.layer = 3;
    delete expected.properties.fade.alwaysOn;
    expected.properties.fade.keyFrames = { 1000: 1, 9000: 0.5 };
    expect(out).toEqual(expected);
  });

  it('drop the old top-level blend, and write the base with no keyframes', () => {
    const text = layerJson(exampleNightText, { layer: 1, keyFrames: [] });
    expect(exampleNightText).toContain('"blend": {');
    expect(JSON.parse(text)).not.toHaveProperty('blend');
    expect(JSON.parse(text).properties.fade).toEqual({ duration: 24000, keyFrames: {} });
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('the starter\'s tabs write its own files, keeping its textures', () => {
    const outputs = layerOutputs(fromTemplate(starter()), starter(), OPTIONS);
    expect(outputs.map((o) => [o.jsonPath, o.texturePath, o.layer, o.base, o.textureFrom])).toEqual([
      ['assets/nuit/sky/sky1_night.json', 'assets/sasheen/textures/sky/night.png', 1, true, 'template'],
      ['assets/nuit/sky/sky2_day.json', 'assets/sasheen/textures/sky/day.png', 2, false, 'template'],
    ]);
    expect(JSON.parse(outputs[1].text).texture).toBe('sasheen:textures/sky/day.png');
  });

  it('a new tab gets its own file and texture beside the template\'s; excluding the base moves it up', () => {
    const [night, day] = fromTemplate(starter());
    const sunrise = { ...newTab('s', 'Sunrise'), keyFrames: [{ tick: 23000, alpha: 1 }] };
    const outputs = layerOutputs([{ ...night, include: false }, day, sunrise], starter(), OPTIONS);
    expect(outputs.map((o) => [o.jsonPath, o.layer, o.base])).toEqual([
      ['assets/nuit/sky/sky2_day.json', 1, true], ['assets/nuit/sky/sky2_sunrise.json', 2, false],
    ]);
    expect(JSON.parse(outputs[0].text).properties.fade.keyFrames).toEqual({}); // Day is the base now
    const s = JSON.parse(outputs[1].text);
    expect([s.texture, s.properties.layer, s.properties.fade.keyFrames]).toEqual(['sasheen:textures/sky/sunrise.png', 2, { 23000: 1 }]);
    expect(outputs[1]).toMatchObject({ texturePath: 'assets/sasheen/textures/sky/sunrise.png', textureFrom: 'default' });
  });

  it('never reuses a path that is taken, and splits a shared texture when the skies differ', () => {
    const files = starter();
    files.set('assets/nuit/sky/sky2_day.json', enc(starterDayText.replace('day.png', 'night.png')));
    const [night, day] = fromTemplate(files);
    const mine = (t: SkyTab): SkyTab => ({ ...t, sky: { ...t.sky, user: { name: 'x.png' } } });
    const outputs = layerOutputs([mine(night), mine(day), newTab('h', 'Hero')], files, OPTIONS);
    // Day shared night.png, so it gets its own texture: day.png is a file in the template, so day_2.png.
    // The new "Hero" tab can't take hero.png, the hero's texture.
    expect(outputs.map((o) => o.texturePath)).toEqual([
      'assets/sasheen/textures/sky/night.png', 'assets/sasheen/textures/sky/day_2.png', 'assets/sasheen/textures/sky/hero_2.png',
    ]);
    expect(JSON.parse(outputs[1].text).texture).toBe('sasheen:textures/sky/day_2.png');
    // Both from the template: sharing is fine, nothing is written.
    const kept = layerOutputs([night, day], files, OPTIONS);
    expect(kept.map((o) => o.texturePath)).toEqual(['assets/sasheen/textures/sky/night.png', 'assets/sasheen/textures/sky/night.png']);
  });

  it('turns a texture path back into a texture name', () => {
    expect(textureIdFromPath('assets/sasheen/textures/sky/day.png')).toBe('sasheen:textures/sky/day.png');
  });
});
