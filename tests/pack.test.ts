// Assembling a resource pack (PLAN §16), with a synthetic template: the real layer JSONs from
// reference/pack-example and tiny stand-in bytes in place of images.

import { describe, expect, it } from 'vitest';
import sky1Text from '../reference/pack-example/assets/nuit/sky/sky1_night.json?raw';
import sky2Text from '../reference/pack-example/assets/nuit/sky/sky2_day.json?raw';
import sky3Text from '../reference/pack-example/assets/nuit/sky/sky3_image.json?raw';
import starterDayText from '../reference/samples/starter_pack/assets/nuit/sky/sky2_day.json?raw';
import { buildSky3, HERO_MCMETA, serializeSky3 } from '../src/json.ts';
import {
  assembleTabs, isPng, isZipFile, readTemplate, readZip, texturePath, writeZip, type PackFiles,
} from '../src/pack.ts';
import type { SkyTab } from '../src/schema.ts';
import { mergeTemplate, newTab } from '../src/tabs.ts';
import { cases, params } from './vectors.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

/** The developer's template layout (PLAN §16.1). */
function template(): PackFiles {
  return new Map([
    ['pack.mcmeta', enc('{"pack": {"pack_format": 1, "description": "test"}}')],
    ['assets/nuit/sky/sky1_night.json', enc(sky1Text)],
    ['assets/nuit/sky/sky2_day.json', enc(sky2Text)],
    ['assets/nuit/sky/sky3_image.json', enc(sky3Text)],
    ['assets/sasheen/textures/sky/night.png', bytes(1)],
    ['assets/sasheen/textures/sky/day.png', bytes(2)],
    ['assets/sasheen/textures/sky/hero.png', bytes(3)],
    ['assets/sasheen/textures/sky/hero.png.mcmeta', enc(HERO_MCMETA)],
  ]);
}

describe('reading a template (PLAN §16.1)', () => {
  it('finds the hero layer and the night and day sky layers', () => {
    const info = readTemplate(template());
    expect(info.heroLayerFile).toBe('assets/nuit/sky/sky3_image.json');
    expect(info.oldHeroTexturePath).toBe('assets/sasheen/textures/sky/hero.png');
    expect(info.skyLayers).toMatchObject([
      { file: 'assets/nuit/sky/sky1_night.json', texturePath: 'assets/sasheen/textures/sky/night.png', role: 'night' },
      { file: 'assets/nuit/sky/sky2_day.json', texturePath: 'assets/sasheen/textures/sky/day.png', role: 'day' },
    ]);
    expect(info.problems).toEqual([]);
  });

  it('tells night from day by empty keyFrames, not by "alwaysOn", which 26.2 ignores (PLAN §17.1)', () => {
    const t = template();
    t.set('assets/nuit/sky/sky1_night.json', enc(sky1Text.replace('"alwaysOn": true,', '')));
    t.set('assets/nuit/sky/sky2_day.json', enc(sky2Text.replace('"alwaysOn": false,', '')));
    expect(sky1Text).toContain('"alwaysOn": true,'); // the replacements above did something
    expect(readTemplate(t).skyLayers.map((l) => l.role)).toEqual(['night', 'day']);

    // A misleading alwaysOn changes nothing either: Nuit never reads it.
    t.set('assets/nuit/sky/sky2_day.json', enc(sky2Text.replace('"alwaysOn": false', '"alwaysOn": true')));
    expect(readTemplate(t).skyLayers.map((l) => l.role)).toEqual(['night', 'day']);
  });

  it('notes the old top-level "blend" in both sky layers, and that their rotation matches the hero', () => {
    const warnings = readTemplate(template()).warnings;
    expect(warnings.filter((w) => w.includes('top-level "blend"'))).toHaveLength(2);
    expect(warnings.some((w) => w.includes('drift'))).toBe(false);
  });

  it('warns about a sky layer that turns differently', () => {
    const t = template();
    t.set('assets/nuit/sky/sky2_day.json', enc(sky2Text.replace('"skyboxRotation": false', '"skyboxRotation": true')));
    expect(readTemplate(t).warnings).toContainEqual(expect.stringContaining('sky2_day.json turns differently'));
  });

  it('refuses a zip that is not a pack', () => {
    expect(readTemplate(new Map([['readme.txt', enc('hi')]])).problems).toHaveLength(2);
  });

  it('maps texture names to paths in the zip', () => {
    expect(texturePath('sasheen:textures/sky/hero.png')).toBe('assets/sasheen/textures/sky/hero.png');
    expect(texturePath('Bad:Name.png')).toBeNull();
  });
});

