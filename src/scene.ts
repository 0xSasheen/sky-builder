// Three.js preview (BRIEF §9, PLAN §6): the sky cube, the hero, the spin group and the overlay.
// The hero is built only from the JSON object (rule 3), the same values Nuit reads.

import {
  BoxGeometry, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, ColorManagement, DoubleSide, EdgesGeometry, Euler,
  Float32BufferAttribute, Group, Line, LinearFilter, LinearSRGBColorSpace, LineBasicMaterial, LineLoop, LineSegments,
  Matrix4, Mesh, MeshBasicMaterial, NearestFilter, NoColorSpace, PerspectiveCamera, PlaneGeometry, Scene, Sprite,
  SpriteMaterial, Texture, Vector3, WebGLRenderer,
} from 'three';
import { FACES, SIGN_MAPPING_X, SIGN_MAPPING_Y } from './constants.ts';
import { heroPieces } from './math.ts';
import type { FaceDef, FaceName, HeroPiece, Sky3Json, Vec3, ViewState } from './schema.ts';
import { applyCameraView } from './view.ts';

const DEG = Math.PI / 180;

/** Draw order: sky first, then the hero, then the overlay on top. */
const ORDER_SKY = 0;
const ORDER_HERO = 10;
const ORDER_OVERLAY = 20;

/** Overlay colours: magenta moves with the sky (it comes from the face table), cyan is fixed to the world. */
const SKY_OVERLAY_COLOR = '#ff4dff';
const WORLD_OVERLAY_COLOR = '#2ee6ff';

/** Shown on the faces until an atlas loads. */
const EMPTY_FACE_COLOR = '#202024';

/**
 * Places a PlaneGeometry(2, 2) on a cube face: local x → right, local y → up, local z → right × up.
 * right × up = −centre for every face (tests/faces.test.ts), so the plane's front side faces the camera.
 * The basis is orthonormal with determinant +1, so this is a pure rotation plus a move, with no mirroring.
 */
export function facePlacement(face: FaceDef): Matrix4 {
  const right = new Vector3(...face.right);
  const up = new Vector3(...face.up);
  const normal = new Vector3().crossVectors(right, up);
  return new Matrix4().makeBasis(right, up, normal).setPosition(...face.centre);
}

/** heroGroup's rotation for a JSON mapping [X, Y, Z]: Euler order 'ZYX' is the matrix R_z·R_y·R_x (rule 4). */
export function heroMappingEuler([x, y, z]: Vec3): Euler {
  return new Euler(SIGN_MAPPING_X * x * DEG, SIGN_MAPPING_Y * y * DEG, z * DEG, 'ZYX');
}

/**
 * One quad per piece (math.heroPieces), on its cube face, before the mapping rotation.
 * Texture coordinates use Three.js's convention (v = 1 at the top of the image), because the image
 * is flipped when it is decoded (main.ts), as flipY would do for an ordinary image.
 */
