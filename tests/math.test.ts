import { describe, expect, it } from 'vitest';
import { K_RANGE } from '../src/constants.ts';
import {
  analyse, applyMapping, aspectFromUv, atlasLayout, atlasPointToCube, clampHero, clampPitch, faceToNorthUv,
  heightFromK, heroCentreDirection, heroPieces, kFromHeight, mcFacing, mcYawPitch, northUvToFace, noonBearingDeg,
  quadrantBearing, recoverParams, roundTo, scaleK, solveHero, sunAngleDeg, tiltedMappingX, tiltedUv, ticksToClock,
  uvRangeToFaceRect, viewToward, wallUv,
} from '../src/math.ts';
import type { Vec3 } from '../src/schema.ts';
import { cases, params } from './vectors.ts';

const tilted = cases.filter((c) => c.mode === 'tilted');
const wall = cases.filter((c) => c.mode === 'wall');
/** BRIEF §7 specifies cases 1 and 5 by β; cases 2–4 must be driven from k (case 4 is a rounding tie via β). */
const BETA_CASES = [cases[0], cases[4]];

describe('tilted mode (BRIEF §6.1, §7)', () => {
  for (const c of tilted) {
    it(`${c.name}: from k`, () => {
      const out = solveHero(params(c, { k: c.k! }));
      expect(out.uv).toEqual(c.expected.uvRange);
      expect(out.mapping).toEqual([c.expected.mappingX, 0, 0]);
    });

    it(`${c.name}: readouts`, () => {
      const aspect = c.image[0] / c.image[1];
      const r = analyse(tiltedUv(aspect, c.k!), tiltedMappingX(c.k!, c.bottomDeg), aspect);
      expect(roundTo(r.widthDeg, 1)).toBe(c.expected.widthDeg);
      expect(roundTo(r.topDeg, 1)).toBe(c.expected.topDeg);
      expect(r.bottomDeg).toBeCloseTo(c.bottomDeg, 9);
    });
  }

  for (const c of BETA_CASES) {
    it(`${c.name}: from β`, () => {
      const k = kFromHeight(c.heightDeg!);
      expect(Math.abs(k - c.k!)).toBeLessThan(1e-6);
      const out = solveHero(params(c, { k }));
      expect(out.uv).toEqual(c.expected.uvRange);
      expect(out.mapping).toEqual([c.expected.mappingX, 0, 0]);
    });
  }

  it('case 3 matches the running in-game config (BRIEF §5)', () => {
    const out = solveHero(params(cases[2], { k: cases[2].k! }));
    expect(out.uv).toEqual({ minU: 0.4249, minV: 0.5909, maxU: 0.5751, maxV: 0.9091 });
    expect(out.mapping).toEqual([22.47, 0, 0]);
  });

  it('mapping Y is rounded to 2 dp and Z stays 0', () => {
    const out = solveHero(params(cases[2], { k: cases[2].k!, mappingYDeg: 30.126 }));
    expect(out.mapping).toEqual([22.47, 30.13, 0]);
  });

  it('heightFromK inverts kFromHeight', () => {
    for (const beta of [5, 40.5, 60, 87]) expect(heightFromK(kFromHeight(beta))).toBeCloseTo(beta, 12);
  });
});

describe('wall mode (BRIEF §6.2, §7)', () => {
  for (const c of wall) {
    it(c.name, () => {
      const out = solveHero(params(c, {}));
      expect(out.uv).toEqual(c.expected.uvRange);
      expect(out.mapping).toEqual([0, 0, 0]);
      const r = analyse(wallUv(c.image[0] / c.image[1], c.bottomDeg, c.topFaceT!), 0);
      expect(roundTo(r.heightDeg, 1)).toBe(c.expected.heightDeg);
      expect(r.bottomDeg).toBeCloseTo(c.bottomDeg, 9);
      expect(r.warnings).toEqual([]); // t_t = 0.95 sits exactly on the limit, which is allowed
    });
  }
});

describe('scaling multiplies k (BRIEF §6.1, §7)', () => {
  it('reproduces the k of cases 2–4 from case 1', () => {
    const k1 = kFromHeight(40.5);
    const k2 = scaleK(k1, 1.5);
    const k3 = scaleK(k2, 1.15);
    const k4 = scaleK(k2, 1.5);
    expect(Math.abs(k2 - cases[1].k!)).toBeLessThan(1e-6);
    expect(Math.abs(k3 - cases[2].k!)).toBeLessThan(1e-6);
    expect(Math.abs(k4 - cases[3].k!)).toBeLessThan(1e-6);
  });
});