describe('zip files', () => {
  it('a non-zip is an error', () => {
    expect(() => readZip(enc('not a zip'))).toThrow();
  });

  it('recognises zips by type or name, and PNGs by their signature', () => {
    expect(isZipFile('MyPack.ZIP', '')).toBe(true);
    expect(isZipFile('pack', 'application/x-zip-compressed')).toBe(true);
    expect(isZipFile('hero.png', 'image/png')).toBe(false);
    expect(isPng(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(true);
    expect(isPng(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe(false); // a JPEG
  });
});

describe('the bundled starter template (PLAN §16.7)', () => {
  // The text files as they are; the PNGs only need to exist, so their names are enough here.
  const text = import.meta.glob('../reference/samples/starter_pack/**/*.{json,mcmeta,txt}',
    { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const pngs = Object.keys(import.meta.glob('../reference/samples/starter_pack/**/*.png'));
  const prefix = '../reference/samples/starter_pack/';
  const starter: PackFiles = new Map([
    ...Object.entries(text).map(([path, body]) => [path.slice(prefix.length), enc(body)] as [string, Uint8Array]),
    ...pngs.map((path) => [path.slice(prefix.length), bytes(0)] as [string, Uint8Array]),
  ]);

  it('is a clean Nuit pack: hero, night and day layers, nothing to warn about', () => {
    const info = readTemplate(starter);
    expect(info.problems).toEqual([]);
    expect(info.warnings).toEqual([]);
    expect(info.heroLayerFile).toBe('assets/nuit/sky/sky3_image.json');
    expect(info.skyLayers.map((l) => [l.role, l.texturePath])).toEqual([
      ['night', 'assets/sasheen/textures/sky/night.png'],
      ['day', 'assets/sasheen/textures/sky/day.png'],
    ]);
  });

  it('declares a 26.2 pack format', () => {
    expect(JSON.parse(dec(starter.get('pack.mcmeta'))).pack).toMatchObject({ min_format: 88, max_format: 88 });
  });
});

describe('assembling from sky tabs (PLAN §17.8)', () => {
  const NIGHT_DEFAULT = bytes(91);
  const DAY_DEFAULT = bytes(92);
  const tabsOf = (files: PackFiles): SkyTab[] => {
    let n = 0;
    return mergeTemplate([], readTemplate(files).skyLayers, () => `t${++n}`, { addMissing: true });
  };
  const withSky = (tab: SkyTab): SkyTab => ({ ...tab, sky: { ...tab.sky, user: { name: 'mine.png' } } });

  function assembleWith(tabs: SkyTab[], skyPngs: [string, number][] = [], files = template()): { files: PackFiles; warnings: string[] } {
    const json = buildSky3(params(cases[2], { layer: tabs.filter((t) => t.include).length + 1 }));
    const result = assembleTabs(files, {
      jsonText: serializeSky3(json), texture: json.animatableTextures[0].texture, heroPng: bytes(30), tabs,
      skyPngs: new Map(skyPngs.map(([id, b]) => [id, { png: bytes(b), width: 1536 }])),
      defaultSky: { base: NIGHT_DEFAULT, other: DAY_DEFAULT }, newLayerText: starterDayText,
    });
    if (!result.ok) throw new Error(`expected ok, got: ${result.problems.join(' | ')}`);
    return result;
  }

  it('with the template\'s own tabs: the same files, the layers rewritten for 26.2, the textures kept', () => {
    const { files, warnings } = assembleWith(tabsOf(template()));
    expect([...files.keys()].sort()).toEqual([...template().keys()].sort());
    const night = JSON.parse(dec(files.get('assets/nuit/sky/sky1_night.json')));
    const day = JSON.parse(dec(files.get('assets/nuit/sky/sky2_day.json')));
    expect([night.blend, night.properties.fade.alwaysOn, night.properties.layer, night.properties.fade.keyFrames])
      .toEqual([undefined, undefined, 1, {}]);
    expect([day.properties.layer, day.properties.fade.keyFrames]).toEqual([2, { 4000: 1, 8000: 1, 16000: 0, 20000: 0 }]);
    expect(files.get('assets/sasheen/textures/sky/night.png')).toEqual(bytes(1));
    expect(files.get('assets/sasheen/textures/sky/day.png')).toEqual(bytes(2));
    expect(JSON.parse(dec(files.get('assets/nuit/sky/sky3_image.json'))).properties.layer).toBe(3);
    expect(warnings.filter((w) => !w.includes('top-level "blend"'))).toEqual([]);
  });

  it('puts each tab\'s own sky at its texture', () => {
    const [night, day] = tabsOf(template());
    const { files } = assembleWith([night, withSky(day)], [[day.id, 20]]);
    expect(files.get('assets/sasheen/textures/sky/day.png')).toEqual(bytes(20));
    expect(files.get('assets/sasheen/textures/sky/night.png')).toEqual(bytes(1));
  });

  it('leaves out an excluded tab\'s layer and texture, and the next tab becomes the always-on base', () => {
    const [night, day] = tabsOf(template());
    const { files, warnings } = assembleWith([{ ...night, include: false }, day]);
    expect(files.has('assets/nuit/sky/sky1_night.json')).toBe(false);
    expect(files.has('assets/sasheen/textures/sky/night.png')).toBe(false);
    const dayJson = JSON.parse(dec(files.get('assets/nuit/sky/sky2_day.json')));
    expect([dayJson.properties.layer, dayJson.properties.fade.keyFrames]).toEqual([1, {}]);
    expect(warnings).toContainEqual(expect.stringContaining('Left out'));
  });

  it('keeps an excluded layer\'s texture that an included layer still uses', () => {
    const files = template();
    files.set('assets/nuit/sky/sky2_day.json', enc(sky2Text.replace('day.png', 'night.png')));
    const [night, day] = tabsOf(files);
    expect(assembleWith([{ ...night, include: false }, day], [], files).files.has('assets/sasheen/textures/sky/night.png')).toBe(true);
  });

  it('adds a new tab as a new layer, with its own sky or the default one', () => {
    const [night, day] = tabsOf(template());
    const sunrise = { ...newTab('s', 'Sunrise'), keyFrames: [{ tick: 23000, alpha: 1 }, { tick: 1000, alpha: 0 }] };
    const own = assembleWith([night, day, withSky(sunrise)], [['s', 40]]).files;
    expect(JSON.parse(dec(own.get('assets/nuit/sky/sky3_sunrise.json')))).toMatchObject({
      type: 'nuit:square-textured', texture: 'sasheen:textures/sky/sunrise.png',
      properties: { layer: 3, fade: { duration: 24000, keyFrames: { 1000: 0, 23000: 1 } } },
    });
    expect(own.get('assets/sasheen/textures/sky/sunrise.png')).toEqual(bytes(40));
    expect(JSON.parse(dec(own.get('assets/nuit/sky/sky3_image.json'))).properties.layer).toBe(4);

    const { files, warnings } = assembleWith([night, day, sunrise]);
    expect(files.get('assets/sasheen/textures/sky/sunrise.png')).toEqual(DAY_DEFAULT);
    expect(warnings).toContainEqual('Sunrise has no sky of its own, so the default sky goes in.');
  });

  it('the base gets the night default; a picked sky that is not loaded falls back to the default, with a note', () => {
    const files = template();
    files.delete('assets/sasheen/textures/sky/night.png');
    const [night, day] = tabsOf(files);
    expect(assembleWith([night, day], [], files).files.get('assets/sasheen/textures/sky/night.png')).toEqual(NIGHT_DEFAULT);
    const { files: out, warnings } = assembleWith([night, withSky(day)], [], files);
    expect(out.get('assets/sasheen/textures/sky/day.png')).toEqual(DAY_DEFAULT);
    expect(warnings).toContainEqual(expect.stringContaining('loaded yet'));
  });

  it('notes another Nuit layer among the renumbered ones, and copies it unchanged', () => {
    const files = template();
    const decorations = '{"schemaVersion": 1, "type": "nuit:decorations", "properties": {"layer": 2}}';
    files.set('assets/nuit/sky/stars.json', enc(decorations));
    const { files: out, warnings } = assembleWith(tabsOf(files), [], files);
    expect(dec(out.get('assets/nuit/sky/stars.json'))).toBe(decorations);
    expect(warnings).toContainEqual(expect.stringContaining('stars.json (nuit:decorations) is layer 2'));
  });

  it('puts in the exported JSON, the hero and its .mcmeta, and copies the rest unchanged', () => {
    const { files } = assembleWith(tabsOf(template()));
    const json = buildSky3(params(cases[2], { layer: 3 }));
    expect(dec(files.get('assets/nuit/sky/sky3_image.json'))).toBe(serializeSky3(json));
    expect(files.get('assets/sasheen/textures/sky/hero.png')).toEqual(bytes(30));
    expect(dec(files.get('assets/sasheen/textures/sky/hero.png.mcmeta'))).toBe(HERO_MCMETA);
    expect(dec(files.get('pack.mcmeta'))).toContain('pack_format');
  });

  it('a new hero texture path puts the hero there and notes the unused old one', () => {
    const json = buildSky3(params(cases[2], { texture: 'mine:textures/sky/girl.png' }));
    const result = assembleTabs(template(), {
      jsonText: serializeSky3(json), texture: 'mine:textures/sky/girl.png', heroPng: bytes(30), tabs: tabsOf(template()),
      skyPngs: new Map(), defaultSky: { base: NIGHT_DEFAULT, other: DAY_DEFAULT }, newLayerText: starterDayText,
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.files.get('assets/mine/textures/sky/girl.png')).toEqual(bytes(30));
    expect(result.files.has('assets/mine/textures/sky/girl.png.mcmeta')).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringContaining('hero.png is no longer used'));
  });

  it('warns about a very wide atlas', () => {
    const [night, day] = tabsOf(template());
    const result = assembleTabs(template(), {
      jsonText: '{}', texture: 'sasheen:textures/sky/hero.png', heroPng: bytes(30), tabs: [night, withSky(day)],
      skyPngs: new Map([[day.id, { png: bytes(20), width: 12288 }]]),
      defaultSky: { base: NIGHT_DEFAULT, other: DAY_DEFAULT }, newLayerText: starterDayText,
    });
    expect(result.ok && result.warnings).toContainEqual(expect.stringContaining('12288 px'));
  });

  it('refuses an unusable texture path or a template that is not a pack, and round-trips through a zip', () => {
    const tabs = tabsOf(template());
    const inputs = {
      jsonText: '', texture: 'Hero.png', heroPng: bytes(30), tabs, skyPngs: new Map(),
      defaultSky: { base: NIGHT_DEFAULT, other: DAY_DEFAULT }, newLayerText: starterDayText,
    };
    expect(assembleTabs(template(), inputs).ok).toBe(false);
    expect(assembleTabs(new Map(), { ...inputs, texture: 'sasheen:textures/sky/hero.png' }).ok).toBe(false);
    const { files } = assembleWith(tabs);
    const back = readZip(writeZip(files));
    for (const [path, data] of files) expect(back.get(path)).toEqual(data);
  });
});
