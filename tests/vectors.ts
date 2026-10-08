// Shared access to reference/test-vectors.json (BRIEF §7).

import vectors from '../reference/test-vectors.json';
import { DEFAULTS } from '../src/constants.ts';
import type { HeroParams, UvRange } from '../src/schema.ts';

export interface TestCase {
  name: string;
  mode: 'tilted' | 'wall';
  image: number[];
  heightDeg?: number;
  k?: number;
  bottomDeg: number;
  topFaceT?: number;
  expected: { uvRange: UvRange; mappingX: number; widthDeg?: number; topDeg?: number; heightDeg?: number };
}

export const cases = vectors.cases as TestCase[];

/** Slider values for a case. Tilted cases are driven from the file's k (see BRIEF §7). */
export function params(c: TestCase, overrides: Partial<HeroParams> = {}): HeroParams {
  return {
    mode: c.mode, imageW: c.image[0], imageH: c.image[1], k: c.k ?? 0, bottomDeg: c.bottomDeg,
    wallTopT: c.topFaceT ?? DEFAULTS.wallTopT, mappingYDeg: 0, texture: DEFAULTS.texture,
    layer: DEFAULTS.layer, ...overrides,
  };
}