export function heroGeometry(pieces: readonly HeroPiece[]): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const { face: name, rect, tex } of pieces) {
    const face = FACES.find((f) => f.name === name)!;
    const at = (s: number, t: number): number[] =>
      [0, 1, 2].map((i) => face.centre[i] + s * face.right[i] + t * face.up[i]);
    const base = positions.length / 3;
    // Bottom-left, bottom-right, top-right, top-left: counter-clockwise seen from inside the cube.
    positions.push(...at(rect.s0, rect.t0), ...at(rect.s1, rect.t0), ...at(rect.s1, rect.t1), ...at(rect.s0, rect.t1));
    uvs.push(tex.u0, 1 - tex.v1, tex.u1, 1 - tex.v1, tex.u1, 1 - tex.v0, tex.u0, 1 - tex.v0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return new BufferGeometry()
    .setAttribute('position', new Float32BufferAttribute(positions, 3))
    .setAttribute('uv', new Float32BufferAttribute(uvs, 2))
    .setIndex(indices);
}

export class SkyScene {
  readonly camera = new PerspectiveCamera(70, 1, 0.01, 10);
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  /** Turned by the daily spin Y(θ) (BRIEF §4.5); holds everything that moves with the sky. */
  private readonly spinGroup = new Group();
  private readonly faces = new Map<FaceName, Mesh<PlaneGeometry, MeshBasicMaterial>>();
  /** Nuit's per-layer mapping M (BRIEF §4.5), applied before the spin. */
  private readonly heroGroup = new Group();
  private readonly hero = new Mesh(new BufferGeometry(), new MeshBasicMaterial({
    // Nuit's "normal" blend is SRC_ALPHA, ONE_MINUS_SRC_ALPHA on the raw texture, times (1, 1, 1, 1):
    // Three.js's NormalBlending with premultipliedAlpha false. Nuit's shader also discards alpha = 0,
    // which looks the same under this blend. Nuit turns culling off, hence DoubleSide.
    transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
  }));
  private readonly skyOverlay = new Group();
  private readonly worldOverlay = new Group();
  private renderQueued = false;

  constructor(canvas: HTMLCanvasElement) {
    // No colour conversion anywhere (PLAN §11.8): Minecraft blends raw, gamma-encoded PNG values.
    // With colour management off, a CSS colour such as '#2ee6ff' is also used as is.
    ColorManagement.enabled = false;
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    for (const face of FACES) {
      const material = new MeshBasicMaterial({ color: EMPTY_FACE_COLOR, depthWrite: false });
      const mesh = new Mesh(new PlaneGeometry(2, 2), material);
      facePlacement(face).decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.renderOrder = ORDER_SKY;
      mesh.name = `face_${face.name}`;
      this.faces.set(face.name, mesh);
      this.spinGroup.add(mesh);
    }

    this.hero.renderOrder = ORDER_HERO;
    this.hero.name = 'hero';
    this.hero.visible = false; // until there is both an image and a JSON
    this.heroGroup.add(this.hero);
    this.spinGroup.add(this.heroGroup);

    buildSkyOverlay(this.skyOverlay);
    buildWorldOverlay(this.worldOverlay);
    this.spinGroup.add(this.skyOverlay);
    this.scene.add(this.spinGroup, this.worldOverlay);
    this.setOverlayVisible(false);
  }

  /**
   * Crops each cell of the atlas onto its own canvas, so nothing bleeds between cells.
   * The caller checks the 3:2 shape first (math.atlasLayout).
   */
  setAtlas(image: CanvasImageSource, faceSize: number): void {
    const size = Math.min(faceSize, this.renderer.capabilities.maxTextureSize);
    for (const face of FACES) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = size !== faceSize; // only smooth if the GPU forces a smaller texture
      ctx.drawImage(image, face.col * faceSize, face.row * faceSize, faceSize, faceSize, 0, 0, size, size);

      // flipY (the default) puts canvas row 0 at the plane's top edge, local +y = the face's up (BRIEF §3).
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = NoColorSpace;
      texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
      // Minecraft samples a texture without .mcmeta "blur" with nearest filtering and no mipmaps (PLAN §1.6).
      texture.magFilter = texture.minFilter = NearestFilter;
      texture.generateMipmaps = false;

      const material = this.faces.get(face.name)!.material;
      material.map?.dispose();
      material.map = texture;
      material.color.set('#ffffff');
      material.needsUpdate = true; // the shader changes when a map is added
    }
    this.requestRender();
  }

  /**
   * The hero image, decoded already flipped, without premultiplied alpha and without colour conversion
   * (main.ts). WebGL can't flip or premultiply an ImageBitmap on upload, so both flags stay false.
   */
  setHeroImage(image: ImageBitmap): void {
    const texture = new Texture(image);
    texture.flipY = false;
    texture.premultiplyAlpha = false;
    texture.colorSpace = NoColorSpace;
    // hero.png.mcmeta is {"blur": true, "clamp": true}, and Minecraft applies it (BRIEF §4.8).
    texture.magFilter = texture.minFilter = LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
    texture.needsUpdate = true;

    const material = this.hero.material;
    const old = material.map;
    material.map = texture;
    material.needsUpdate = true;
    if (old) {
      old.dispose();
      (old.image as ImageBitmap).close();
    }
    this.updateHeroVisibility();
  }

  /** Builds the hero from the JSON object alone: its uvRange and its mapping (rule 3). */
  applyJson(json: Sky3Json): void {
    this.hero.geometry.dispose();
    this.hero.geometry = heroGeometry(heroPieces(json.animatableTextures[0].uvRange));
    this.heroGroup.rotation.copy(heroMappingEuler(json.properties.rotation.mapping['0']));
    this.updateHeroVisibility();
  }

  private updateHeroVisibility(): void {
    this.hero.visible = this.hero.material.map !== null && this.hero.geometry.index !== null && this.hero.geometry.index.count > 0;
    this.requestRender();
  }

  setView(view: ViewState): void {
    applyCameraView(this.camera, view.yawDeg, view.pitchDeg, view.fovDeg);
    this.requestRender();
  }

  /** The daily spin, θ(T) in degrees (BRIEF §4.7). */
  setSpinDeg(thetaDeg: number): void {
    this.spinGroup.rotation.y = thetaDeg * DEG;
    this.requestRender();
  }

  setOverlayVisible(visible: boolean): void {
    this.skyOverlay.visible = this.worldOverlay.visible = visible;
    this.requestRender();
  }

  /** Size of the canvas in CSS pixels. */
  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Draws once before the next screen refresh, however many changes arrive before then. */
  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderer.render(this.scene, this.camera);
    });
  }
}

