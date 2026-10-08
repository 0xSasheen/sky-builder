// Checks the face table and the hero transform against a port of Nuit 26.2's own geometry (PLAN §1.2, §1.4).
// Uses three for the matrix maths; src/math.ts itself never imports it (rule 2).

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FACES, SIGN_MAPPING_X, SIGN_MAPPING_Y } from '../src/constants.ts';
import { buildSky3 } from '../src/json.ts';
import { sunAngleDeg, uvRangeToFaceRect } from '../src/math.ts';
import type { FaceName, Sky3Json } from '../src/schema.ts';
import { cases, params } from './vectors.ts';

const DEG = Math.PI / 180;
const X_AXIS = new Vector3(1, 0, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const Z_AXIS = new Vector3(0, 0, 1);

const rotX = (deg: number): Matrix4 => new Matrix4().makeRotationX(deg * DEG);
const rotY = (deg: number): Matrix4 => new Matrix4().makeRotationY(deg * DEG);
const rotZ = (deg: number): Matrix4 => new Matrix4().makeRotationZ(deg * DEG);

// --- Port of Nuit's Utils.java (26.2/dev) ---------------------------------------
// JOML's Matrix4f.rotateX(a) post-multiplies (M ← M·R), which is three's multiply().

/** Utils.MATRIX4F_ROTATED_FACE, in Nuit's face order. */
const NUIT_FACE_MATRIX: Record<FaceName, Matrix4> = {
  bottom: new Matrix4(),
  north: rotX(90),
  south: rotX(-90).multiply(rotY(180)),
  top: rotX(180),
  east: rotZ(90).multiply(rotY(-90)),
  west: rotZ(-90).multiply(rotY(90)),
};

/** Utils.TEXTURE_FACES: each face's atlas cell as [minU, minV, maxU, maxV]. */
const NUIT_TEXTURE_FACES: Record<FaceName, [number, number, number, number]> = {
  bottom: [0, 0, 1 / 3, 1 / 2],
  north: [1 / 3, 1 / 2, 2 / 3, 1],
  south: [2 / 3, 0, 1, 1 / 2],
  top: [1 / 3, 0, 2 / 3, 1 / 2],
  east: [2 / 3, 1 / 2, 1, 1],
  west: [0, 1 / 2, 1 / 3, 1],
};

/**
 * Where Nuit draws atlas point (u, v) of a face: MultiTexturedSkybox maps the cell onto a quad
 * x, z ∈ [−100, 100] on the plane y = −100 (minU, minV at −100), then applies the face matrix.
 */
function nuitVertex(face: FaceName, u: number, v: number): Vector3 {
  const [minU, minV, maxU, maxV] = NUIT_TEXTURE_FACES[face];
  const x = -100 + (200 * (u - minU)) / (maxU - minU);
  const z = -100 + (200 * (v - minV)) / (maxV - minV);
  return new Vector3(x, -100, z).applyMatrix4(NUIT_FACE_MATRIX[face]);
}

/**
 * Rotation.java mapping: identity.rotateLocalX(x).rotateLocalY(y).rotateLocalZ(z).
 * JOML's rotateLocal pre-multiplies (q ← Q·q), which is three's premultiply().
 */
function nuitMapping(x: number, y: number, z: number): Quaternion {
  return new Quaternion()
    .premultiply(new Quaternion().setFromAxisAngle(X_AXIS, x * DEG))
    .premultiply(new Quaternion().setFromAxisAngle(Y_AXIS, y * DEG))
    .premultiply(new Quaternion().setFromAxisAngle(Z_AXIS, z * DEG));
}

// --- Our side: what scene.ts will build (PLAN §6) ---------------------------------

function ourFacePoint(name: FaceName, s: number, t: number): Vector3 {
  const f = FACES.find((x) => x.name === name)!;
  return new Vector3(...f.centre)
    .addScaledVector(new Vector3(...f.right), s)
    .addScaledVector(new Vector3(...f.up), t);
}

/** heroGroup's rotation: Euler(sx·X, sy·Y, 0, 'ZYX'), the matrix Rz·Ry·Rx (rule 4). */
function heroGroupMatrix(json: Sky3Json): Matrix4 {
  const [x, y] = json.properties.rotation.mapping['0'];
  return new Matrix4().makeRotationFromEuler(new Euler(SIGN_MAPPING_X * x * DEG, SIGN_MAPPING_Y * y * DEG, 0, 'ZYX'));
}

const elevationDeg = (v: Vector3): number => Math.asin(v.y / v.length()) / DEG;
/** Clockwise from north (−z), so east is +90. */
const bearingDeg = (v: Vector3): number => Math.atan2(v.x, -v.z) / DEG;

function expectVecClose(actual: Vector3, expected: Vector3, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

// --- Tests -------------------------------------------------------------------------

describe('face table vs Nuit (BRIEF §3, PLAN §1.4)', () => {
  it('lists each face once', () => {
    expect(FACES.map((f) => f.name).sort()).toEqual(['bottom', 'east', 'north', 'south', 'top', 'west']);
  });

  for (const face of FACES) {
    it(`${face.name}: cell matches TEXTURE_FACES`, () => {
      expect(NUIT_TEXTURE_FACES[face.name]).toEqual([face.col / 3, face.row / 2, (face.col + 1) / 3, (face.row + 1) / 2]);
    });

    it(`${face.name}: every point lands where Nuit draws it`, () => {
      const [minU, minV, maxU, maxV] = NUIT_TEXTURE_FACES[face.name];
      for (const nu of [0, 0.25, 0.5, 1]) {
        for (const nv of [0, 0.5, 0.75, 1]) {
          // Within a cell, s runs −1 → 1 left to right and t runs +1 → −1 top to bottom (V = 0 is the top).
          const s = 2 * nu - 1;
          const t = 1 - 2 * nv;
          const nuit = nuitVertex(face.name, minU + nu * (maxU - minU), minV + nv * (maxV - minV));
          expectVecClose(nuit, ourFacePoint(face.name, s, t).multiplyScalar(100), 6);
        }
      }
    });

    it(`${face.name}: right × up = −centre, so the front side faces the camera`, () => {
      const n = new Vector3().crossVectors(new Vector3(...face.right), new Vector3(...face.up));
      expectVecClose(n, new Vector3(...face.centre).negate());
    });
  }
});

describe('mapping rotation order (rule 4, PLAN §1.2)', () => {
  it("Euler 'ZYX' equals Nuit's rotateLocalX → Y → Z", () => {
    for (const [x, y, z] of [[22.47, 0, 0], [30, -45, 0], [-12.5, 170, 33], [89, 91, -60]]) {
      const ours = new Matrix4().makeRotationFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'ZYX'));
      const nuit = new Matrix4().makeRotationFromQuaternion(nuitMapping(x, y, z));
      ours.elements.forEach((e, i) => expect(e).toBeCloseTo(nuit.elements[i], 12));
    }
  });

  it("the default 'XYZ' order would be wrong", () => {
    const xyz = new Matrix4().makeRotationFromEuler(new Euler(30 * DEG, -45 * DEG, 0, 'XYZ'));
    const nuit = new Matrix4().makeRotationFromQuaternion(nuitMapping(30, -45, 0));
    const maxDiff = Math.max(...xyz.elements.map((e, i) => Math.abs(e - nuit.elements[i])));
    expect(maxDiff).toBeGreaterThan(0.1);
  });
});

