// The sky cube as scene.ts builds it, seen through the camera as view.ts points it (BRIEF §14 M2).
// The face table itself is checked against Nuit in faces.test.ts; this checks that the meshes and
// camera use it correctly. Only the texture on each plane is left to the visual check.

import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FACES } from '../src/constants.ts';
import { buildSky3 } from '../src/json.ts';
import { directionToPanorama, heroPieces } from '../src/math.ts';
import { facePlacement, heroGeometry, heroMappingEuler, layerDrawSettings, skyTurnRotationY } from '../src/scene.ts';
import type { FaceName, Vec3 } from '../src/schema.ts';
import { newTab, previewLayers } from '../src/tabs.ts';
import { applyCameraView } from '../src/view.ts';
import { cases, params } from './vectors.ts';

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

describe('BRIEF §14 M3 check, geometrically', () => {
  // Case 3, time 6000 (θ = 0), camera at bearing 0 and pitch 22.47°.
  const json = buildSky3(params(cases[2]));
  const geometry = heroGeometry(heroPieces(json.animatableTextures[0].uvRange));
  const mapping = new Matrix4().makeRotationFromEuler(heroMappingEuler(json.properties.rotation.mapping['0']));
  const camera = new PerspectiveCamera(70, 16 / 9, 0.01, 10);
  applyCameraView(camera, 0, 22.47, 70);

  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  // heroGeometry writes bottom-left, bottom-right, top-right, top-left.
  const corner = (i: number) => {
    const p = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mapping);
    const s = p.clone().project(camera);
    return { world: p, x: s.x, y: s.y, u: uv.getX(i), v: uv.getY(i) };
  };
  const [bl, br, tr, tl] = [0, 1, 2, 3].map(corner);
  const close = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-6); // 32-bit geometry

  it('is an upright rectangle centred on screen', () => {
    close(tl.y, tr.y); // top edge level
    close(bl.y, br.y); // bottom edge level
    close(tl.x, bl.x); // left edge vertical
    close(tr.x, br.x); // right edge vertical
    close(tl.x, -tr.x); // centred left to right
    close(tl.y, -bl.y); // centred top to bottom: the camera looks straight at the tilted face
  });

  it('shows the image upright: TOP at the top, L on the left', () => {
    // Three.js v = 1 is the top of the (flipped) image, so the top-left corner shows the image's top-left.
    expect([tl.u, tl.v]).toEqual([0, 1]);
    expect([br.u, br.v]).toEqual([1, 0]);
    expect(tl.y).toBeGreaterThan(bl.y);
    expect(tl.x).toBeLessThan(tr.x);
  });

  it('has its bottom edge 10° below the horizon', () => {
    const mid = bl.world.clone().add(br.world).multiplyScalar(0.5);
    const elevation = (Math.asin(mid.y / mid.length()) * 180) / Math.PI;
    expect(Math.abs(elevation - -10)).toBeLessThan(0.01);
  });
});

describe('panorama heading preview (PLAN §13.7)', () => {
  it('turning the sky by Δ shows what converting with left edge λ0 + Δ gives', () => {
    // A viewer looking along w sees the turned atlas at R⁻¹·w, which samples the panorama there with λ0.
    const W = 800;
    const H = 400;
    for (const delta of [45, -30, 170]) {
      const inverse = new Matrix4().makeRotationY(skyTurnRotationY(delta)).invert();
      for (const w of [[0, 0, -1], [0.4, 0.3, -1], [-1, -0.5, 0.2], [0.1, 0.9, 0.3]] as Vec3[]) {
        const local = new Vector3(...w).applyMatrix4(inverse).toArray() as Vec3;
        const previewed = directionToPanorama(local, W, H, -135);
        const converted = directionToPanorama(w, W, H, -135 + delta);
        expect((((previewed.x - converted.x) % W) + W + W / 2) % W - W / 2).toBeCloseTo(0, 9);
        expect(previewed.y).toBeCloseTo(converted.y, 9);
      }
    }
  });

  it('a positive turn moves the sky clockwise, like a bearing', () => {
    const north = new Vector3(0, 0, -1).applyMatrix4(new Matrix4().makeRotationY(skyTurnRotationY(90)));
    expect(north.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-12); // north turns to east
  });
});

describe('sky layers (PLAN §17.5)', () => {
  it('the base is opaque and drawn first; each layer over it is transparent, in order, at its alpha', () => {
    expect(layerDrawSettings(0, 1)).toEqual({ renderOrder: 0, transparent: false, opacity: 1, visible: true });
    expect(layerDrawSettings(1, 0.25)).toEqual({ renderOrder: 1, transparent: true, opacity: 0.25, visible: true });
    expect(layerDrawSettings(2, 1).renderOrder).toBe(2);
  });

  it('a layer at alpha 0 is hidden, as Nuit skips it', () => {
    expect(layerDrawSettings(1, 0).visible).toBe(false);
  });

  it('drawn the way Three.js orders and blends them, the starter\'s tabs give α·Day + (1 − α)·Night', () => {
    // One grey level per sky: night 0.2, day 0.9, opaque textures. Three.js draws opaque meshes first, then
    // transparent ones by renderOrder, each with NormalBlending: C ← α·S + (1 − α)·C.
    const night = newTab('n', 'Night');
    const day = { ...newTab('d', 'Day'), keyFrames: [
      { tick: 4000, alpha: 1 }, { tick: 8000, alpha: 1 }, { tick: 16000, alpha: 0 }, { tick: 20000, alpha: 0 },
    ] };
    const colour: Record<string, number> = { n: 0.2, d: 0.9 };
    const draw = (ticks: number): number => {
      const meshes = previewLayers([night, day], 'blend', 'd', ticks)
        .map((layer, index) => ({ ...layer, ...layerDrawSettings(index, layer.alpha) }))
        .filter((m) => m.visible)
        .sort((a, b) => Number(a.transparent) - Number(b.transparent) || a.renderOrder - b.renderOrder);
      let c = 0; // the cleared screen
      for (const m of meshes) c = m.transparent ? m.opacity * colour[m.tabId] + (1 - m.opacity) * c : colour[m.tabId];
      return c;
    };
    for (const [ticks, alpha] of [[0, 0.5], [6000, 1], [12000, 0.5], [18000, 0]]) {
      expect(draw(ticks)).toBeCloseTo(alpha * 0.9 + (1 - alpha) * 0.2, 12);
    }
  });
});
