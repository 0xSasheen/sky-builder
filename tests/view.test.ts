// The sky cube as scene.ts builds it, seen through the camera as view.ts points it (BRIEF §14 M2).
// The face table itself is checked against Nuit in faces.test.ts; this checks that the meshes and
// camera use it correctly. Only the texture on each plane is left to the visual check.

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FACES } from '../src/constants.ts';
import { facePlacement } from '../src/scene.ts';
import type { FaceName } from '../src/schema.ts';
import { applyCameraView } from '../src/view.ts';

const face = (name: FaceName) => FACES.find((f) => f.name === name)!;

/** Where the plane puts face coordinates (s, t): its local (s, t, 0). */
function meshPoint(name: FaceName, s: number, t: number): Vector3 {
  return new Vector3(s, t, 0).applyMatrix4(facePlacement(face(name)));
}

/** Normalised screen position of a face point: x right, y up, both −1 to 1 across the view. */
function onScreen(name: FaceName, s: number, t: number, bearingDeg: number, pitchDeg: number): { x: number; y: number } {
  const camera = new PerspectiveCamera(70, 1, 0.01, 10);
  applyCameraView(camera, bearingDeg, pitchDeg, 70);
  const p = meshPoint(name, s, t);
  const inFront = p.clone().applyMatrix4(camera.matrixWorldInverse).z < 0;
  expect(inFront).toBe(true);
  const ndc = p.project(camera);
  return { x: ndc.x, y: ndc.y };
}

describe('sky meshes follow the face table', () => {
  for (const f of FACES) {
    it(`${f.name}: the plane's (s, t) lands at centre + s·right + t·up`, () => {
      for (const s of [-1, -0.5, 0, 1]) {
        for (const t of [-1, 0, 0.5, 1]) {
          const expected = new Vector3(...f.centre).addScaledVector(new Vector3(...f.right), s).addScaledVector(new Vector3(...f.up), t);
          const actual = meshPoint(f.name, s, t);
          expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
        }
      }
    });

    it(`${f.name}: the front side faces the camera`, () => {
      const normal = new Vector3(0, 0, 1).transformDirection(facePlacement(f));
      expect(normal.distanceTo(new Vector3(...f.centre).negate())).toBeLessThan(1e-12);
    });
  }
});

describe('BRIEF §14 M2 checks, geometrically', () => {
  it('facing north at pitch 0: NORTH centred, W left, E right, horizon across the middle', () => {
    expect(onScreen('north', 0, 0, 0, 0).x).toBeCloseTo(0, 12);
    expect(onScreen('north', 0, 0, 0, 0).y).toBeCloseTo(0, 12);
    expect(onScreen('north', -0.9, 0.1, 0, 0).x).toBeLessThan(0); // the painted W
    expect(onScreen('north', 0.9, 0.1, 0, 0).x).toBeGreaterThan(0); // the painted E
    for (const s of [-0.9, -0.3, 0.4]) expect(onScreen('north', s, 0, 0, 0).y).toBeCloseTo(0, 12);
  });

  it('facing north at pitch +89: TOP shows S at the top, N at the bottom, W left, E right', () => {
    expect(onScreen('top', 0, 0.9, 0, 89).y).toBeGreaterThan(0.5); // the painted S
    expect(onScreen('top', 0, -0.9, 0, 89).y).toBeLessThan(-0.5); // the painted N
    expect(onScreen('top', -0.9, 0, 0, 89).x).toBeLessThan(-0.5); // the painted W
    expect(onScreen('top', 0.9, 0, 0, 89).x).toBeGreaterThan(0.5); // the painted E
  });

  it('turning right from north passes E, then S, then W', () => {
    for (const [name, bearing] of [['east', 90], ['south', 180], ['west', -90], ['west', 270]] as const) {
      const p = onScreen(name, 0, 0, bearing, 0);
      expect(p.x).toBeCloseTo(0, 12);
      expect(p.y).toBeCloseTo(0, 12);
    }
  });

  it('neighbouring faces meet: the right edge of one side face is the left edge of the next', () => {
    const ring: FaceName[] = ['north', 'east', 'south', 'west'];
    ring.forEach((name, i) => {
      const next = ring[(i + 1) % 4];
      for (const t of [-1, 0, 1]) expect(meshPoint(name, 1, t).distanceTo(meshPoint(next, -1, t))).toBeLessThan(1e-12);
    });
  });
});