describe('hero placement (BRIEF §9, M3 check)', () => {
  const case3 = buildSky3(params(cases[2]));
  const rect = uvRangeToFaceRect(case3.animatableTextures[0].uvRange);

  it('case 3: centre at +22.47°, bottom edge at −10°, due north', () => {
    const m = heroGroupMatrix(case3);
    const centre = new Vector3(0, (rect.t0 + rect.t1) / 2, -1).applyMatrix4(m);
    const bottom = new Vector3(0, rect.t0, -1).applyMatrix4(m);
    expect(Math.abs(elevationDeg(centre) - 22.47)).toBeLessThan(0.01);
    expect(Math.abs(elevationDeg(bottom) - -10)).toBeLessThan(0.01);
    expect(bearingDeg(centre)).toBeCloseTo(0, 9);
  });

  it("every corner matches Nuit's own geometry, with a non-zero mapping Y", () => {
    const json = buildSky3(params(cases[2], { mappingYDeg: 30 }));
    const uv = json.animatableTextures[0].uvRange;
    const [x, y, z] = json.properties.rotation.mapping['0'];
    const nuitMatrix = new Matrix4().makeRotationFromQuaternion(nuitMapping(x, y, z));
    const ours = heroGroupMatrix(json);
    const r = uvRangeToFaceRect(uv);
    const corners: [number, number, number, number][] = [
      [uv.minU, uv.minV, r.s0, r.t1], // top-left
      [uv.maxU, uv.minV, r.s1, r.t1], // top-right
      [uv.minU, uv.maxV, r.s0, r.t0], // bottom-left
      [uv.maxU, uv.maxV, r.s1, r.t0], // bottom-right
    ];
    for (const [u, v, s, t] of corners) {
      const nuit = nuitVertex('north', u, v).applyMatrix4(nuitMatrix).divideScalar(100);
      expectVecClose(new Vector3(s, t, -1).applyMatrix4(ours), nuit);
    }
  });

  it('+Y turns the hero toward west (pending in-game check A)', () => {
    const json = buildSky3(params(cases[2], { mappingYDeg: 30 }));
    const centre = new Vector3(0, 0, -1).applyMatrix4(heroGroupMatrix(json));
    expect(bearingDeg(centre)).toBeCloseTo(-30, 9);
  });

  it('the daily spin puts a mapping-Y-0 hero due south at midnight (BRIEF §4.7)', () => {
    const spin = new Matrix4().makeRotationY(sunAngleDeg(18000) * DEG);
    const world = new Vector3(0, 0, -1).applyMatrix4(heroGroupMatrix(case3)).applyMatrix4(spin);
    expect(Math.abs(bearingDeg(world))).toBeCloseTo(180, 6);
  });
});