describe('inverse (BRIEF §6.3)', () => {
  it('northUvToFace inverts faceToNorthUv', () => {
    for (let s = -1; s <= 1; s += 0.25) {
      for (let t = -1; t <= 1; t += 0.25) {
        const { u, v } = faceToNorthUv(s, t);
        const back = northUvToFace(u, v);
        expect(back.s).toBeCloseTo(s, 12);
        expect(back.t).toBeCloseTo(t, 12);
      }
    }
  });

  it('maps the North cell corners to the face corners, V = 0 at the top', () => {
    expect(uvRangeToFaceRect({ minU: 1 / 3, minV: 0.5, maxU: 2 / 3, maxV: 1 }))
      .toEqual({ s0: expect.closeTo(-1, 12), s1: expect.closeTo(1, 12), t0: -1, t1: 1 });
  });

  for (const c of cases) {
    it(`${c.name}: rect is upright and centred left to right`, () => {
      const rect = uvRangeToFaceRect(c.expected.uvRange);
      expect(rect.t0).toBeLessThan(rect.t1);
      expect(rect.s0).toBeLessThan(rect.s1);
      expect(Math.abs(rect.s0 + rect.s1)).toBeLessThan(1e-3);
    });
  }

  for (const c of cases) {
    it(`${c.name}: recoverParams → solveHero gives the same JSON values`, () => {
      const recovered = recoverParams(c.expected.uvRange, [c.expected.mappingX, 0, 0]);
      expect(recovered.mode).toBe(c.mode);
      const out = solveHero(params(c, recovered));
      expect(out.uv).toEqual(c.expected.uvRange);
      expect(out.mapping).toEqual([c.expected.mappingX, 0, 0]);
    });
  }

  it('recovers mapping Y, and nothing else for a custom uvRange', () => {
    const offCentre = { minU: 0.36, minV: 0.6, maxU: 0.45, maxV: 0.8 };
    expect(recoverParams(offCentre, [10, -45, 0])).toEqual({ mappingYDeg: -45 });
  });

  it('aspectFromUv recovers the image aspect from case 3', () => {
    expect(Math.abs(aspectFromUv(cases[2].expected.uvRange) - 1063 / 1502)).toBeLessThan(1e-3);
  });
});

describe('constraints (BRIEF §6.1)', () => {
  const aspect = 1063 / 1502;
  const codes = (k: number, bottomDeg: number): string[] =>
    analyse(tiltedUv(aspect, k), tiltedMappingX(k, bottomDeg), aspect).warnings.map((w) => w.code);

  it('case 4 has no warnings', () => {
    expect(codes(cases[3].k!, cases[3].bottomDeg)).toEqual([]);
  });

  it('k = 0.96 warns about the vertical extent', () => {
    expect(codes(0.96, 0)).toEqual(['k']);
  });

  it('a wide hero warns about the horizontal extent', () => {
    const wide = 2;
    expect(analyse(tiltedUv(wide, 0.48), 0, wide).warnings.map((w) => w.code)).toEqual(['ak']);
  });

  it('k = 1.05 is outside the cell (error)', () => {
    const w = analyse(tiltedUv(aspect, 1.05), 0, aspect).warnings;
    expect(w.map((x) => [x.code, x.level])).toEqual([['outsideCell', 'error']]);
  });

  it('β = 87°, b = 10° tips over the zenith', () => {
    expect(codes(kFromHeight(87), 10)).toEqual(['zenith']);
  });

  it('a bottom edge below the horizon is allowed', () => {
    expect(codes(0.5, -30)).toEqual([]);
  });

  it('an off-centre uvRange is flagged', () => {
    const r = analyse({ minU: 0.36, minV: 0.6, maxU: 0.45, maxV: 0.8 }, 10);
    expect(r.warnings.map((w) => w.code)).toEqual(['notCentred']);
  });
});