// --- Overlay (PLAN §6) ---------------------------------------------------------------
// Drawn from the face table and from world directions, never from the texture,
// so a mismatch with the painted letters on placeholder_atlas.png shows up on screen.

function lineMaterial(color: string, opacity: number): LineBasicMaterial {
  return new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
}

/** A text label that always faces the camera. `height` is in world units at distance 1. */
function textSprite(text: string, color: string, height: number): Sprite {
  const px = 64;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `bold ${px}px system-ui, sans-serif`;
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + px / 2;
  canvas.height = Math.ceil(px * 1.4);
  ctx.font = font; // resizing the canvas resets the context
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = NoColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  sprite.renderOrder = ORDER_OVERLAY;
  return sprite;
}

/** Moves with the sky: the cube's edges, and each face's name and cell where the table puts it. */
function buildSkyOverlay(group: Group): void {
  const edges = new LineSegments(new EdgesGeometry(new BoxGeometry(2, 2, 2)), lineMaterial(SKY_OVERLAY_COLOR, 0.9));
  edges.renderOrder = ORDER_OVERLAY;
  group.add(edges);

  for (const face of FACES) {
    const label = textSprite(`${face.name} · cell ${face.col},${face.row}`, SKY_OVERLAY_COLOR, 0.07);
    // Halfway down the face (t = −0.5), clear of the painted name and horizon line.
    const at = new Vector3(...face.centre).addScaledVector(new Vector3(...face.up), -0.5);
    label.position.copy(at.multiplyScalar(0.9));
    group.add(label);
  }
}

/** World direction for a compass bearing (clockwise from north) and an elevation, both in degrees. */
function worldDir(bearingDeg: number, elevationDeg: number): Vector3 {
  const b = bearingDeg * DEG;
  const e = elevationDeg * DEG;
  return new Vector3(Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e));
}

/** Fixed to the world: the horizon, rings every 10° of elevation, the four meridians and compass letters. */
function buildWorldOverlay(group: Group): void {
  const radius = 0.8; // any radius works: the camera sits at the centre and depth testing is off
  const strong = lineMaterial(WORLD_OVERLAY_COLOR, 0.95);
  const faint = lineMaterial(WORLD_OVERLAY_COLOR, 0.35);

  for (let elevation = -80; elevation <= 80; elevation += 10) {
    const points: number[] = [];
    for (let bearing = 0; bearing < 360; bearing += 2) points.push(...worldDir(bearing, elevation).multiplyScalar(radius).toArray());
    const ring = new LineLoop(new BufferGeometry().setAttribute('position', new Float32BufferAttribute(points, 3)),
      elevation === 0 ? strong : faint);
    ring.renderOrder = ORDER_OVERLAY;
    group.add(ring);
  }

  for (const bearing of [0, 90, 180, 270]) {
    const points: number[] = [];
    for (let elevation = -90; elevation <= 90; elevation += 2) points.push(...worldDir(bearing, elevation).multiplyScalar(radius).toArray());
    const meridian = new Line(new BufferGeometry().setAttribute('position', new Float32BufferAttribute(points, 3)), faint);
    meridian.renderOrder = ORDER_OVERLAY;
    group.add(meridian);
  }

  for (const [letter, bearing] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
    const sprite = textSprite(letter, WORLD_OVERLAY_COLOR, 0.06);
    sprite.position.copy(worldDir(bearing, -4).multiplyScalar(radius));
    group.add(sprite);
  }

  // Elevation labels up the north meridian, for checks like "bottom edge 10° below the horizon" (BRIEF §14 M3).
  for (let elevation = -30; elevation <= 80; elevation += 10) {
    if (elevation === 0) continue;
    const sprite = textSprite(`${elevation > 0 ? '+' : ''}${elevation}°`, WORLD_OVERLAY_COLOR, 0.035);
    sprite.position.copy(worldDir(-2, elevation).multiplyScalar(radius));
    sprite.center.set(1, 0.5); // right-aligned, just left of the meridian
    group.add(sprite);
  }
}
