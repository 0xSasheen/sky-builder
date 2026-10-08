import { describe, expect, it } from 'vitest';
import sky1Text from '../reference/pack-example/assets/nuit/sky/sky1_night.json?raw';
import sky3Text from '../reference/pack-example/assets/nuit/sky/sky3_image.json?raw';
import mcmetaText from '../reference/pack-example/assets/sasheen/textures/sky/hero.png.mcmeta?raw';
import {
  buildSky3, fmtFloat, HERO_MCMETA, makeSky3, mcmetaFileName, parseSky3, serializeSky3,
  type ParseResult,
} from '../src/json.ts';
import { cases, params } from './vectors.ts';

/** Parses the reference sky3 file, applies an edit, and imports the result. */
function importEdited(edit: (j: Record<string, any>) => void): ParseResult {
  const j = JSON.parse(sky3Text);
  edit(j);
  return parseSky3(JSON.stringify(j));
}

function expectOk(r: ParseResult): Extract<ParseResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got errors: ${r.errors.join(' | ')}`);
  return r;
}

describe('serializeSky3 (BRIEF §5)', () => {
  it('case 3 is byte-identical to the working pack file', () => {
    expect(serializeSky3(buildSky3(params(cases[2])))).toBe(sky3Text);
  });

  it('writes the editable fields', () => {
    const json = makeSky3({ minU: 0.4, minV: 0.55, maxU: 0.6, maxV: 0.95 }, [30, -45.5, 0], 'ns:sky/a "b".png', 7);
    const text = serializeSky3(json);
    expect(text).toContain('"layer": 7,');
    expect(text).toContain('"mapping": {"0": [30.0, -45.5, 0.0]},');
    expect(text).toContain('"texture": "ns:sky/a \\"b\\".png",');
    expect(text).toContain('"uvRange": {"minU": 0.4, "minV": 0.55, "maxU": 0.6, "maxV": 0.95},');
    expect(JSON.parse(text)).toEqual(json);
  });

  it('fmtFloat keeps a decimal point', () => {
    expect(fmtFloat(22.47)).toBe('22.47');
    expect(fmtFloat(30)).toBe('30.0');
    expect(fmtFloat(0)).toBe('0.0');
    expect(fmtFloat(-0)).toBe('0.0');
    expect(fmtFloat(-15)).toBe('-15.0');
    expect(fmtFloat(0.5)).toBe('0.5');
    expect(() => fmtFloat(NaN)).toThrow(RangeError);
    expect(() => fmtFloat(Infinity)).toThrow(RangeError);
  });

  it('the .mcmeta matches the pack file', () => {
    expect(HERO_MCMETA).toBe(mcmetaText);
    expect(JSON.parse(HERO_MCMETA)).toEqual({ texture: { blur: true, clamp: true } });
    expect(mcmetaFileName('sasheen:textures/sky/hero.png')).toBe('hero.png.mcmeta');
  });
});

describe('parseSky3 (BRIEF §6.3, §8)', () => {
  it('imports the working pack file with no warnings', () => {
    const r = expectOk(parseSky3(sky3Text));
    expect(r.warnings).toEqual([]);
    expect(r.json).toEqual(buildSky3(params(cases[2])));
    expect(r.recovered.mode).toBe('tilted');
    expect(r.recovered.k).toBeCloseTo(cases[2].k!, 3);
    expect(r.recovered.bottomDeg).toBeCloseTo(-10, 2);
    expect(r.recovered).toMatchObject({ mappingYDeg: 0, texture: 'sasheen:textures/sky/hero.png', layer: 3 });
  });

  for (const c of cases) {
    it(`${c.name}: export → import → export is identical`, () => {
      const text = serializeSky3(buildSky3(params(c, { mappingYDeg: -37.5 })));
      const r = expectOk(parseSky3(text));
      expect(serializeSky3(r.json)).toBe(text);
      expect(serializeSky3(buildSky3(params(c, r.recovered)))).toBe(text);
    });
  }

  it('keeps the imported uvRange and mapping exactly (pinned)', () => {
    const r = expectOk(importEdited((j) => {
      j.properties.rotation.mapping = { '0': [22.471, 5.005, 0] };
      j.animatableTextures[0].uvRange.minU = 0.42491;
      j.animatableTextures[0].uvRange.maxU = 0.57509;
    }));
    expect(r.json.properties.rotation.mapping).toEqual({ '0': [22.471, 5.005, 0] });
    expect(r.json.animatableTextures[0].uvRange.minU).toBe(0.42491);
  });

  it('warns that a missing axis would stop the spin, and adds it back', () => {
    const r = expectOk(importEdited((j) => { delete j.properties.rotation.axis; }));
    expect(r.warnings).toEqual([expect.stringContaining('would not spin')]);
    expect(r.json.properties.rotation.axis).toEqual({ '0': [0, 0, 0] });
  });

  it('warns about a top-level blend', () => {
    const r = expectOk(importEdited((j) => { j.blend = { type: 'normal' }; }));
    expect(r.warnings).toEqual([expect.stringContaining('top-level "blend"')]);
  });

  it('warns about every fixed field it will normalise', () => {
    const r = expectOk(importEdited((j) => {
      j.properties.rotation.speed = 2;
      j.properties.rotation.skyboxRotation = true;
      j.properties.rotation.mapping['0'][2] = 15;
      j.properties.fade.keyFrames = { '0': 1 };
      j.properties.fog = {};
    }));
    expect(r.warnings).toHaveLength(5);
    expect(r.json).toEqual(buildSky3(params(cases[2])));
  });

  it('warns when the uvRange fits neither mode, and recovers only mapping Y', () => {
    const r = expectOk(importEdited((j) => {
      j.animatableTextures[0].uvRange = { minU: 0.36, minV: 0.6, maxU: 0.45, maxV: 0.8 };
      j.properties.rotation.mapping = { '0': [10, -45, 0] };
    }));
    expect(r.warnings).toEqual([expect.stringContaining('neither tilted nor wall')]);
    expect(r.recovered.mode).toBeUndefined();
    expect(r.recovered.mappingYDeg).toBe(-45);
  });

  it('rejects a uvRange outside the North cell', () => {
    const r = importEdited((j) => { j.animatableTextures[0].uvRange.minU = 0.2; });
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining('not inside the North cell')] });
  });

  it('accepts a uvRange rounded onto the cell edge', () => {
    expectOk(importEdited((j) => { j.animatableTextures[0].uvRange = { minU: 0.3333, minV: 0.5, maxU: 0.6667, maxV: 1 }; }));
  });

  it('rejects invalid JSON, the wrong type, and a missing uvRange', () => {
    expect(parseSky3('{ nope').ok).toBe(false);
    expect(parseSky3(sky1Text)).toEqual({ ok: false, errors: [expect.stringContaining('"nuit:square-textured"')] });
    const r = importEdited((j) => { delete j.animatableTextures[0].uvRange; });
    expect(r.ok).toBe(false);
  });
});
