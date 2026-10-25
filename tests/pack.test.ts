// Assembling a resource pack (PLAN §16), with a synthetic template: the real layer JSONs from
// reference/pack-example and tiny stand-in bytes in place of images.

import { describe, expect, it } from 'vitest';
import sky1Text from '../reference/pack-example/assets/nuit/sky/sky1_night.json?raw';
import sky2Text from '../reference/pack-example/assets/nuit/sky/sky2_day.json?raw';
import sky3Text from '../reference/pack-example/assets/nuit/sky/sky3_image.json?raw';
import { buildSky3, HERO_MCMETA, serializeSky3 } from '../src/json.ts';
import {
  assemblePack, isPng, isZipFile, readTemplate, readZip, texturePath, writeZip, type PackFiles, type PackInputs,
} from '../src/pack.ts';
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

function inputs(overrides: Partial<PackInputs> = {}): PackInputs {
  const json = buildSky3(params(cases[2], { mappingYDeg: 30 }));
  return {
    jsonText: serializeSky3(json), texture: json.animatableTextures[0].texture,
    heroPng: bytes(30), skyPng: bytes(20), skyWidth: 1536, skyTarget: 'day', ...overrides,
  };
}

function assembled(overrides: Partial<PackInputs> = {}): { files: PackFiles; warnings: string[] } {
  const result = assemblePack(template(), inputs(overrides));
  if (!result.ok) throw new Error(`expected ok, got: ${result.problems.join(' | ')}`);
  return result;
}

describe('reading a template (PLAN §16.1)', () => {
  it('finds the hero layer and the night and day sky layers', () => {
    const info = readTemplate(template());
    expect(info.heroLayerFile).toBe('assets/nuit/sky/sky3_image.json');
    expect(info.oldHeroTexturePath).toBe('assets/sasheen/textures/sky/hero.png');
    expect(info.skyLayers).toEqual([
      { file: 'assets/nuit/sky/sky1_night.json', texturePath: 'assets/sasheen/textures/sky/night.png', role: 'night' },
      { file: 'assets/nuit/sky/sky2_day.json', texturePath: 'assets/sasheen/textures/sky/day.png', role: 'day' },
    ]);
    expect(info.problems).toEqual([]);
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

describe('assembling (PLAN §16.2)', () => {
  it('puts in the exported JSON, the hero, its .mcmeta, and the sky as the day texture', () => {
    const { files } = assembled();
    expect(dec(files.get('assets/nuit/sky/sky3_image.json'))).toBe(inputs().jsonText);
    expect(files.get('assets/sasheen/textures/sky/hero.png')).toEqual(bytes(30));
    expect(dec(files.get('assets/sasheen/textures/sky/hero.png.mcmeta'))).toBe(HERO_MCMETA);
    expect(files.get('assets/sasheen/textures/sky/day.png')).toEqual(bytes(20));
    expect(files.get('assets/sasheen/textures/sky/night.png')).toEqual(bytes(1)); // kept
    expect(dec(files.get('pack.mcmeta'))).toContain('pack_format');
    expect(dec(files.get('assets/nuit/sky/sky1_night.json'))).toBe(sky1Text); // copied unchanged
  });

  it('can put the sky on the night layer, both, or neither', () => {
    expect(assembled({ skyTarget: 'night' }).files.get('assets/sasheen/textures/sky/night.png')).toEqual(bytes(20));
    const both = assembled({ skyTarget: 'both' }).files;
    expect([both.get('assets/sasheen/textures/sky/night.png'), both.get('assets/sasheen/textures/sky/day.png')])
      .toEqual([bytes(20), bytes(20)]);
    const none = assembled({ skyTarget: 'none' }).files;
    expect([none.get('assets/sasheen/textures/sky/night.png'), none.get('assets/sasheen/textures/sky/day.png')])
      .toEqual([bytes(1), bytes(2)]);
  });

  it('a new texture path puts the hero there and notes the unused old one', () => {
    const json = buildSky3(params(cases[2], { texture: 'mine:textures/sky/girl.png' }));
    const { files, warnings } = assembled({ jsonText: serializeSky3(json), texture: 'mine:textures/sky/girl.png' });
    expect(files.get('assets/mine/textures/sky/girl.png')).toEqual(bytes(30));
    expect(files.has('assets/mine/textures/sky/girl.png.mcmeta')).toBe(true);
    expect(warnings).toContainEqual(expect.stringContaining('hero.png is no longer used'));
  });

  it('refuses an unusable texture path or a template that is not a pack', () => {
    expect(assemblePack(template(), inputs({ texture: 'Hero.png' }))).toEqual({ ok: false, problems: [expect.stringContaining('Hero.png')] });
    expect(assemblePack(new Map(), inputs()).ok).toBe(false);
  });

  it('warns about a very wide atlas', () => {
    expect(assembled({ skyWidth: 12288 }).warnings).toContainEqual(expect.stringContaining('12288 px'));
  });
});

describe('zip files', () => {
  it('round-trips every file byte for byte', () => {
    const { files } = assembled();
    const back = readZip(writeZip(files));
    expect([...back.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, data] of files) expect(back.get(path)).toEqual(data);
  });

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