describe('time (BRIEF §3, §4.7)', () => {
  it('θ hits the key values', () => {
    expect(sunAngleDeg(6000)).toBe(0);
    expect(sunAngleDeg(18000)).toBeCloseTo(180, 9);
    expect(Math.abs(sunAngleDeg(12000) - 77.63)).toBeLessThan(0.01);
    expect(Math.abs(sunAngleDeg(0) - 282.37)).toBeLessThan(0.01);
  });

  it('θ is periodic over one day', () => {
    for (const t of [0, 1234, 6000, 17999]) expect(sunAngleDeg(t + 24000)).toBeCloseTo(sunAngleDeg(t), 9);
  });

  it('θ stays within 0.06° of the pre-timeline vanilla formula', () => {
    // θ_old = 360° · (2f + ½ − ½cos(πf)) / 3, with f = frac(T/24000 − ¼)
    const old = (T: number): number => {
      const f = (((T / 24000 - 0.25) % 1) + 1) % 1;
      return (360 * (2 * f + 0.5 - 0.5 * Math.cos(Math.PI * f))) / 3;
    };
    let worst = 0;
    for (let T = 0; T < 24000; T += 10) {
      const diff = Math.abs((((sunAngleDeg(T) - old(T) + 180) % 360) + 360) % 360 - 180);
      worst = Math.max(worst, diff);
    }
    expect(worst).toBeLessThan(0.06);
  });

  it('ticks map to clock time', () => {
    expect(ticksToClock(0)).toEqual({ h: 6, m: 0 });
    expect(ticksToClock(6000)).toEqual({ h: 12, m: 0 });
    expect(ticksToClock(12000)).toEqual({ h: 18, m: 0 });
    expect(ticksToClock(18000)).toEqual({ h: 0, m: 0 });
    expect(ticksToClock(23500)).toEqual({ h: 5, m: 30 });
  });

  it('noon bearing is −Y, wrapped to (−180, 180]', () => {
    expect(noonBearingDeg(30)).toBe(-30);
    expect(noonBearingDeg(-90)).toBe(90);
    expect(noonBearingDeg(-180)).toBe(180);
    expect(noonBearingDeg(180)).toBe(180);
    expect(noonBearingDeg(0)).toBe(0);
  });
});

describe('view (BRIEF §9)', () => {
  it('pitch is clamped to ±89°', () => {
    expect(clampPitch(95)).toBe(89);
    expect(clampPitch(-120)).toBe(-89);
    expect(clampPitch(22.47)).toBe(22.47);
  });

  it("matches Minecraft's F3 yaw: 0 = south, 90 = west, ±180 = north", () => {
    expect(mcYawPitch(0, 0)).toEqual({ yaw: 180, pitch: 0 });
    expect(mcYawPitch(90, 0).yaw).toBe(-90); // east
    expect(mcYawPitch(180, 0).yaw).toBe(0); // south
    expect(mcYawPitch(-90, 0).yaw).toBe(90); // west
    expect(mcYawPitch(-30, 0).yaw).toBe(150); // PLAN §10 check A: hero 30° west of north
  });

  it("matches Minecraft's F3 pitch: positive looks down", () => {
    expect(mcYawPitch(0, 22.47).pitch).toBe(-22.47);
    expect(Object.is(mcYawPitch(0, 0).pitch, 0)).toBe(true); // not −0
  });

  it('names the facing like F3, nearest of four', () => {
    expect([0, 44.9, 45, 90, 180, -90, -135, 180].map(mcFacing))
      .toEqual(['north', 'north', 'east', 'east', 'south', 'west', 'west', 'south']);
  });
});

describe('atlas layout (BRIEF §8)', () => {
  it('accepts exactly 3:2 and gives the face size', () => {
    expect(atlasLayout(1536, 1024)).toEqual({ ok: true, faceSize: 512 });
    expect(atlasLayout(8190, 5460)).toEqual({ ok: true, faceSize: 2730 });
  });

  it('rejects anything else, naming the actual size', () => {
    expect(atlasLayout(1537, 1024)).toEqual({ ok: false, message: expect.stringContaining('1537 × 1024') });
    expect(atlasLayout(1024, 1024).ok).toBe(false);
    expect(atlasLayout(0, 0).ok).toBe(false);
  });
});

describe('hero inputs (PLAN §12)', () => {
  it('clamps k to K_RANGE, and rounds the image size and layer', () => {
    const p = params(cases[2]);
    expect(clampHero({ ...p, k: 5 }).k).toBe(K_RANGE.max);
    expect(clampHero({ ...p, k: 0 }).k).toBe(K_RANGE.min);
    expect(clampHero({ ...p, k: 0.98 }).k).toBe(0.98); // past the 0.95 warning, still allowed
    expect(clampHero({ ...p, imageW: 1062.6, imageH: 0, layer: 3.4 })).toMatchObject({ imageW: 1063, imageH: 1, layer: 3 });
  });

  it('the k range reaches the warning and the error, and β = 5° is the bottom', () => {
    expect(K_RANGE.max).toBeGreaterThan(1);
    expect(heightFromK(K_RANGE.min)).toBeCloseTo(5, 12);
  });

  it('a wall-mode bottom edge above the top edge is an error, and nothing else is reported', () => {
    const aspect = 1063 / 1502;
    const w = analyse(wallUv(aspect, 50, 0.95), 0, aspect).warnings;
    expect(w.map((x) => [x.code, x.level])).toEqual([['empty', 'error']]);
  });
});

