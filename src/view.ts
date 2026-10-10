// Camera look controls (BRIEF §9, PLAN §6). Only the camera turns; it stays at the origin.

import type { PerspectiveCamera } from 'three';
import type { ViewState } from './schema.ts';

const DEG = Math.PI / 180;

/**
 * Points the camera. Euler order 'YXZ' turns by yaw about the world's up axis first, then tilts by
 * pitch, so the horizon stays level. This is unrelated to rule 4, which is about Nuit's mapping.
 * Three.js yaw is counter-clockwise seen from above and the bearing is clockwise, hence the minus.
 */
export function applyCameraView(camera: PerspectiveCamera, bearingDeg: number, pitchDeg: number, fovDeg: number): void {
  camera.rotation.set(pitchDeg * DEG, -bearingDeg * DEG, 0, 'YXZ');
  camera.fov = fovDeg; // vertical in both Three.js and Minecraft
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/**
 * Drag to look, like the mouse in Minecraft: dragging right turns right, dragging up looks up.
 * One pixel turns by the vertical FOV divided by the canvas height, so the sky roughly keeps pace
 * with the pointer near the centre of the screen. The caller wraps and clamps the result.
 */
export function attachDragLook(
  el: HTMLElement,
  getView: () => Readonly<ViewState>,
  onLook: (patch: Pick<ViewState, 'yawDeg' | 'pitchDeg'>) => void,
): void {
  let last: { x: number; y: number } | null = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId); // keep receiving moves even if the pointer leaves the canvas
    last = { x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointermove', (e) => {
    if (!last) return;
    const view = getView();
    const degPerPx = view.fovDeg / el.clientHeight;
    onLook({
      yawDeg: view.yawDeg + (e.clientX - last.x) * degPerPx,
      pitchDeg: view.pitchDeg - (e.clientY - last.y) * degPerPx,
    });
    last = { x: e.clientX, y: e.clientY };
  });
  const stop = (): void => { last = null; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}
