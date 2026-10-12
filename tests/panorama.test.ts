// Panorama → atlas (PLAN §13). The geometry is checked against the convention of reference/sky_convert.py,
// and the pixels against atlases the script itself produced from a synthetic panorama.

import { describe, expect, it } from 'vitest';
import { FACES, PANO_FACE_RANGE } from '../src/constants.ts';
import { atlasLayout, directionToPanorama, panoramaLayout, panoramaToAtlas, skyKindFromSize } from '../src/math.ts';
import type { RgbaImage, Vec3 } from '../src/schema.ts';
import { decodePng } from './png.ts';
import atlasF37 from '../reference/samples/pano_test_atlas_f37.png?inline';
import atlasF64 from '../reference/samples/pano_test_atlas_f64.png?inline';
import panoTest from '../reference/samples/pano_test_256x128.png?inline';

describe('sky file kinds (PLAN §13.4)', () => {
  it('tells an atlas from a panorama by shape', () => {
    expect(skyKindFromSize(1536, 1024)).toBe('atlas');
    expect(skyKindFromSize(2048, 1024)).toBe('panorama');
    expect(skyKindFromSize(1024, 1024)).toBeNull();
    expect(skyKindFromSize(0, 0)).toBeNull();
  });

  it('defaults the face size to a quarter of the width, capped like sky_convert.py', () => {
    expect(panoramaLayout(8192, 4096)).toEqual({ ok: true, faceSize: 2048 });
    expect(panoramaLayout(2048, 1024)).toEqual({ ok: true, faceSize: 512 });
    expect(panoramaLayout(16384, 8192)).toEqual({ ok: true, faceSize: PANO_FACE_RANGE.max });
    expect(panoramaLayout(1536, 1024)).toEqual({ ok: false, message: expect.stringContaining('1536 × 1024') });
  });
});

describe('panorama geometry (PLAN §13.1, sky_convert.py docstring)', () => {
  const W = 800;
  const H = 400;

  it('puts the W, N, E and S face centres at W/8, 3W/8, 5W/8 and 7W/8 on the horizon', () => {
    // Pixel centres sit on whole numbers, so the continuous position X is at x = X − ½.
    for (const [name, k] of [['west', 1], ['north', 3], ['east', 5], ['south', 7]] as const) {
      const face = FACES.find((f) => f.name === name)!;
      const p = directionToPanorama(face.centre, W, H);
      expect(p.x).toBeCloseTo((k * W) / 8 - 0.5, 9);
      expect(p.y).toBeCloseTo(H / 2 - 0.5, 9);
    }
  });

  it('puts straight up on the top row and straight down on the bottom row', () => {
    expect(directionToPanorama([0, 1, 0], W, H).y).toBeCloseTo(-0.5, 9);
    expect(directionToPanorama([0, -1, 0], W, H).y).toBeCloseTo(H - 0.5, 9);
    expect(directionToPanorama([0, 1, -1], W, H).y).toBeCloseTo(H / 4 - 0.5, 9); // 45° up
  });

  it('starts at the south-west corner and runs clockwise', () => {
    const sw: Vec3 = [-1, 0, 1];
    expect(directionToPanorama(sw, W, H).x).toBeCloseTo(-0.5, 9);
    const nw: Vec3 = [-1, 0, -1];
    expect(directionToPanorama(nw, W, H).x).toBeCloseTo(W / 4 - 0.5, 9);
  });

  it('turning the left edge by 45° moves everything by W/8', () => {
    for (const d of [[0, 0, -1], [0.3, 0.5, 1], [-1, -0.2, 0.4]] as Vec3[]) {
      const a = directionToPanorama(d, W, H, -135).x;
      const b = directionToPanorama(d, W, H, -90).x;
      expect((((a - b - W / 8) % W) + W) % W).toBeCloseTo(0, 9);
    }
  });
});

describe('panoramaToAtlas pixels', () => {
  it('a uniform panorama gives a uniform atlas of the right shape', () => {
    const pano: RgbaImage = { width: 64, height: 32, data: new Uint8ClampedArray(64 * 32 * 4).fill(77) };
    const atlas = panoramaToAtlas(pano, 20);
    expect([atlas.width, atlas.height]).toEqual([60, 40]);
    expect(atlasLayout(atlas.width, atlas.height)).toEqual({ ok: true, faceSize: 20 });
    expect(atlas.data.every((v) => v === 77)).toBe(true);
  });

  it('reports progress once per face', () => {
    const pano: RgbaImage = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4) };
    const calls: number[] = [];
    panoramaToAtlas(pano, 4, undefined, (done, total) => { expect(total).toBe(6); calls.push(done); });
    expect(calls).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // pano_test_256x128.png: R = column, G = 2 × row, B = a 16 px checkerboard. The atlases were written by
  // `python reference/sky_convert.py to-atlas pano_test_256x128.png pano_test_atlas_f<F>.png --face <F>`.
  for (const [face, fixture] of [[64, atlasF64], [37, atlasF37]] as const) {
    it(`matches sky_convert.py within 1 per channel, face ${face}`, async () => {
      const expected = await decodePng(fixture);
      const actual = panoramaToAtlas(await decodePng(panoTest), face);
      expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
      let worst = 0;
      let differing = 0;
      for (let i = 0; i < actual.data.length; i++) {
        const diff = Math.abs(actual.data[i] - expected.data[i]);
        worst = Math.max(worst, diff);
        if (diff > 0) differing++;
      }
      expect(worst).toBeLessThanOrEqual(1);
      expect(differing / actual.data.length).toBeLessThan(0.01); // off-by-one rounding stays rare
    });
  }
});