describe('hero pieces, as Nuit draws them (BRIEF §4.1)', () => {
  const aspect = 1063 / 1502;

  it('case 3 is one piece on the North face, showing the whole image', () => {
    const uv = cases[2].expected.uvRange;
    const pieces = heroPieces(uv);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].face).toBe('north');
    const r = uvRangeToFaceRect(uv);
    for (const key of ['s0', 's1', 't0', 't1'] as const) expect(pieces[0].rect[key]).toBeCloseTo(r[key], 12);
    expect(pieces[0].tex).toEqual({ u0: 0, u1: 1, v0: 0, v1: 1 });
  });

  it('a hero taller than the face spills onto the Top face, and the whole image is fitted into the clamped range', () => {
    // k = 1.2: v runs from 0.45 (inside the Top cell) to 1.05, which Nuit clamps to 1, the bottom of the atlas.
    const pieces = heroPieces(tiltedUv(aspect, 1.2));
    expect(pieces.map((p) => p.face)).toEqual(['top', 'north']);
    const [top, north] = pieces;
    expect(north.rect.t0).toBeCloseTo(-1, 12);
    expect(north.rect.t1).toBeCloseTo(1, 12);
    expect(top.rect.t0).toBeCloseTo(-1, 12); // the Top face's north edge, where it meets North
    // The top of the image (v = 0) goes on the Top face; North starts where it ends and runs to the image's bottom.
    expect(top.tex.v0).toBe(0);
    expect(north.tex.v0).toBeCloseTo(top.tex.v1, 12);
    expect(north.tex.v1).toBe(1);
    expect(top.tex.v1).toBeCloseTo((0.5 - 0.45) / (1 - 0.45), 12);
  });

  it('clamps to [0, 1] like Nuit, and an empty or reversed range draws nothing', () => {
    expect(heroPieces({ minU: -0.5, minV: 0.5, maxU: 0.2, maxV: 1 }).map((p) => p.face)).toEqual(['west']);
    expect(heroPieces({ minU: 0.4, minV: 0.8, maxU: 0.6, maxV: 0.6 })).toEqual([]);
  });
});

describe('directions (BRIEF §4.5, §4.6)', () => {
  const close = (a: Vec3, b: Vec3): void => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 12));
  const case3 = solveHero(params(cases[2]));

  it('atlas points land on the right face', () => {
    close(atlasPointToCube(0.5, 0.75), [0, 0, -1]); // North centre
    close(atlasPointToCube(0.5, 0.25), [0, 1, 0]); // Top centre
    close(atlasPointToCube(1 / 6, 0.75), [-1, 0, 0]); // West centre
    close(atlasPointToCube(0.5, 0.5), [0, 1, -1]); // top edge of North = north edge of Top
  });

  it('mapping X tilts north up, mapping Y turns it west', () => {
    const [, y, z] = applyMapping([0, 0, -1], [30, 0, 0]);
    expect(Math.atan2(y, -z) * 180 / Math.PI).toBeCloseTo(30, 12);
    close(applyMapping([0, 0, -1], [0, 90, 0]), [-1, 0, 0]);
  });

  it('look at hero, case 3 at noon: due north, pitch 22.47°', () => {
    const v = viewToward(heroCentreDirection(case3.uv, case3.mapping, sunAngleDeg(6000)));
    expect(v.yawDeg).toBeCloseTo(0, 9);
    expect(v.pitchDeg).toBeCloseTo(22.47, 9);
  });

  it('look at hero follows mapping Y and the spin', () => {
    expect(viewToward(heroCentreDirection(case3.uv, [22.47, 30, 0], 0)).yawDeg).toBeCloseTo(-30, 9);
    expect(Math.abs(viewToward(heroCentreDirection(case3.uv, case3.mapping, sunAngleDeg(18000))).yawDeg)).toBeCloseTo(180, 6);
  });

  it('viewToward clamps straight up to the pitch limit', () => {
    expect(viewToward([0, 1, 0]).pitchDeg).toBe(89);
  });

  it('quadrant bearings', () => {
    expect(quadrantBearing(-30)).toEqual({ from: 'N', deg: 30, to: 'W' });
    expect(quadrantBearing(150)).toEqual({ from: 'S', deg: 30, to: 'E' });
    expect(quadrantBearing(-90)).toEqual({ from: 'N', deg: 90, to: 'W' });
    expect(quadrantBearing(0)).toEqual({ from: 'N', deg: 0, to: 'E' });
    expect(quadrantBearing(180)).toEqual({ from: 'S', deg: 0, to: 'E' });
  });
});
