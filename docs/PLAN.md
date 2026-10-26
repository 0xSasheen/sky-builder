# Sky Builder: implementation plan

Status: **All milestones (M1–M5), the panorama input and Assemble pack (section 16) are done, merged and live at <https://0xsasheen.github.io/sky-builder/>** (2026-10-24).
**Sky tabs with day/night blending (section 17) are built and checked on branch `sky-tabs` (2026-10-25)**, waiting for
the developer's in-game check and the merge.
Decisions are in sections 11–17.

Contents: 1. Source verification · 2. Architecture · 3. Types · 4. `math.ts` API and tests ·
5. JSON output · 6. Rendering · 7. Time spin · 8. UI · 9. Milestones ·
10. In-game checks · 11. Decisions

---

## 1. Source verification (BRIEF §4)

I fetched these from `raw.githubusercontent.com/FlashyReese/nuit/26.2/dev/`:
`docs/schema.md`, `MultiTexturedSkybox.java`, `Utils.java`, `Rotation.java`,
`Properties.java`, `Blend.java` and `SquareTexturedSkybox.java`. I also read
`TexturedSkybox.java` (where the rotation is applied), `AnimatableTexture.java`
and `UVRange.java`.

### 1.1 Summary

| BRIEF claim | Verdict | Evidence |
|---|---|---|
| §4.1 Placement by intersecting `uvRange` with each face's cell | ✅ Confirmed | `MultiTexturedSkybox.renderTextureFrame`: for each face, `findUVIntersection(TEXTURE_FACES[face], uvRange)`, then `mapUVRanges` onto a ±100 quad |
| §4.2 A range that crosses a cell boundary is split across faces | ✅ Confirmed | Same loop; each face draws only its own part |
| §4.3 Texture drawn upright, top-left at top-left | ✅ Confirmed | With a 1×1 grid the frame is `(0,0,1,1)`, and the vertex at `(minU,minV)` gets texture UV `(0,0)`, the PNG's top-left |
| §4.4 `properties.blend` is a string, default `normal`, alpha respected | ✅ Confirmed | `Blend.CODEC = Codec.STRING`; `normal` = `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` |
| §4.5 $R = Y(\text{time})\cdot M$ | ✅ Confirmed (with `axis` = 0) | See 1.2 |
| §4.6 $M = R_z R_y R_x$; Three.js `'ZYX'` gives the same matrix | ✅ Confirmed | `Rotation.java` lines 28–31; checked numerically against three r186 (see 1.2) |
| §4.7 Spin $= \text{speed}\cdot 360°\cdot T/24000$ with `skyboxRotation: false` | ❌ **Disagreed**; BRIEF §4.7 now corrected | See 1.3 |
| §3 Face table, including the bottom face | ✅ Confirmed for **all six** faces | See 1.4 |
| §5 `conditions.worlds` is an accepted legacy alias | ✅ Confirmed | schema.md: "`worlds`: Legacy compatibility alias" |
| §13 Top-level `"blend"` object in sky1/sky2 is ignored | ✅ Confirmed | `SquareTexturedSkybox.CODEC` has no top-level `blend` field, so the codec drops it; `properties.blend` falls back to `normal` |

### 1.2 Rotation order (`Rotation.java`)

The mapping quaternion is built like this:

```java
new Quaternionf()
    .rotateLocalX(x * DEG_TO_RAD)
    .rotateLocalY(y * DEG_TO_RAD)
    .rotateLocalZ(z * DEG_TO_RAD)
```

In JOML, `q.rotateLocalX(a)` **pre**-multiplies: $q \leftarrow Q_x(a)\,q$. Starting from the identity:

$$q_0 = I,\quad q_1 = Q_x,\quad q_2 = Q_y Q_x,\quad q_3 = Q_z Q_y Q_x$$

so $M = R_z R_y R_x$. Applied to a vertex, $M\mathbf v = R_z(R_y(R_x\mathbf v))$, which means X acts first, then Y, then Z.

In `apply(...)`, with one `axis` keyframe $A$ and one `mapping` keyframe $M$:

1. `mappingRot.mul(A, axisRot)` sets `axisRot` $= I\cdot A = A$. (`mappingRot` is still the identity here, so the code comment "mapping rot × axis rot" is misleading.)
2. `resultRot.mul(axisRot)` gives $A$.
3. `resultRot.mul(Y(\theta)\cdot I)` gives $A\,Y(\theta)$.
4. `resultRot.mul(axisRot.conjugate())` gives $A\,Y(\theta)\,A^{-1}$.
5. The mapping block gives $R = A\,Y(\theta)\,A^{-1}\,M$.

With `axis` = [0, 0, 0], $A = I$, so $R = Y(\theta)\,M$, as the brief says.
`TexturedSkybox.render` does `skyModelView.rotate(R)`, and the face matrix is applied per vertex,
so a vertex ends up at $R\,F\,\mathbf v$.

**A trap the tool must avoid:** the spin is applied only inside `possibleAxisKeyframes.ifPresent(...)`.
If `axis` is missing or empty, the layer **does not spin at all**, and the hero would separate from the
sky. The schema doc says the same thing ("Time-based rotation requires at least one axis entry"). The tool always writes
`axis`, and import warns if it is missing.

**Numerical check** (three r186): `makeRotationFromEuler(new Euler(x, y, z, 'ZYX'))` equals
`Rz·Ry·Rx` to 1e-12, and equals the quaternion product $q_z q_y q_x$. Applied to north, $(0,0,-1)$:

- $R_x(+22.47°)$ gives $(0,\ 0.382,\ -0.924)$: tilted **up**. This matches §12.1.
- $R_y(+30°)$ gives $(-0.5,\ 0,\ -0.866)$: turned toward **west** (−x). This matches the reading in §12.2.

JOML and Three.js are both right-handed, both use the same axes, and both treat a positive
angle as counter-clockwise when you look from the +axis toward the origin. So the
**JSON values go into the Three.js Euler unchanged**: `SIGN_MAPPING_X = +1` (closed: source and the
running config agree) and `SIGN_MAPPING_Y = +1` (pending one in-game check, section 10). Both stay
named constants, per rule 6.

### 1.3 Disagreement: the time spin (§4.7)

`Utils.calculateRotation`:

```java
if (rotationSpeed == 0.0D) return 0.0D;
if (!isSkyboxRotation) return celestialAngle;          // <- our case
double rotationFraction = timeOfDay / (24000.0D / rotationSpeed);
return 360.0D * Mth.positiveModulo(rotationFraction, 1.0D);
```

With `skyboxRotation: false`, the spin angle is **vanilla's `SUN_ANGLE` environment attribute**,
read from the camera, and `speed` is ignored apart from `0` switching the spin off. schema.md says so directly:
"When `skyboxRotation` is `false`, any nonzero `speed` follows Minecraft's angle; the value does not
multiply the angle." Only `skyboxRotation: true` gives the linear `speed · 360° · T / 24000`.

**Resolved: what `SUN_ANGLE` is in vanilla 26.2.**

- The Minecraft Wiki ([Environment attribute](https://minecraft.wiki/w/Environment_attribute)) says
  `minecraft:visual/sun_angle` is in **degrees**, and **0 is straight up**.
- Its value comes from the overworld's `day` timeline. Vanilla's built-in datapack is mirrored at
  [misode/mcmeta](https://github.com/misode/mcmeta), tag `26.2-data`. In
  `data/minecraft/timeline/day.json` (`period_ticks: 24000`, `clock: minecraft:overworld`):

  ```json
  "minecraft:visual/sun_angle": {
    "ease": { "cubic_bezier": [0.362, 0.241, 0.638, 0.759] },
    "keyframes": [ { "ticks": 6000, "value": 360 }, { "ticks": 6000, "value": 0 } ]
  }
  ```

  The two keyframes at the same tick make a jump: 360° just before 6000, 0° from 6000 on. Between one
  6000 and the next, the value runs from 0° to 360° along the eased curve. The track is identical in the
  latest snapshot (26.4-snapshot-2).

The formula, step by step:

1. Fraction of the day since noon: $p = \operatorname{frac}\!\left(\dfrac{T - 6000}{24000}\right) \in [0, 1)$.
2. The cubic Bézier has $P_0 = (0,0)$, $P_1 = (x_1, y_1) = (0.362, 0.241)$, $P_2 = (x_2, y_2) = (0.638, 0.759)$ and $P_3 = (1,1)$.
   Each coordinate is $B(a, b, s) = 3a\,s(1-s)^2 + 3b\,s^2(1-s) + s^3$ for a curve parameter $s \in [0,1]$.
3. Solve $B(x_1, x_2, s) = p$ for $s$. $B$ is monotonic in $s$ because $0 \le x_1, x_2 \le 1$, so bisection or Newton works.
4. Eased progress: $e = B(y_1, y_2, s)$.
5. $\theta(T) = 360°\cdot e$.

I read the four numbers as CSS-style ($x$ = time, $y$ = progress), which the wiki's field order
(x1, y1, x2, y2) suggests. That reading reproduces the pre-timeline vanilla formula
$\theta = 360°\cdot\frac{2f + \frac12 - \frac12\cos(\pi f)}{3}$ to within **0.056°** at every tick. So Mojang
fitted this Bézier to the old curve, which confirms the reading.

What this means for the hero, since Nuit spins with $Y(+\theta)$, which turns north toward west:

| Tick | Clock | θ (26.2 curve) | Hero bearing (mapping Y = 0) |
|---|---|---|---|
| 0 | 6 AM | 282.37° (≡ −77.63°) | ~78° **east** of north |
| 6000 | noon | 0° | due north |
| 12000 | 6 PM | 77.63° | ~78° west of north |
| 18000 | midnight | 180° | due south |

So "compass ψ" means the hero's bearing **at noon**. The time slider defaults to 6000, where θ = 0.
`math.ts` implements the Bézier exactly, with no model switch. The only assumption is the one
BRIEF §1 now states: plain Nuit and vanilla 26.x data, with no datapack overriding the `day` timeline.

### 1.4 Face table: all six faces confirmed from source

Both `SquareTexturedSkybox` (sky layers) and `MultiTexturedSkybox` (hero) draw a quad on the plane
$y = -100$, with local $x \leftrightarrow u$ and $z \leftrightarrow v$ (`minU,minV` at $(-100, -100)$). They then
apply `MATRIX4F_ROTATED_FACE[face]`. Working each matrix through on $(x, -100, z)$:

| Face | Nuit matrix | World point | Right ($+u$) | Up ($-v$) | Table |
|---|---|---|---|---|---|
| bottom | $I$ | $(x,\,-100,\,z)$ | $+x$ | $-z$ | ✅ |
| north | $R_x(90°)$ | $(x,\,-z,\,-100)$ | $+x$ | $+y$ | ✅ |
| south | $R_x(-90°)R_y(180°)$ | $(-x,\,-z,\,100)$ | $-x$ | $+y$ | ✅ |
| top | $R_x(180°)$ | $(x,\,100,\,-z)$ | $+x$ | $+z$ | ✅ |
| east | $R_z(90°)R_y(-90°)$ | $(100,\,-z,\,x)$ | $+z$ | $+y$ | ✅ |
| west | $R_z(-90°)R_y(90°)$ | $(-100,\,-z,\,-x)$ | $-z$ | $+y$ | ✅ |

`TEXTURE_FACES` puts the cells at bottom (0,0), top (1,0), south (2,0), west (0,1), north (1,1) and east (2,1). ✅

**The bottom face is now confirmed from source**, and §12.4 is closed. M1 adds a unit test that ports Nuit's six
matrices and checks them against our face table, so this stays checked automatically.

North-face inverse (§6.3): $v \in [\tfrac12, 1]$ maps linearly to quad $z \in [-100, 100]$, which maps to
world $y = -z$. So $v = \tfrac12$ is $t = +1$, and $t = 1 - 4(v - \tfrac12)$. ✅

### 1.5 Smaller notes

- `UVRange` values are clamped to [0, 1] when parsed.
- `findUVIntersection` uses `>=`, so a hero whose edge lies exactly on a cell boundary emits a
  zero-area quad in the neighbouring face. That is harmless, but it is one more reason to warn at 0.95.
- `Properties.of()` defaults `sunSkyTint` to `true`. We write `false` explicitly, as the pack does.
- Test vectors: all 7 reproduce exactly, and the scaling chain from case 1 reproduces the `k` values of cases 2–4
  to 6 dp. **Case 4 is a rounding hazard.** From `k`, X = 34.695014, which rounds to 34.70. From the rounded
  `heightDeg` (79.39), X = 34.695 exactly, a tie that floating-point error can push either way.
  So **tests for cases 2–4 drive from `k`**, and only cases 1 and 5 also test the β path.
- The brief's §5 example is byte-identical to `reference/pack-example/.../sky3_image.json`.
  That file ends with a single trailing `\n`, and the serialiser will match it.
  `.gitattributes` forces LF on checkout, so Git for Windows (`core.autocrlf=true`) can't break that test.

### 1.6 Texture sampling (checked 2026-10-10, for M2)

`NuitRenderBackend.drawTextured` binds `abstractTexture.getSampler()`, the texture's own sampler from
Minecraft's `TextureManager`. `SkyboxManager.registerTextures` loads every Nuit texture as a vanilla
`SimpleTexture` (`registerAndLoad(id, new SimpleTexture(id))`). So filtering follows vanilla's `.mcmeta` rules:
a texture without `"blur": true` is sampled with **nearest** filtering and no mipmaps. Vanilla 26.2 uses the
same mechanism for its own non-atlas textures (`textures/misc/vignette.png.mcmeta` and
`enchanted_glint_item.png.mcmeta` are `{"texture": {"blur": true}}`, from misode/mcmeta `26.2-assets`).

- **Sky atlases** have no `.mcmeta`, so the preview uses `NearestFilter` with no mipmaps, like the game.
- **The hero** is loaded the same way, so `hero.png.mcmeta` (`blur: true`) **is applied**, and M3 uses linear
  filtering. This answers BRIEF §12.5 from source; check B in section 10 becomes an optional confirmation.
- Minecraft decodes PNGs with stb_image, which ignores colour-profile chunks (`iCCP`, `gAMA`). The preview decodes with
  `createImageBitmap(file, { colorSpaceConversion: 'none' })` to match. Nothing leaves the browser.

---

## 2. Architecture

The suggested layout from BRIEF §11 is kept, plus one module (`spin` lives in `math.ts`; `view.ts` is new).

```
src/
  constants.ts   SIGN_MAPPING_X/Y, SUN_ANGLE_BEZIER, FACES (the §3 face table), defaults, slider ranges, limits, fixed JSON values
  math.ts        pure functions: §6 forward and inverse, rounding, readouts, constraints, spin, fade
  schema.ts      TypeScript types for sky3_image.json and the tool state (types only, no code)
  json.ts        buildSky3(state) -> Sky3Json; serializeSky3 (exact §5 bytes); parseSky3 (import)
  scene.ts       Three.js: sky planes, hero quad, heroGroup, spinGroup, camera, overlay
  view.ts        drag-to-look + "look at hero" / "look north" (camera yaw/pitch only)
  ui.ts          controls, readouts, warnings, file loading, JSON panel, import/export
  tabs.ts        the sky tabs (section 17): pure, like math.ts
  pack.ts        reading templates and assembling packs (section 16)
  saved.ts       what is remembered between visits (sections 15, 17.9)
  main.ts        creates state, wires ui -> state -> json -> scene, owns the render loop
tests/
  math.test.ts   test vectors §7, scaling, inverse, round trip, spin, constraints
  json.test.ts   byte-for-byte §5 for case 3, import/parse cases
  faces.test.ts  Nuit face matrices vs our face table; hero placement (uses three, not the DOM)
  view.test.ts   scene.ts's face meshes and view.ts's camera: the M2 and M3 checks, done geometrically
  panorama.test.ts  panorama → atlas against sky_convert.py's convention and its own output (section 13)
  tabs.test.ts   the sky tabs, layer plan, layer files and preview layers (section 17)
  pack.test.ts, saved.test.ts   templates and packs; the saved session and the v1 migration
  png.ts         a small PNG reader for the test fixtures
```

`src/convert.worker.ts` (section 13) runs `math.panoramaToAtlas` off the main thread.

Module dependencies (arrows mean "imports"):

```
constants <- math <- json <- main -> ui
              ^        ^       |
            schema ----+       +--> scene -> view
```

`math.ts` imports only `constants.ts` and `schema.ts` (types). Neither imports three or the DOM, as rule 2 requires.

### Data flow (rule 3)

```
 slider / number box / file
          │  ui.ts emits a typed patch
          ▼
   state.hero (HeroParams)  ──►  math.solveHero  ──►  rounded uv + mapping
                                                    │
                                     json.buildSky3 ▼
                                   Sky3Json  (single source of truth)
                     ┌──────────────────┬──────────┴──────────────┐
                     ▼                  ▼                         ▼
          serializeSky3 → JSON panel   math.analyse(json, aspect)   scene.applyJson(json)
                                       → readouts + warnings        uvRangeToFaceRect → hero quad
                                                                    mapping → heroGroup Euler
   state.view (time, fov, yaw, pitch) ──► scene.setView / scene.setSpin(math.sunAngleDeg(T))
```

- The scene **never** sees `HeroParams`. It gets only `Sky3Json`, the rounded values Nuit reads.
- Readouts are also computed **from the rounded JSON**, so they describe what the game will show.
- **Import pins the JSON.** An imported file becomes the current `Sky3Json` exactly as loaded,
  normalised to the fixed fields. The sliders show the recovered values (§6.3). The JSON is
  regenerated only when a slider changes. This makes export → import → export byte-identical by
  construction, even where re-deriving U from recovered $k$ could flip a last digit
  (recovering $k$ from rounded V can be off by up to $2\times10^{-4}$).

TypeScript note: a "module" here is a file whose exported functions behave like a Java class with
only `static` methods; `import { solveHero } from './math'` is like `import static ...math.solveHero`.

---

## 3. Types (`schema.ts`)

```ts
export type Vec3 = [number, number, number];          // a fixed-length tuple, like a float[3]
export type TickMap<T> = Record<string, T>;           // like Map<String, T>; keys are tick numbers
export type BlendMode = 'normal' | 'alpha' | 'add' | 'subtract' | 'multiply'
                      | 'screen' | 'burn' | 'dodge' | 'replace' | 'disable';

export interface UvRange { minU: number; minV: number; maxU: number; maxV: number; }

export interface AnimatableTexture {
  texture: string;            // "sasheen:textures/sky/hero.png"
  uvRange: UvRange;
  gridColumns: 1;             // literal type: only the value 1 is allowed
  gridRows: 1;
}

export interface Sky3Json {
  schemaVersion: 1;
  type: 'nuit:multi-textured';
  properties: {
    layer: number;
    blend: BlendMode;          // always 'normal' in v1 (fixed)
    fade: { duration: 24000; keyFrames: TickMap<number> };
    rotation: {
      speed: number;           // fixed 1.0
      mapping: TickMap<Vec3>;  // exactly {"0": [X, Y, 0]}
      axis: TickMap<Vec3>;     // fixed {"0": [0, 0, 0]}
      skyboxRotation: boolean; // fixed false
    };
    sunSkyTint: boolean;       // fixed false
    visibleUnderwater: boolean;// fixed true
  };
  conditions: { worlds: { entries: string[] } };
  animatableTextures: [AnimatableTexture];  // tuple of exactly one
}
```

TypeScript `interface` is structural: any object with these fields fits, with no `implements`
needed. It is closer to a Java `record`'s shape than to a Java interface. String-literal unions like
`'tilted' | 'wall'` work like a Java `enum` without methods.

Tool state:

```ts
export type HeroMode = 'tilted' | 'wall';

export interface HeroParams {          // what the sliders edit
  mode: HeroMode;
  imageW: number; imageH: number;      // auto-read, overridable
  k: number;                           // canonical size: half-height on the face (β is derived)
  bottomDeg: number;                   // b
  wallTopT: number;                    // t_t, wall mode only (default 0.95)
  mappingYDeg: number;                 // ψ = raw mapping Y; positive = toward west
  texture: string;
  layer: number;
}

export interface ViewState {           // preview only; never reaches the JSON
  timeTicks: number; playing: boolean;
  fovDeg: number; yawDeg: number; pitchDeg: number;
  showOverlay: boolean;
}

export interface AppState {
  hero: HeroParams;
  view: ViewState;
  json: Sky3Json;                      // current output (pinned after import)
  pinned: boolean;                     // true until the first slider change after import
}

export interface FaceRect { s0: number; s1: number; t0: number; t1: number; }  // on the North face

export interface Readouts {
  rect: FaceRect;
  aspect: number; k: number; ak: number;   // k = (t1 − t0)/2, ak = (s1 − s0)/2
  heightDeg: number; widthDeg: number; topDeg: number; bottomDeg: number;
  margins: { k: number; ak: number; zenithDeg: number };   // distance to each limit
  warnings: Warning[];
}
export type Warning = {
  code: 'k' | 'ak' | 'zenith' | 'outsideCell' | 'notCentred';
  level: 'warn' | 'error';                 // amber past 0.95; red outside the cell or over the zenith
  message: string;
};
```

$k$ is stored instead of β because the scale buttons multiply $k$ (§6.1), and repeated ×/÷ then
stays exact. The β slider writes $k = \tan(\beta/2)$.

---

## 4. `math.ts` API and test mapping

All angles in the API are in **degrees**. Conversion to radians happens inside each function.

| Function | Returns | Formula |
|---|---|---|
| `kFromHeight(betaDeg)` | $k$ | $\tan(\beta/2)$ |
| `heightFromK(k)` | β | $2\arctan k$ |
| `scaleK(k, f)` | $k'$ | $f k$ |
| `faceToNorthUv(s, t)` | `{u, v}` | $u = \tfrac13 + \tfrac{s+1}{6}$, $v = \tfrac12 + \tfrac{1-t}{4}$ |
| `northUvToFace(u, v)` | `{s, t}` | $s = 6(u - \tfrac13) - 1$, $t = 1 - 4(v - \tfrac12)$ |
| `uvRangeToFaceRect(uv)` | `{s0, s1, t0, t1}` | inverse applied to the corners; $t_1$ (top) comes from minV |
| `tiltedUv(aspect, k)` | `UvRange` (unrounded) | §6.1 step 4 |
| `tiltedMappingX(k, bottomDeg)` | X (unrounded) | $b + \arctan k$, which is $b + \beta/2$ |
| `wallUv(aspect, bottomDeg, topT)` | `UvRange` (unrounded) | §6.2 |
| `roundTo(x, dp)` | number | `Math.round(x·10^dp)/10^dp`, plus `+0` to turn −0 into 0 |
| `roundUv(uv)` | `UvRange` | 4 dp each |
| `solveHero(p: HeroParams)` | `{ uv, mapping: Vec3 }`, **rounded** | dispatches on mode; mapping $= [\text{round}_2 X,\ \text{round}_2 Y,\ 0]$ |
| `analyse(uv, mappingX, aspect?)` | `Readouts` | inverse (§6.3) on the rounded uv; if `aspect` is omitted, uses `aspectFromUv(uv)`. Height $= \arctan t_1 - \arctan t_0$; top/bottom $= X + \arctan t_{1,0}$; width $= 2\arctan\!\big(ak/\sqrt{1+t_c^2}\big)$ with $t_c = (t_0+t_1)/2$. In tilted mode these reduce to BRIEF §6.1 step 7 |
| `checkConstraints(r)` | `Warning[]` | on the face rect: $\max\lvert t\rvert \le 0.95$ (`k`), $\max\lvert s\rvert \le 0.95$ (`ak`), $\le 1$ (`outsideCell`), top $< 90°$ (`zenith`), centred in $s$ (`notCentred`). In tilted mode the first two are exactly $k \le 0.95$, $ak \le 0.95$. A value exactly on 0.95 (wall mode's default $t_t$) is allowed |
| `classifyUv(uv, mappingX)` | `'tilted' \| 'wall' \| 'custom'` | tilted if centred in $s$ and $t$; wall if centred in $s$ and X = 0 |
| `recoverParams(uv, mapping)` | `Partial<HeroParams>` | tilted: $k = 2(\text{maxV} - \text{minV})$, $b = X - \beta/2$; wall: $t_t$, $b = \arctan t_b$ |
| `aspectFromUv(uv)` | $a$ | $ak = 3(\text{maxU} - \text{minU})$ and $k = 2(\text{maxV} - \text{minV})$, so $a = \dfrac{3(\text{maxU} - \text{minU})}{2(\text{maxV} - \text{minV})}$ |
| `ticksToClock(T)` | `{h, m}` | $(6 + T/1000) \bmod 24$ |
| `cubicBezier(x1, y1, x2, y2, p)` | eased progress | §1.3 steps 2–4 (bisection on $x(s) = p$, 50 iterations) |
| `sunAngleDeg(T)` | θ | $360°\cdot\text{cubicBezier}(\ldots\text{SUN\_ANGLE\_BEZIER}, \operatorname{frac}((T-6000)/24000))$ |
| `noonBearingDeg(mappingY)` | compass bearing, clockwise from north | $-Y$ wrapped to (−180, 180], for the "faces N 30° W at noon" readout |
| `fadeAlpha(keyFrames, T, duration)` | α | port of Nuit's `findClosestKeyframes` + `calculateInterpolatedAlpha`. **Deferred to the crossfade stretch goal** (not in M1) |
| `clamp(x, lo, hi)`, `clampPitch(p)` | number | pitch limited to ±`PITCH_LIMIT_DEG` (89°). Added in M2 |
| `mcYawPitch(bearing, pitch)` | F3 `{yaw, pitch}` | yaw $= \text{wrap}(\varphi - 180°)$ (Minecraft: 0 = south, 90 = west); pitch $= -p$ (Minecraft: positive looks down). Added in M2 |
| `mcFacing(bearing)` | `'north' \| …` | nearest of four, like F3's "Facing". Added in M2 |
| `atlasLayout(W, H)` | face size, or an error message | requires $2W = 3H$. Added in M2 |
| `clampHero(p)` | `HeroParams` | k within `K_RANGE`, b, $t_t$ and ψ within their sliders, whole-pixel sizes, integer layer. Added in M3 |
| `heroPieces(uv)` | `HeroPiece[]` | Nuit's face loop: clamp to [0, 1], then per face the overlap with its cell, as a face rect plus the image fraction it shows. Added in M3 |
| `applyMapping(v, mapping)` | `Vec3` | $R_z R_y R_x \mathbf v$ with the sign constants. Added in M3 |
| `atlasPointToCube(u, v)` | `Vec3` | $\mathbf c + s\mathbf r + t\mathbf u$ on the face whose cell holds $(u, v)$. Added in M3 |
| `heroCentreDirection(uv, mapping, θ)` | `Vec3` | $Y(\theta)\,M\,\mathbf p$ for the middle of the range, for "Look at hero". Added in M3 |
| `viewToward(d)` | `{yawDeg, pitchDeg}` | bearing $\operatorname{atan2}(d_x, -d_z)$, pitch $\operatorname{atan2}(d_y, \sqrt{d_x^2 + d_z^2})$, clamped. Added in M3 |
| `quadrantBearing(b)` | `{from, deg, to}` | −30 → N 30° W, 150 → S 30° E, for the noon readout. Added in M3 |
| `skyKindFromSize(W, H)` | `'atlas' \| 'panorama' \| null` | 3:2 or 2:1, for the Auto sky type. Section 13 |
| `panoramaLayout(W, H)` | default face size, or an error message | requires $W = 2H$; $F = \operatorname{round}(W/4)$ within `PANO_FACE_RANGE`. Section 13 |
| `directionToPanorama(d, W, H, λ0?)` | `{x, y}` | section 13.2 steps 3–4 |
| `panoramaToAtlas(pano, F, λ0?, onFace?)` | `RgbaImage` | section 13.2; a port of `sky_convert.py`'s `pano_to_atlas` |
| `advanceTicks(T, Δt, r)` | ticks | $(T + r\,\Delta t) \bmod 24000$, for Play. Section 14.1 |
| `importAspectMismatch(W, H, uv)` | `{image, json}` or null | the image's $W/H$ against `aspectFromUv(uv)`, when they differ by more than 1 %. Section 14.3 |

The `aspectFromUv` derivation, step by step:
the hero spans $s \in [-ak, ak]$, so its width in $s$ is $2ak$. Since $s = 6(u - \tfrac13) - 1$,
$\Delta s = 6\,\Delta u$, so $2ak = 6(\text{maxU} - \text{minU})$ and $ak = 3(\text{maxU} - \text{minU})$.
Likewise $\Delta t = 4\,\Delta v$, so $2k = 4(\text{maxV} - \text{minV})$ and $k = 2(\text{maxV} - \text{minV})$.
Dividing gives $a = \dfrac{3(\text{maxU} - \text{minU})}{2(\text{maxV} - \text{minV})}$.
This lets import work before a hero image is loaded.

### Tests (`tests/math.test.ts`, driven by `reference/test-vectors.json`)

| Case | Test |
|---|---|
| 1, 5 (tilted, β given) | `solveHero({k: kFromHeight(heightDeg), …})`: uv `toBe` exactly expected (after 4 dp rounding); `mapping[0]` `toBe` expected X. Also `kFromHeight(heightDeg)` ≈ file `k` to 1e-6 |
| 2, 3, 4 (tilted, k given) | Same, driven from the file's `k`. Case 3 is additionally `it('matches the running in-game config')` |
| 1–5 readouts | `analyse` on the **unrounded** solution: `widthDeg` and `topDeg` equal expected to 1 dp |
| 6, 7 (wall) | `solveHero({mode:'wall', bottomDeg:3, wallTopT:0.95})`: uv exact, X = 0; derived height $\arctan t_t - b$ equals 40.5 to 1 dp |
| Scaling chain | `scaleK(k1, 1.5)` → case 2 k; `scaleK(…, 1.15)` → case 3 k; `scaleK(…, 1.5)` → case 4 k, each to 1e-6 |
| Inverse | `northUvToFace(faceToNorthUv(s, t))` is the identity on a grid; `uvRangeToFaceRect` of each expected uv gives $t_0 < t_1$ and centred $s$ |
| Recover | `recoverParams(case uv, X)` → `solveHero` → same rounded uv and X, for all 7 cases |
| Aspect | `aspectFromUv(case 3 uv)` ≈ 1063/1502 to 1e-3 |
| Constraints | k = 0.96 → `'k'` warning; case 4 → none; β = 87°, b = 10° → `'zenith'` |
| Spin | θ(6000) = 0, θ(18000) = 180 (the curve is symmetric), θ(12000) = 77.63 ± 0.01, θ(0) = 282.37 ± 0.01; and across all T in steps of 10 ticks, within 0.06° of the pre-timeline formula (an independent check that the Bézier reading is right) |
| Bearing | `noonBearingDeg(30)` = −30 (N 30° W); `noonBearingDeg(-180)` = 180 |
| Clock | 0 → 06:00, 6000 → 12:00, 12000 → 18:00, 18000 → 00:00 |

`tests/json.test.ts`: `serializeSky3(buildSky3(case 3 state))` `===` the file contents of
`reference/pack-example/assets/nuit/sky/sky3_image.json`, byte for byte. Plus import tests:
round trip, a missing `axis` gives a warning, a top-level `blend` gives a warning, and a uv outside the north cell gives an error.

`tests/faces.test.ts` imports `three` (allowed in tests, not in `math.ts`):
1. Port Nuit's `MATRIX4F_ROTATED_FACE`. For each face and each corner, transform $(x, -100, z)$ and
   compare with $100\,(\mathbf c + s\,\mathbf r + t\,\mathbf u)$ from our table.
2. Build the heroGroup transform for case 3 (`Euler(X, 0, 0, 'ZYX')`). The bottom-centre point
   $(0, t_0, -1)$ must end up at elevation −10.00° ± 0.01°, and the centre at +22.47°.

---

## 5. JSON output (`json.ts`)

`JSON.stringify` cannot produce §5. It prints `1.0` as `1`, and it uses a single indentation style,
while §5 mixes inline objects with multi-line ones. So `serializeSky3` is a **fixed template**
that fills in the editable fields:

- `fmtFloat(x)` prints the shortest round-trip form of the already-rounded number, appending `.0` when it is an
  integer: `22.47` → `22.47`, `30` → `30.0`, `0` → `0.0`, `0.5` → `0.5`. Used for `speed`, `mapping`, `axis`
  and `uvRange`.
- Integers (`schemaVersion`, `layer`, `duration`, `gridColumns/Rows`) print as integers.
- Strings (`texture`) go through `JSON.stringify(s)` for correct escaping.
- Output ends with `}\n`, matching the pack file.

`makeSky3(uv, mapping, texture, layer)` assembles a full object from the editable fields plus the fixed
values in `constants.ts`; `buildSky3(hero)` = `solveHero` + `makeSky3`.

`parseSky3(text)` returns `{ ok: true, json, recovered, warnings }` or `{ ok: false, errors }`, collecting every
problem rather than stopping at the first.
- **Errors** (nothing imported): invalid JSON, a `type` other than `nuit:multi-textured`, no texture entry,
  a missing or non-numeric `uvRange`, a `uvRange` that is empty or outside the North cell (with a 1e-4
  tolerance for 4 dp rounding), or a mapping keyframe that isn't three numbers.
- **Warnings** (imported, but export changes it): every fixed field that differs (schemaVersion, blend, fade,
  speed, skyboxRotation, sunSkyTint, visibleUnderwater, conditions, grid size), a missing `axis` (the layer
  would not spin), a top-level `blend`, a non-zero Z, extra mapping keyframes or texture entries, unknown
  fields that export drops, and a `uvRange` that fits neither mode.
- `json` keeps the imported `uvRange` and mapping exactly (pinned); `recovered` adds `texture` and `layer`
  to `recoverParams`.

`HERO_MCMETA` is the same bytes as the pack's `hero.png.mcmeta` (multi-line; same content as
`{"texture": {"blur": true, "clamp": true}}`), and `mcmetaFileName(texture)` names the download after the texture.

---

## 6. Rendering (`scene.ts`, `view.ts`)

Scene graph:

```
scene
 └─ spinGroup            rotation.y = θ(T) in radians   (Y(θ), §4.5)
     ├─ face_bottom … face_east   6 × Mesh(PlaneGeometry(2,2))      renderOrder 0
     ├─ dayFaces (stretch)        6 × Mesh, opacity = fadeAlpha    renderOrder 1
     └─ heroGroup        rotation = Euler(sx·X, sy·Y, 0, 'ZYX')     (M)
          └─ heroMesh    PlaneGeometry(s1−s0, t1−t0) at ((s0+s1)/2, (t0+t1)/2, −1)   renderOrder 10
camera (PerspectiveCamera, at origin, rotation order 'YXZ', near 0.01, far 10)
```

So a hero vertex lands at $\text{Spin}\cdot M\cdot\mathbf v$, the same as Nuit's $Y(\theta)\,M\,\mathbf v$ (§1.2).

### Sky cube

For each face, the plane's local axes are set from the face table:

1. Local $x \to \mathbf r$ and local $y \to \mathbf u$.
2. Local $z$ (the plane's front normal) $\to \mathbf n = \mathbf r \times \mathbf u$. Working through the table,
   $\mathbf r \times \mathbf u = -\mathbf c$ for **every** face. For example, north: $(1,0,0)\times(0,1,0) = (0,0,1) = -(0,0,-1)$;
   bottom: $(1,0,0)\times(0,0,-1) = (0,1,0) = -(0,-1,0)$. So the front side faces inward, toward the camera.
3. Because $\mathbf r, \mathbf u, \mathbf n$ are orthonormal and $\mathbf n = \mathbf r \times \mathbf u$,
   the matrix $[\mathbf r\ \mathbf u\ \mathbf n]$ has determinant +1: a pure rotation with no mirroring.
   `Matrix4.makeBasis(r, u, n).setPosition(c)` places the plane. `side: FrontSide`.
4. Texture: crop the cell $(col, row)$ of the atlas into its own canvas ($F\times F$, $F = W/3$) and make a
   `CanvasTexture`. With `flipY` (the default), the canvas's top row maps to the plane's $+y$, which is $\mathbf u$,
   so image row 0 is at $t = +1$ as §3 requires. `ClampToEdgeWrapping`, `MeshBasicMaterial`, `depthWrite: false`,
   `NearestFilter` with no mipmaps (section 1.6). No `CubeTexture` and no `scene.background`.
5. Colour: every texture uses `colorSpace = NoColorSpace`, and the renderer uses
   `outputColorSpace = LinearSRGBColorSpace`. Nothing is converted, so blending happens on the raw
   (gamma-encoded) PNG values, as in Minecraft. `ColorManagement.enabled = false`, so overlay colours written
   as CSS hex are used as is too.
6. `facePlacement(face)` in `scene.ts` builds the matrix; `view.test.ts` checks it against the table.

### Hero

*Revised in M3; see section 12.* The hero is built by `heroGeometry(heroPieces(uvRange))`, a port of Nuit's face loop.
Inside the North cell it is the single quad on z = −1 described here before: $s \in [s_0, s_1]$, $t \in [t_0, t_1]$ from
`uvRangeToFaceRect`, facing +z toward the camera. `transparent: true`, `depthTest: false`, `renderOrder: 10`.

### Camera and look controls (`view.ts`)

`camera.rotation.set(pitch, yaw, 0, 'YXZ')`. Three.js yaw is counter-clockwise from above, so
"compass bearing clockwise from north" $\phi$ maps to `yaw = −φ`. `ViewState.yawDeg` stores $\phi$.
Dragging right increases $\phi$ and dragging up looks up, like the mouse in Minecraft, at
(vertical FOV ÷ canvas height) degrees per pixel. Pitch is clamped to ±89°.

M2 also adds bearing, pitch and FOV sliders with number boxes, so exact views (such as the M3 check at pitch 22.47°)
can be typed in. A crosshair marks the centre of the view, and a readout shows the bearing and pitch plus what
Minecraft's F3 screen would show for the same view (`mcYawPitch`, `mcFacing`), for lining the preview up with the game. "Look at hero" computes the hero centre's world direction
$\mathbf d = \text{Spin}\cdot M\cdot(0, t_c, -1)$ and sets $\phi = \operatorname{atan2}(d_x, -d_z)$, pitch $= \arcsin(d_y/|\mathbf d|)$.
FOV is **vertical** in both Three.js and Minecraft, so the slider value is passed through as is.

### Verifying orientation with `placeholder_atlas.png` (M2)

1. Automated: `faces.test.ts` (section 4) proves the table equals Nuit's matrices.
2. Visual checks from BRIEF §14 M2 (north centred, W left, E right; TOP shows S at the top at pitch +89°;
   turning right goes E → S → W with continuous horizon lines and matching edge letters).
3. An optional overlay draws the cube edges and face labels from the table itself, independent of the
   texture, so a texture/table mismatch shows up as a label disagreeing with the painted letters.
   It has two parts. The **magenta** part (cube edges, and "north · cell 1,1"-style labels at $t = -0.5$) sits in
   `spinGroup` and turns with the sky. The **cyan** part is fixed to the world: the horizon ring, faint rings every
   10° of elevation, the four meridians, N/E/S/W letters, and elevation labels up the north meridian.
   Every overlay object uses `depthTest: false` and `renderOrder` 20, above the hero's 10.
4. M3: test card with case 3 at θ = 0, yaw 0, pitch 22.47°: an upright card centred on screen, TOP at the top,
   L on the left, bottom edge 10° below the horizon. The overlay draws a horizon ring and a 10° tick to check against.

---

## 7. Time spin (preview only)

- `state.view.timeTicks` ∈ [0, 23999]. The readout shows the tick, the clock time (`ticksToClock`) and θ.
- `spinGroup.rotation.y = degToRad(sunAngleDeg(T))`.
- Play/pause advances T at a configurable rate (default: one in-game day in 60 s; a hidden 1:1 option is 20 ticks/s).
- **Default T = 6000 (noon, θ = 0)**, so the scene opens with the hero exactly where the sliders put it.

---

## 8. UI (`ui.ts`, plain DOM)

Layout: canvas on the left (fills the height); a scrollable control column on the right with these
sections: **Files** (atlas, hero, W×H override), **Hero** (mode, β ⟷ k, scale buttons, b, ψ, wall t_t),
**Output** (texture path, layer), **Readouts and warnings**, **Preview** (time, play, FOV, overlay,
look buttons), **JSON** (live `<pre>`, Copy, Download `sky3_image.json`, Download `hero.png.mcmeta`,
Import by paste or file).

- Each slider has a linked `<input type=number>`. One helper, `bindRange(el, num, get, set)`, keeps the pair
  in sync. It works like a small Java listener class registered on both inputs.
- The atlas loader checks $2W = 3H$ exactly and rejects anything else with the actual size in the message, keeping the
  previous atlas. (The planned "$W \bmod 3 \ne 0$" warning was dropped: $2W = 3H$ already makes $H$ even and
  $W = 3 \cdot \tfrac{H}{2}$, so it can never fire.) The default atlas is `reference/samples/placeholder_atlas.png`,
  bundled through a Vite asset import.
- Images are decoded with `createImageBitmap` (section 1.6) instead of `URL.createObjectURL`. Nothing leaves the browser.
- Warnings appear inline next to readouts (amber at 0.95, red at 1.0 or the zenith).

---

## 9. Milestones (BRIEF §14, adjusted)

| | Contents | Acceptance |
|---|---|---|
| **M1 Math** | `npm i -D vitest`; add `"strict": true` to tsconfig (the scaffold omits it); `constants.ts`, `math.ts`, `schema.ts`, `json.ts`; the three test files | `npx vitest` green: all 7 vectors, case 3 byte-identical, face matrices match Nuit |
| **M2 Sky** | remove scaffold (counter, assets, style); `vite.config.ts` with `base: '/sky-builder/'`; `scene.ts` sky cube; `view.ts` drag-look; overlay | BRIEF M2 visual checks |
| **M3 Hero** | hero from JSON, `ui.ts` hero controls, readouts, warnings, wall-mode toggle (its math is done in M1) | BRIEF M3 check at T = 6000 |
| **M3½ In-game check** | *You* run section 10 (about 5 minutes); I flip `SIGN_MAPPING_Y` if needed | Y sign confirmed ✅ (hero on the left, as predicted) |
| **M4 Time and I/O** | time slider, play/pause, spin; Copy and Download; mcmeta; import (pinned, aspect warning) | export → import → export identical |
| **M5 Polish** | drag-and-drop; `localStorage` (view and hero params, try/catch); Pages build; README with screenshots | `npm run build` + `vite preview` at `/sky-builder/` |
| *After M5* | day/night crossfade (`fadeAlpha`); several heroes (one layer file each) | |

Each milestone is a small series of commits. I stop after each one with a summary and test steps.

The BRIEF has already been updated for the decisions in section 11 (on 2026-10-04): the name, §1 target
environment, §3, §4.5–4.7, §6.1, §7, §8, §9 colour, §10, §11, §12 status, §13 vanilla data source, and §14 M3.

---

## 10. In-game checks (for M3½)

Only two things are left that the source can't settle. Both use the working pack in a creative world.

**A. Sign of mapping Y** (BRIEF §12.2). *Done: the hero appeared on the left, as predicted, so `SIGN_MAPPING_Y`
stays +1. Measured against the NE label in the developer's screenshot, the circle's centre was about 29° west of
north and 21° up, against a prediction of 30° and 22.47°.*

1. In `sky3_image.json`, change `"mapping": {"0": [22.47, 0.0, 0.0]}` to `[22.47, 30.0, 0.0]`.
2. In game, press **F3+T** to reload resource packs, then run `/time set noon`.
   Near noon the sky turns only about 0.2° per second, so there is no need to stop time.
3. Press **F3** and turn until the "Facing" line says **north**, with the yaw near 180 or −180. Look up a little.
4. Prediction: the hero is **to the left** of the crosshair (west), about 30° off centre, so its centre is at yaw ≈ 150.
   - Hero on the left: the source reading is right, and nothing changes.
   - Hero on the right (yaw ≈ −150): tell me, and I flip `SIGN_MAPPING_Y` to −1.
5. Put mapping Y back to `0.0` and press F3+T again.

Optional sanity check of the spin: with Y = 0, `/time set 18000` (midnight) should put the hero due **south**.

**B. `hero.png.mcmeta`** (BRIEF §12.5). *Optional since 2026-10-10: the source says it is applied (section 1.6).*

Look at the hero through a **spyglass**, which magnifies it enough to see individual texture pixels. Then
temporarily rename `hero.png.mcmeta` and press F3+T. If the image goes from smooth to blocky, crisp pixels,
the file is being applied (`blur: true` means smooth filtering). If nothing changes, it isn't, and the tool's mcmeta
download is harmless but unnecessary.

---

## 11. Decisions (2026-10-04)

| # | Topic | Decision |
|---|---|---|
| 1 | Mapping X sign | **Closed.** `SIGN_MAPPING_X = +1`. The source agrees with the running config, so no further in-game test is needed. |
| 2 | Mapping Y sign and UI | The slider is the **raw mapping Y** (positive = west), with a noon-bearing readout. `SIGN_MAPPING_Y = +1`, **confirmed in game** (check A in section 10). |
| 3 | Spin | **Vanilla 26.2 curve** (cubic Bézier from `day.json`), with no linear option. Target: plain Nuit and vanilla 26.x, no datapacks. Time defaults to 6000. |
| 4 | Bottom face | **Closed** (source-verified, §1.4). |
| 5 | mcmeta | Keep the download. **Closed from source on 2026-10-11** (section 1.6): the file is applied, and check B in section 10 is optional. |
| 6 | Scope | Wall mode in M3; crossfade after M5. |
| 7 | Name | **sky-builder** everywhere; Pages `base: '/sky-builder/'`. |
| 8 | Colour | No colour conversion (`NoColorSpace` + `LinearSRGBColorSpace`), matching Minecraft's gamma-space blending. |
| 9 | Import | Pin the imported JSON. If the loaded image's aspect differs from the uvRange by more than 1%, **warn only**. |
| 10 | BRIEF edits | Applied. |

---

## 12. M3 design notes (2026-10-12)

**Checked in the Nuit source for M3:** `UVRange.CODEC` clamps each value to [0, 1] as it reads the JSON
(`CodecUtils.getClampedFloat`, `Mth.clamp`). The textured shaders (`textured_skybox.fsh`, `multi_textured_skybox.fsh`)
do `fragColor = texture(Sampler0, uv) * ColorModulator` and discard only `a == 0`. `Blend` "normal" is
`SRC_ALPHA, ONE_MINUS_SRC_ALPHA` with `ColorModulator = (1, 1, 1, fadeAlpha)`, and the fade alpha is 1 for empty keyframes.

1. **The hero is drawn the way Nuit draws it.** `math.heroPieces` ports the face loop: clamp the range, then for each
   face, intersect it with the face's cell and map the overlap onto the face, showing the matching fraction of the
   image. `scene.heroGeometry` makes one quad per piece. Inside the North cell this is exactly the old single quad.
   Past the cell edge the preview shows the same bend as the game, rather than a flat card that the game would not
   draw. `faces.test.ts` checks every vertex and texture coordinate against the port of Nuit's `nuitVertex`.
2. **Hero texture.** Decoded with `createImageBitmap(file, {colorSpaceConversion: 'none', premultiplyAlpha: 'none',
   imageOrientation: 'flipY'})`. WebGL can't flip or premultiply an ImageBitmap on upload, so the flip happens at
   decode and `flipY` and `premultiplyAlpha` stay false. Linear filtering, no mipmaps and clamped edges come from
   `hero.png.mcmeta` (section 1.6). `NormalBlending` with straight alpha is Nuit's "normal" blend. The `a == 0`
   discard looks the same under that blend, so it isn't copied.
3. **k range.** `K_RANGE` is $[\tan 2.5°,\ 1.5]$. The β slider (5°–87°) only shows k. The k box and the scale buttons
   can go past it, so the 0.95 warning and the 1.0 error can actually be reached ($\beta = 87°$ is only
   $k = 0.949$), and one ×1.5 step past the limit can be undone with ÷1.5.
4. **A new error, `empty`**, for wall mode when $b \ge \arctan t_t$ (BRIEF §6.2). The size readouts show a dash then.
5. **Readouts** show the reach on the face, $\max|t|$ and $\max|s|$, against the 0.95 limit, because that is what the
   limit applies to. In tilted mode these equal $k$ and $ak$; in wall mode the top edge $t_t$ sets $\max|t|$. A value
   on the limit (wall mode's default $t_t = 0.95$) reads "at the limit". In an error state where the range leaves
   the North cell, the readouts still use the North-face inverse, so they are only indicative there; the error says so.
6. **Look at hero** uses `heroCentreDirection` and `viewToward` in `math.ts`. These are pure, and `faces.test.ts`
   checks `applyMapping` against Nuit's quaternion and `scene.heroMappingEuler`.
7. **The live JSON panel** shows `serializeSky3(json)` from M3 on, read-only; Copy, Download and import arrive in M4.
8. **Texture path check.** `json.textureProblem` flags a texture that isn't `namespace:path` with Minecraft's
   allowed characters, or that doesn't end in `.png`. It is shown under the box and doesn't block anything.
9. **Default hero** is `reference/samples/test_hero_1063x1502.png`. Loading an image fills in the W × H boxes,
   which can then be overridden.

---

## 13. Panorama input (approved 2026-10-12, built on branch `pano-input`)

**Request:** let the sky upload take either an atlas or an equirectangular panorama, chosen from a dropdown, and
convert a panorama to an atlas in the browser. This reverses the old BRIEF §10 non-goal "Converting panoramas to
atlases"; BRIEF §8, §10, §13 and §14 are updated.

**Decisions (2026-10-12):** the dropdown has **Auto (by shape)** as its default, plus Atlas and Panorama. The
left-edge bearing **is** a UI field (section 13.7), defaulting to `PANO_LEFT_BEARING_DEG` (−135°, `sky_convert.py`'s
convention). It was left out at first, then added back: on a computer without the Python scripts the sky must be
adjustable by eye, and as free software the tool should handle panoramas from other tools, which often put north in
the middle (−180°). The `sky_convert.py` cross-check was run in a throwaway venv in the session scratchpad, and its
output is committed as test fixtures.

### 13.1 Convention: the same as `reference/sky_convert.py`

Atlases already in the pack were made with `sky_convert.py`, and its docstring warns that other converters may start
the panorama at a different heading or mirror it. So the browser port uses the script's convention exactly:

- The panorama is exactly 2:1 ($W = 2H$), as the script requires.
- Column $x = 0$ is the south-west corner (bearing $\lambda_0 = -135°$), and $x$ grows turning right (clockwise
  from above). So the face centres W, N, E, S sit at $\tfrac{W}{8}, \tfrac{3W}{8}, \tfrac{5W}{8}, \tfrac{7W}{8}$.
- Row $y = 0$ is straight up, $y = \tfrac{H}{2}$ the horizon, $y = H$ straight down.
- A panorama made with another convention comes out turned; the left-edge field (section 13.7) turns it back.
  A mirrored panorama has to be flipped in an image editor first.

### 13.2 The conversion, step by step (`math.panoramaToAtlas`, pure)

For each face (BRIEF §3 table) and each atlas pixel $(i, j)$ in that face's cell, with face size $F$:

1. Pixel centre in face coordinates: $s = \dfrac{2(i + \tfrac12)}{F} - 1$ and $t = 1 - \dfrac{2(j + \tfrac12)}{F}$
   (row 0 is the top of the cell, $t = +1$).
2. Direction: $\mathbf d = \mathbf c + s\,\mathbf r + t\,\mathbf u$. Only its direction matters.
3. Bearing and elevation: $\lambda = \operatorname{atan2}(d_x, -d_z)$ and
   $\varphi = \arcsin\!\left(\dfrac{d_y}{\lVert\mathbf d\rVert}\right)$.
4. Panorama position, in pixel units with pixel centres on whole numbers:
   $x = \dfrac{(\lambda - \lambda_0) \bmod 360°}{360°}\,W - \tfrac12$ and $y = \dfrac{90° - \varphi}{180°}\,H - \tfrac12$
   (`math.directionToPanorama`).
5. Bilinear sample: $x$ wraps around ($\bmod W$), and $y$ is clamped to $[0, H - 1]$, as in the script's `_bilinear`.
6. Round each channel to the nearest integer, half to even. Writing into a `Uint8ClampedArray` does exactly this,
   like numpy's `rint` and `clip` in the script. Alpha is kept.

Check with the north face's centre: $s = t = 0$ gives $\mathbf d = (0, 0, -1)$, so $\lambda = 0$ and $\varphi = 0$.
Then $x = \tfrac{135}{360}W - \tfrac12 = \tfrac{3W}{8} - \tfrac12$, which is the continuous position $\tfrac{3W}{8}$, and
$y = \tfrac{H}{2} - \tfrac12$, the horizon. This matches the docstring.

**Face size.** It defaults to $F = \operatorname{round}(W/4)$, the script's ratio (8192 → 2048), within
`PANO_FACE_RANGE` (16 to 2730). The script refuses faces over 2730, because the atlas would pass 8192 px wide. The
box can be edited.

**Speed.** In Node, an 8192 × 4096 panorama to 2048 px faces takes 3.0 s. The loop reuses one output object for
the sample position instead of allocating one per pixel; that took it from 4.4 s. In Edge, the 2048-wide sample
converts in 0.4 s.

### 13.3 Where it runs

The conversion runs in a **Web Worker** (`src/convert.worker.ts`), so the page doesn't freeze. A Web Worker is
like a Java thread that shares no memory and talks only by messages.

1. The main thread decodes the file (`createImageBitmap`, `colorSpaceConversion: 'none'`), because Auto needs the size.
2. If it is a panorama, the `ImageBitmap` is *transferred* to a new worker, not copied, like handing a `byte[]` to
   another thread and giving up your reference.
3. The worker reads the pixels through an `OffscreenCanvas` (panoramas are opaque, so the canvas's premultiplied
   storage loses nothing), calls `math.panoramaToAtlas`, and reports progress after each face.
4. It encodes the atlas as a PNG (`OffscreenCanvas.convertToBlob`) and transfers back the PNG `Blob` and an `ImageBitmap`.
5. The main thread shows the bitmap through the existing `scene.setAtlas`, and shows **Download atlas (PNG)**, named
   `<panorama name>_atlas.png`, so the result can go straight into the pack.

A new file, type or face size stops a running conversion (`terminate()`), and a load counter drops any decode that a
newer load has overtaken. Memory for an 8192-wide panorama is about 128 MB for the panorama plus about 96 MB for the
atlas. Fine on a desktop; very large panoramas may fail on phones, which the status line reports.

### 13.4 UI (Files section)

```
Sky       [ Auto (by shape) ▾ ]  [Choose file]
          status: pano.png · 8192 × 4096 panorama → atlas 6144 × 4096 (faces 2048 px) · 3.1 s
          ── while the sky comes from a panorama ──
          Face size  [ 2048 ]
          Left edge  [────●────] [ -135 ]
          [ Download atlas (PNG) ]
```

- Auto picks the type from the shape. A chosen type must match it. On a mismatch the message names the other type
  ("It is 2:1, so choose Panorama or Auto."), and the previous sky stays.
- The face size re-runs the conversion when committed (Enter, or leaving the box), not on every keystroke.

### 13.5 Tests (`tests/panorama.test.ts`)

`math.panoramaToAtlas` and `math.directionToPanorama` are pure, so vitest drives them without a browser:

- **Geometry, from the convention in 13.1:** the W, N, E and S face centres land at $\tfrac{W}{8}, \tfrac{3W}{8},
  \tfrac{5W}{8}, \tfrac{7W}{8}$ on the horizon; straight up and down land on the first and last rows; the left edge is
  the south-west corner; and turning the left-edge bearing by 45° moves everything by $\tfrac{W}{8}$.
- **Pixels:** a uniform panorama gives a uniform atlas of shape $3F \times 2F$, which `atlasLayout` accepts, and
  progress is reported once per face.
- **Against `sky_convert.py` itself:** `reference/samples/pano_test_256x128.png` is synthetic (red = column, so it jumps
  at the wrap; green = 2 × row; blue = a 16 px checkerboard). `pano_test_atlas_f64.png` and `pano_test_atlas_f37.png`
  are the script's output at face sizes 64 and 37 (37 is odd, so a pixel sits exactly on each face centre, and it also
  tests shrinking). Every channel must match within 1, in under 1 % of values. Results: face 64 identical; face 37,
  2 of 32 856 values off by 1, from the script's float32 arithmetic.
- `tests/png.ts` reads the fixtures with web-standard APIs only (Vite `?inline` and `DecompressionStream`), so the
  tests need no Node type definitions.
- **End to end in Edge:** `reference/samples/placeholder_pano_2048x1024.png` (made from `placeholder_atlas.png` with
  `sky_convert.py to-pano`) was converted in the browser and downloaded. Against the script's own `to-atlas` of the
  same panorama, 4 of 6 291 456 values differ, each by 1. Rendered, it shows the same M2 orientation checks as the atlas.

The planned seam test was not needed as a separate test: the fixtures cross every cube edge and the wrap.

### 13.6 Placement

A small milestone of its own, on branch `pano-input`, after M3 and before M4. `sky_convert.py` stays for offline and
batch use (including atlas → panorama), and as the reference for the convention.

### 13.7 Left edge field, with a live preview

A slider (−180° to 180°) with a number box, shown with the face size, plus a hint: `sky_convert.py` uses −135°, and
tools that put north in the middle need −180°. It carries over to the next panorama (which usually comes from the
same tool) until Reset.

Re-converting on every slider movement would take seconds each time, so the slider **previews by turning the sky**
while it moves, and converts when let go. The number box converts when committed. This works because changing the
left edge by $\Delta$ is the same as turning the whole sky by $\Delta$ about the vertical:

1. An atlas converted with $\lambda_0$ shows, in direction $\mathbf w$, the panorama at bearing
   $\lambda(\mathbf w) - \lambda_0$ (13.2 step 4).
2. The preview turns the sky faces by $R$, a turn of $\Delta$ clockwise from above, so the viewer looking along
   $\mathbf w$ sees the atlas at $R^{-1}\mathbf w$, whose bearing is $\lambda(\mathbf w) - \Delta$.
3. So the preview shows the panorama at $\lambda(\mathbf w) - \Delta - \lambda_0 = \lambda(\mathbf w) - (\lambda_0 + \Delta)$:
   exactly what converting with $\lambda_0 + \Delta$ gives. Elevations don't change.

`scene.setSkyTurnDeg(Δ)` turns only the `skyFaces` group, so the hero, whose place comes from its JSON, stays put. In
Three.js that is `rotation.y = −Δ` (`scene.skyTurnRotationY`), because a positive angle turns counter-clockwise. A new
atlas resets the turn. `view.test.ts` checks the equivalence for several $\Delta$ and directions, and that +90°
turns north to east.

### 13.8 Reset

A **Reset sky and hero** button in the panel's title row puts back the starting state: the sample atlas (type Auto,
left edge −135°, default face size), the test card, and every hero setting, including the mode, texture path and
layer. The camera stays where it is. It asks for confirmation first, because there is no undo and the JSON can't be
copied out until M4. Both file pickers are emptied, so they don't name files that are no longer shown.

## 14. M4: time and I/O (approved, with the condensed time row below; built on branch `m4-time-io`)

BRIEF §14 M4: the time-of-day spin with play/pause; Copy and Download; the `.mcmeta` download; and JSON import that
restores the sliders, with export → import → export identical. The JSON side (`serializeSky3`, `parseSky3`,
`HERO_MCMETA`) has existed and been tested since M1; M4 adds the UI and the time controls. It builds on section 7 (time),
section 8 (UI) and decision 11.9 (import pins the JSON).

### 14.1 Time of day (preview only)

```
Time   [▶] [────|────●────|────|────] [ 60 s/day ▾ ]
       12:00 · θ 0.0° · the hero faces due north
```

*Condensed at the developer's request:* one row with play/pause, the slider and the speed. The slider has
tick marks (a `<datalist>`) at 0, 6000, 12 000 and 18 000, which Chrome and Edge snap to when dragged close, in place of
quick buttons and a number box. The arrow keys move it one tick at a time.

- A slider from 0 to 23 999 ticks. The readout shows the clock (`ticksToClock`), θ (`sunAngleDeg`), and
  where the hero faces now: the bearing of `heroCentreDirection(uv, mapping, θ)` (`viewToward`), in quadrant form.
  At noon this matches the existing noon readout.
- **Play/pause**, with speeds of 1 day per 10 s, per 60 s (the default, as section 7 planned), or per 20 min (real game
  speed, 20 ticks/s). Each animation frame advances $T \leftarrow (T + r\,\Delta t) \bmod 24000$, where $r$ is ticks
  per second and $\Delta t$ the frame time in seconds (`math.advanceTicks`). The loop runs only while playing; it's
  like a `javax.swing.Timer` that fires once per screen refresh. Moving the time slider pauses.
- The spin already turns `spinGroup` (sky and hero). The cyan world overlay stays fixed, so the sky and hero can be
  watched passing N, E, S and W. "Look at hero" already allows for θ.
- Time is preview only: it never reaches the JSON.

### 14.2 Export

```
[ Copy ]  [ Download sky3_image.json ]  [ Download hero.png.mcmeta ]
```

- **Copy** puts `serializeSky3(json)` on the clipboard (`navigator.clipboard.writeText`, which is asynchronous, like a
  `CompletableFuture`) and shows "Copied" briefly. If the browser refuses, the JSON text is selected and the
  message says to press Ctrl+C.
- **Download** saves exactly those bytes, ending in one newline, as `sky3_image.json`. The `.mcmeta` button saves
  `HERO_MCMETA`, named after the texture (`mcmetaFileName`, e.g. `hero.png.mcmeta`).
- **Allowed, with a warning** (decision 2026-10-12): someone may want only part of the pipeline. If the JSON has a red
  error (`outsideCell`, `zenith` or `empty`) or the texture path has a problem, Copy and Download JSON first show a
  confirm dialog listing them, ending "Export anyway?". Amber warnings don't ask, as they're already on screen. The
  `.mcmeta` download never asks. `json.exportProblems(readouts, textureProblem)` builds the list, as a pure function.

### 14.3 Import

```
Import  [Choose .json]   ▸ Paste JSON   (opens a text box and an [Import] button)
        status, and any warnings, listed below
```

- A `.json` file or pasted text goes through `parseSky3`. On errors nothing changes, and the errors are listed in red.
- On success (decision 11.9, "pinned"):
  1. `state.json` becomes the parsed JSON: `uvRange` and mapping exactly as loaded, fixed fields normalised.
     `state.pinned = true`.
  2. The controls show the recovered values (§6.3), including texture and layer. The hero image and W × H stay, as
     they aren't in the JSON.
  3. The panel says "Imported <name>. The JSON stays exactly as loaded until you move a size or position control",
     followed by `parseSky3`'s warnings (amber).
  4. If the loaded hero image's aspect differs from `aspectFromUv(uv)` by more than 1 %, it warns that the JSON was made
     for a different image, and that moving a size control refits it to this one.
  5. A range that fits neither mode keeps the current mode; only ψ is recovered. The preview shows the range as it is.
- **What unpins.** Size and position controls (mode, β/k, scale, b, t_t, ψ, W × H) regenerate the JSON from the
  controls, as now. **Texture and layer edits don't unpin**: they change those two fields of the pinned JSON
  and leave its `uvRange` and mapping untouched. Otherwise renaming the texture could shift a last digit, because
  recovering k from a rounded V is only good to $2 \times 10^{-4}$ (section 2). Reset also unpins.
- Export → import → export is identical by construction, because the JSON is pinned. `json.test.ts` already checks this
  for all 7 cases.

### 14.4 Tests

- `math.advanceTicks`: wraps around (23 990 + 20 ticks → 10), for each speed.
- `json.exportProblems`: lists red errors and the texture problem, and not amber warnings.
- `json.applyImport(hero, parsed)` and `json.editPinned(json, {texture, layer})`, both pure: the round trip, and a
  texture edit while pinned leaving the `uvRange` and mapping bytes unchanged.
- In headless Edge:
  - Tick 18 000 → "Look at hero" gives bearing 180, and Play advances the clock.
  - Copy (with clipboard permission) and the downloads give bytes identical to the pack's `sky3_image.json` (case 3)
    and `hero.png.mcmeta`.
  - Importing the pack's `sky3_image.json` shows case 3's values and identical JSON.
  - Importing `sky1_night.json` is refused, with the type error.

### 14.5 Not in M4

Drag-and-drop and `localStorage` (M5), the day/night crossfade (stretch goal), and the atlas heading control (maybe later).

### 14.6 Decisions

1. Playback speeds of 10 s, 60 s (default) and 20 min per day: approved.
2. A texture-path problem also triggers the export confirm, because Minecraft won't find the texture: approved.

### 14.7 As built

- **Where the code is.** `math.advanceTicks` and `math.importAspectMismatch`; `json.exportProblems`, `json.applyImport` and
  `json.editPinned`; the play loop, export and import in `main.ts`; the controls in `ui.ts`.
  `main.updateHero(patch, fromImage)` keeps a pinned JSON when the patch only touches `texture` or `layer`, or when it
  comes from loading a hero image; anything else regenerates the JSON and unpins it.
- **Play.** It schedules the next frame before updating, so `updateView` sees the loop running. Each frame advances by
  at most 0.25 s, so returning to a hidden tab doesn't jump the sky. Moving the time slider pauses.
- **Checked in headless Edge:**
  - Tick 18 000 followed by "Look at hero" gives bearing 180, and Play at 10 s/day advanced the clock.
  - Download gave files byte-identical to the pack's `sky3_image.json` (case 3) and `hero.png.mcmeta`.
  - With a red error, Copy and Download both listed the problems, and did nothing when declined.
  - Importing the pack file, by file or by paste, reproduced it byte for byte. Editing the texture while pinned changed
    only the texture line. Moving Bottom unpinned it. Loading a 300 × 400 image while pinned kept the JSON and showed the
    aspect note. `sky1_night.json` was refused with the type error.
  - A real click on Copy put the JSON on the clipboard.
- **Clipboard line endings.** On Windows the clipboard turns each line break into CRLF, so pasted text has CRLF; it is
  otherwise identical (checked). Minecraft's JSON reader ignores this. **Download** gives the exact bytes.
- **Fixes found in testing.** "The hero faces …" now judges "due south" on the shown, rounded value (at midnight the
  bearing is a hair off 180°). The export note now clears when the JSON changes.

---

## 15. M5: polish and publish (approved; built on branch `m5-polish`)

BRIEF §14 M5: drag-and-drop, `localStorage`, a `vite build` that works on GitHub Pages, and a README with
screenshots. Checked on the repo: it is public, with no licence, no README, and Pages not enabled.

### 15.1 Drag and drop

- **On a field:** the Sky, Hero and Import rows each accept a dropped file and light up while it is dragged over them.
  It then goes exactly where a file picked there would go.
- **Anywhere else** (including the 3D view), each file is routed by what it is: `.json` goes to Import; an image that
  is 3:2 or 2:1 goes to the Sky (the dropdown's type still applies), and any other image to the Hero. The status line
  says where it went, and how to redirect it ("Loaded as the sky because it is 2:1. Drop it on the Hero row to use it as
  the hero."). Several files can be dropped at once, such as a panorama and a hero.
- The browser's default of opening a dropped file in place of the page is turned off.
- The routing is a pure function, `dropTarget(name, mimeType, size)`, with tests.

### 15.2 Remembering the last session

- **Settings** go in `localStorage` under one versioned key (`sky-builder/v1`), saved half a second after the last
  change: every hero control, the view (FOV, bearing, pitch, overlay, time, speed; never "playing"), the sky options
  (type, face size, left edge), and an imported JSON while it is still pinned, with its name.
- **Reading** is defensive: a missing, older or broken entry, or a browser that blocks storage, falls back to the
  defaults without an error (every access is in `try/catch`). Values are clamped as if typed in. A pure module
  `src/saved.ts` (`toSaved(state)`, `fromSaved(text)`) does the validating, with tests.
- **Images (your choice, see 15.6):** `localStorage` holds about 5 MB, which is too small for images.
  - *Option A, recommended:* keep the last sky file and hero image in IndexedDB, the browser's local database. It
    has no practical size limit, and nothing leaves the browser. After a reload, everything comes back as it was;
    a panorama is re-converted with its saved settings.
  - *Option B:* settings only. After a reload the sample sky and test card appear. The hero's W × H keep their saved
    values, so the JSON doesn't change, and a note asks for the hero image again.
- **Reset** also forgets everything saved. A line in the panel says settings are remembered in this browser only.

### 15.3 GitHub Pages

- `.github/workflows/deploy.yml` runs on every push to `main` (and by hand): `npm ci`, `npx vitest run`,
  `npm run build`, then the official Pages actions upload `dist/` and deploy it. A failing test stops the deploy.
- `vite.config.ts` already sets `base: '/sky-builder/'`, so the site will be **https://0xsasheen.github.io/sky-builder/**.
- **One step only you can do:** in the repo's Settings → Pages, set *Source* to *GitHub Actions*. The first deploy
  runs after that, on the next push or from the Actions tab.
- The build's "chunk over 500 kB" warning comes from Three.js itself (about 540 kB, 140 kB gzipped). For a one-page
  tool a single file is fine, so the limit is raised to 800 kB with a comment, rather than splitting.
- Acceptance: `npm run build` plus `npm run preview` works at `/sky-builder/` locally, and the live site loads.

### 15.4 README

- What it is, in one paragraph, with a screenshot, and the live link.
- How to use it: load a sky (atlas or panorama) and a hero, place the hero, check it with the time slider, export,
  and where the files go in a resource pack (`assets/nuit/sky/`, `assets/<namespace>/textures/sky/`).
- What it assumes: Minecraft Java 26.2, Nuit, vanilla time of day.
- Development: the npm commands and tests, and where the spec and plan live (`docs/BRIEF.md`, `docs/PLAN.md`).
- Credits: Nuit by FlashyReese; `sky_convert.py`'s convention.
- **Screenshots** go in `docs/screenshots/`, taken with headless Edge from the **sample images only** (rule 8): the
  hero on the placeholder sky with the overlay, a panorama being converted, and the panel.
- **A licence:** a FOSS repo needs a `LICENSE` file. Your choice (15.6).

### 15.5 Housekeeping

- CLAUDE.md rule 6 still says the mapping signs are unconfirmed. Both now are (BRIEF §12.1, §12.2). With your OK it will
  say so, and still keep the named constants.
- BRIEF §14 M5 and the PLAN status are updated at the end.

### 15.6 Decisions

1. **Licence: MIT.** `LICENSE` is added, with the copyright holder "Sachin".
2. **Images: remembered too** (option A), in IndexedDB.
3. **Drops: per-field targets, plus automatic routing** everywhere else.
4. **CLAUDE.md rule 6 is updated:** both signs are confirmed, and the named constants stay.

### 15.7 As built

- **Drops.** `ui.ts` listens for native drag events. A counter of `dragenter`/`dragleave` outlines the rows while
  files are over the page, and the row under the pointer lights up. `main.dropFiles` routes each file; for an image
  dropped elsewhere it reads the size first (`createImageBitmap`) to decide between Sky and Hero. `json.isJsonFile`
  is tested.
- **Remembering.** `saved.ts` (pure, tested) writes and checks the settings; `imagestore.ts` keeps the last picked
  sky file and hero image in IndexedDB. Start-up restores the settings at once, then the files: stored ones if
  present, otherwise the samples. A remembered hero image comes back without overwriting a W × H that was typed
  in. If the image is missing, the test card stands in at the saved size, with a note. A picked sky file is stored
  only after it loads successfully, so a broken file isn't brought back. Reset clears the stored images.
- **Pages.** `.github/workflows/deploy.yml` (Node 24): `npm ci`, the tests, the build, then the official
  upload and deploy actions. `vite.config.ts` raises the chunk warning to 800 kB, and the build is clean.
- **README.** It has three screenshots from the sample images, in `docs/screenshots/`.
- **Checked in headless Edge, with native file drops through the DevTools protocol:**
  - Dropped on the view: a panorama went to the Sky ("as it is 2:1"), a 300 × 400 PNG to the Hero, a JSON to Import
    (pinned, with the aspect note), and `LICENSE` was refused.
  - The test card dropped on the Sky row was rejected, because it isn't 3:2 or 2:1.
  - After a reload, the panorama (left edge −150°), the hero image, the pinned import, the time, the FOV and the
    overlay all came back.
  - After unpinning and reloading, it stayed unpinned with ψ = 20.
  - Reset and then a reload gave the samples and the defaults.
- **The live site** (after the Pages setting): the workflow passed (tests, build, deploy) in about a minute. All assets load
  under `/sky-builder/`, and in headless Edge the live page renders the samples and converts a dropped panorama in its worker.

---

## 16. Assemble a resource pack (built, tested by the developer, live)

**Request:** an **Assemble pack** button. It takes a pack template (a zip), puts in the current hero image, the
current sky and the generated JSON, and downloads a new zip, ready to drop into `resourcepacks/`.

### 16.1 The template

The developer's template, `NuitSkyTestPack_26_2.zip`, has the same layout as `reference/pack-example` (read from its
file list only; nothing was extracted):

```
pack.mcmeta
assets/nuit/sky/sky1_night.json, sky2_day.json, sky3_image.json
assets/sasheen/textures/sky/night.png, day.png, hero.png, hero.png.mcmeta
```

- **Your own template is an upload**, like the sky and the hero: a new **Pack template** row in Files, which also
  takes drops. It is remembered in IndexedDB and read in the browser; nothing is uploaded. Without one, the tool uses
  a bundled **starter template**, which has the same structure and only rule-8-safe textures (section 16.7).
- The tool reads every `assets/nuit/sky/*.json` and sorts the layers by `type`: the `nuit:multi-textured` layer is the
  hero layer, and each `nuit:square-textured` layer is a sky layer with its `texture` path.

### 16.2 What goes into the new zip

| File | Source |
|---|---|
| The hero layer's JSON (the template's own file name, or `assets/nuit/sky/sky3_image.json` if it has none) | The exact exported bytes (§5) |
| `assets/<namespace>/<path>` from the JSON's `texture` | The hero image: a PNG byte for byte; any other format re-encoded to PNG from its pixels, with no colour conversion |
| The same path plus `.mcmeta` | `HERO_MCMETA` |
| The texture of the chosen sky layer(s) | The current sky atlas: the loaded file if it was a PNG atlas, or the converted PNG if it came from a panorama |
| Everything else (`pack.mcmeta`, other layers and textures) | Copied unchanged |

The output is named after the template, for example `NuitSkyTestPack_26_2_skybuilder.zip`.

### 16.3 Checks before assembling

- **Blocking:** no hero image, a texture path Minecraft can't use (`textureProblem`), or a template without
  `pack.mcmeta` or any Nuit layers.
- **Asked first**, like export: the hero's red errors.
- **Listed as warnings:**
  - a sky layer whose `rotation` differs from the hero's (`speed`, `axis`, `skyboxRotation`), so the hero would drift
    against that sky (BRIEF §2)
  - a sky layer with the old top-level `"blend"` object, which 26.2 ignores
  - an atlas wider than 8192 px
  - a template whose hero texture is left unused because the texture path changed

### 16.4 Zip code

- **Option A:** a small zip reader and writer using the browser's own `CompressionStream` and `DecompressionStream`
  (`deflate-raw`) and a CRC-32: about 150 lines, no new dependency.
- **Option B:** [fflate](https://github.com/101arrowz/fflate) (MIT, about 8 kB gzipped), a widely used zip library.
  It handles details such as data descriptors and Unicode file names that a hand-written reader would have to get right.

### 16.5 Tests

- A pure module, `src/pack.ts`, plans the zip: template files in, files out, plus warnings. vitest drives it with a
  synthetic template made in the test, with no artwork.
- A zip round trip: assemble, unzip, and compare every file.
- Headless Edge: assemble with the samples and a synthetic template; the JSON, hero and atlas bytes in the zip must
  match the inputs.
- The developer's check: drop the zip into `resourcepacks/` and press F3 + T.

### 16.6 Decisions

1. **The current sky replaces the day layer's texture by default.** A dropdown can change it (day, night, both, none).
   *Later:* a menu at the top of the app will offer separate day and night skies, so a pack can get both at once.
2. **Zip code: fflate** (option B).
3. **Starter template: the developer's `NuitSkyTestPack_26_2.zip`**, generated earlier for this project and treated
   as trusted. It is used when no template has been uploaded. Before it is bundled, its textures are checked against
   rule 8 (section 16.7).
4. **The `cube2equi.py` follow-up is dropped.** The developer uses that script on its own; its panoramas load in the
   tool with Left edge −180.
5. **Audit of `cube2equi.py`** (for the record): its face table matches BRIEF §3, and its panoramas equal
   `sky_convert.py to-pano`'s shifted by 45° (north in the middle: left edge −180° instead of −135°), to within 1 per
   channel. It holds the whole panorama in memory (about 5.6 GiB for an 8192-wide output) and doesn't check that its
   input is 3:2.

### 16.7 The bundled starter template, and rule 8

The developer confirmed, and a look at the files agrees, that every texture in the template is a generated
placeholder: `night.png` and `day.png` are labelled 3:2 guide atlases (1024 px faces, elevation and bearing lines),
and `hero.png` is a 1063 × 1502 test card with a transparent window. So the starter is committed **as it is**, as
loose files in `reference/samples/starter_pack/` (readable in review), including its `README.txt`. Its `pack.mcmeta`
declares format 88 (`min_format`/`max_format`) for 26.2. Its sky layers already use `properties.blend`, not the old
top-level object. Vite bundles the files (`import.meta.glob(…, { query: '?url' })`); the tool fetches them only when
the starter is used. An uploaded template wins over the starter.

### 16.8 As built

- **`src/pack.ts`** reads templates (`readTemplate`), plans the new pack (`assemblePack`), and reads and writes zips
  (`readZip`, `writeZip`). It works on a `Map<string, Uint8Array>` of files and uses fflate 0.8.3 for the zip
  format. PNGs are stored as they are; text is deflated. A sky layer's role is decided by its fade: the always-on
  layer is **night**, a fading one is **day**.
- **`main.ts`** keeps the current sky's file (or the converted PNG) and the hero's own file, so they go in byte for
  byte. A JPEG or WebP is re-encoded to PNG from its pixels, because Minecraft only loads PNG textures. A `.zip`
  dropped anywhere becomes the template. The template and the "Sky goes to" choice are remembered (IndexedDB slot
  `pack`; `Session.packSky`). Reset goes back to the starter and the day layer.
- **UI:** a **Resource pack** section after the JSON panel, with the template picker (it also takes drops), its status,
  **Sky goes to** (Day layer, Night layer, Both layers, Neither), **Assemble pack (.zip)**, **Use the starter
  template** (shown while an upload is in use), and a report. The download is named `<template>_skybuilder.zip`.
- **Tests:** `tests/pack.test.ts` covers reading a template, every sky choice, a changed texture path, refusals, the
  zip round trip, and the real bundled starter (no warnings, format 88). `tests/saved.test.ts` covers `packSky`.
- **Checked in headless Edge:**
  - From the starter: the zip's file list equals the starter's. `sky3_image.json` equals the exported bytes, `hero.png`
    equals the loaded test card, and `day.png` equals the loaded atlas, all byte for byte. Everything else is unchanged.
  - Your template dropped on the page, a converted panorama, and **Both layers**: `night.png` and `day.png` are the
    same 1536 × 1024 converted PNG.
  - Texture `mine:textures/sky/girl.png`: the hero and its `.mcmeta` land there, with a warning that the old
    `hero.png` is unused.
  - A bad texture path is refused, and a red error is asked about first.
  - Every zip passes Python's CRC check.
  - After a reload, the uploaded template and "Both layers" come back.
- **Later** (decision 1): a menu at the top of the app for separate day and night skies. *Now planned as section 17.*

---

## 17. Sky tabs, with day/night blending (approved 2026-10-25, built on branch `sky-tabs`)

**Request:** separate day and night skies, blended by time of day as Nuit blends them, with editable fade keyframes.
They are organised as **tabs** (Day, Night, and later any number more, such as Sunrise or Sunset), and each tab has an
**Include** checkbox that decides which skies go into the assembled pack. This replaces the "Sky goes to" dropdown
(section 16.6, decision 1) and does the BRIEF §9 crossfade stretch goal in a general form. It also fixes a bug in
`pack.ts` (17.1).

### 17.1 Checked in the Nuit source (26.2/dev)

I read `components/Fade.java`, `skybox/AbstractSkybox.java` and `SkyboxManager.java`, in addition to the files in
section 1.

- **`Fade` has only `duration` (default 24000, at least 1) and `keyFrames`** (tick → alpha, each clamped to [0, 1]).
  The constructor **throws** if a keyframe is outside $[0, \text{duration})$, which makes the whole layer file fail to
  load. **There is no `alwaysOn` field.** The codec drops it silently, as it drops the old top-level `blend`.
- **Bug:** `pack.readTemplate` decides a sky layer's role from `fade.alwaysOn === true` ([pack.ts:84](../src/pack.ts#L84)).
  It works today only because the starter and the developer's pack still carry the ignored field. A clean 26.2
  template's night layer would be taken for a day layer. **Fix:** a layer is always on exactly when its `keyFrames`
  is empty, because that is what Nuit does (next point).
- **Alpha** (`AbstractSkybox.updateAlpha`, once per game tick): `alpha = fadeAlpha · conditionAlpha`.
  - Empty `keyFrames` gives `fadeAlpha = 1`: always on.
  - Otherwise `Utils.findClosestKeyframes` finds the keyframes on either side of the time, wrapping around the day,
    and `Utils.calculateInterpolatedAlpha` interpolates **linearly** between them (17.2). The time is
    `clock.getCycleTicks`, a whole number of ticks.
  - `conditionAlpha` eases between 0 and 1 over `transitionIn/OutDuration` ticks as the layer's conditions (weather,
    biome, effects and so on) start or stop holding. In the target environment (BRIEF §1) it sits at 1, so the
    preview takes it as 1.
- **Order and drawing** (`SkyboxManager.tick`, `renderSkyboxes`): layers with alpha 0 are dropped, and the rest are
  sorted by `layer` (lowest first) and drawn in that order. Nuit cancels the vanilla sky while it draws. A textured
  layer draws its texture times `ColorModulator = (1, 1, 1, alpha)` with the "normal" blend
  `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` (section 12).

### 17.2 The math

**Fade alpha** (`math.fadeAlpha`), a port of Nuit's two functions. The keyframes are $(k_j, a_j)$ with
$0 \le k_j < 24000$, and $T$ is the time in whole ticks ($T = \lfloor T_{\text{preview}} \rfloor$, as in Nuit):

1. No keyframes: $\alpha = 1$.
2. Find the keyframe at or before $T$, $k_c = \max\{k_j \le T\}$, and the first one after it,
   $k_n = \min\{k_j > T\}$.
3. If either doesn't exist ($T$ is before the first or after the last keyframe), wrap around the day:
   $k_c = \max_j k_j$ and $k_n = \min_j k_j$.
4. If $a_c = a_n$ or $k_c = k_n$ (a single keyframe), then $\alpha = a_n$.
5. Otherwise, the length of the span and how far into it $T$ is:
   - no wrap ($k_c < k_n$): $D = k_n - k_c$ and $\tau = T - k_c$;
   - wrap ($k_c > k_n$): $D = 24000 - k_c + k_n$, and $\tau = 24000 - k_c + T$ if $T < k_n$, else $\tau = T - k_c$.
6. $\alpha = a_c + \dfrac{\tau}{D}\,(a_n - a_c)$.

Worked example with the starter's day layer, keyframes $\{4000\!:\!1,\ 8000\!:\!1,\ 16000\!:\!0,\ 20000\!:\!0\}$, at
$T = 0$ (6 AM). No keyframe is at or before 0, so step 3 wraps: $k_c = 20000$ with $a_c = 0$, and $k_n = 4000$ with
$a_n = 1$. Then $D = 24000 - 20000 + 4000 = 8000$. Since $T < k_n$, $\tau = 24000 - 20000 + 0 = 4000$. So
$\alpha = 0 + \tfrac{4000}{8000}(1 - 0) = 0.5$.

**Blending.** The included tabs, in order, are layers $1 \ldots m$, with alphas $\alpha_1 = 1$ (the base) and
$\alpha_i = \text{fadeAlpha}_i(T)$. Write $S_i$ for a layer's texture colour and $s_i$ for its texture alpha. Each
layer is drawn over what is already there:

$$C_1 = s_1 S_1 + (1 - s_1)\,C_0, \qquad C_i = \alpha_i s_i\,S_i + (1 - \alpha_i s_i)\,C_{i-1}$$

where $C_0$ is whatever is behind the sky (Nuit: the cleared screen). For opaque atlases ($s_i = 1$) and two tabs,
this is $C = \alpha\,\text{Day} + (1 - \alpha)\,\text{Night}$, on the raw PNG values (section 11, decision 8).
The hero is the top layer, $m + 1$, always at alpha 1.

**One included tab** has no blending: it is the base, written with empty keyframes, and only spins.

### 17.3 Decisions (2026-10-25)

| # | Topic | Decision |
|---|---|---|
| 1 | Hero | **Shared** by all tabs: one `sky3_image.json`, always on. Several heroes stay a stretch goal. |
| 2 | A tab holds | A name, its sky (file, type, face size, left edge), its fade keyframes, and Include. |
| 3 | Layer order | Tab order is layer order. **The first included tab is the base**: always on, written with empty keyframes. Layer numbers are automatic: included skies 1…m in tab order, the hero m + 1 (its Layer box becomes a read-out). Tabs can be reordered, renamed and deleted, as long as one tab is left. |
| 4 | Keyframe editor | Rows of tick, clock time and alpha, with add and delete, and a small graph of alpha over the day. The duration is fixed at 24000. The base tab shows no editor. |
| 5 | A non-base tab with no keyframes | **Amber** warning: it is always on and hides every layer below it. New tabs start this way. |
| 6 | Template → tabs | Loading a template builds one tab per sky layer, with that layer's texture as its sky and its keyframes as their defaults. Anything you have set in a tab stays. |
| 7 | Excluded tabs | Their layer JSON, and their texture if nothing else uses it, are **removed** from the zip. |
| 8 | Writing sky layers | Keep every field of the template's layer, change only `texture`, `layer` and `fade.keyFrames`, and drop the ignored `fade.alwaysOn` and top-level `blend`. A new tab's layer is copied from the starter's day layer and named `sky<layer>_<tab>.json`, with its texture at `<template's sky folder>/<tab>.png`. |
| 9 | Included tab with no sky | **Amber** warning, and the default sky goes in (17.6). |
| 10 | Per-tab export | Each tab gets **Copy** and **Download** for its layer JSON. |
| 11 | Preview | **All, blended by time** (default) or **This tab only**. With one included tab, the preview shows that sky, just spinning. |
| 12 | Saving | No Save button. Switching tabs keeps that tab's edits and saves at once; everything is remembered across reloads, as now. |
| 13 | Old sessions | A remembered single sky becomes the Day tab's sky. |
| 14 | `alwaysOn` bug | Fixed as part of this feature (17.1). |

### 17.4 Tabs: the model (`src/tabs.ts`, pure, new)

```ts
export interface FadeKey { tick: number; alpha: number }   // like a Java record (int tick, float alpha)

export interface SkyTab {
  id: string;                    // stable, never shown: names IndexedDB slots ("sky:<id>")
  name: string;                  // "Night", "Day", "Sunrise"…; unique, case-insensitive
  include: boolean;
  sky: {
    source: 'user' | 'template' | 'default';   // where the preview's (and the pack's) atlas comes from
    name: string; type: SkyType; faceSize: number | null; leftBearingDeg: number;
  };
  keyFrames: FadeKey[];
  /** True once the user edits the keyframes; until then a new template's keyframes replace them (decision 6). */
  keyFramesEdited: boolean;
  /** The template layer this tab writes: its JSON path and texture path. Null for a tab the template doesn't have. */
  templateLayer: { file: string; texturePath: string | null; duration: number } | null;
}
```

Pure functions (no DOM, no Three.js; tested in `tests/tabs.test.ts`):

| Function | What it does |
|---|---|
| `tabsFromTemplate(info)` | One tab per sky layer, sorted by the layer's own `layer` value. Name from the file: `sky2_day.json` → strip `sky<digits>_` and `.json` → "Day" (or "Layer 2" if nothing is left). Keyframes from the file. Sky `source: 'template'`. |
| `mergeTemplate(tabs, info)` | For a newly loaded template: a tab whose name matches a template layer (case-insensitive) takes that layer's paths, and its keyframes too unless `keyFramesEdited`. A user sky stays `user`. Unmatched template layers become new tabs at the end; unmatched tabs stay, as new layers. |
| `layerPlan(tabs)` | The included tabs in order, each with its layer number $1\ldots m$ and whether it is the base, plus the hero's layer $m + 1$. |
| `slugify(name)` | A file-safe name for a new tab: lower case, spaces to `_`, only `[a-z0-9_-]`; empty → `sky<n>`. |
| `keyFrameProblems(keys)` | Per row: a tick that isn't a whole number in $[0, 24000)$, or a repeated tick, is **red** (Nuit would throw and the layer would not load); export and Assemble ask first, as for the hero's red errors. Alphas are clamped to [0, 1] as typed, as Nuit does. |
| `tabWarnings(tabs)` | Amber: a non-base included tab with no keyframes (decision 5), an included tab with no sky (decision 9), no included tabs (the vanilla sky shows behind the hero). |
| `layerJson(tab, plan, templateFiles)` | The tab's layer file as text (decision 8): the template's JSON with `texture`, `layer` and `fade.keyFrames` set (empty for the base) and `fade.alwaysOn` and the top-level `blend` removed; or, for a new tab, the starter's `sky2_day.json` with the same changes. Written with `JSON.stringify(…, null, 2)` plus a newline. |

Fade `duration`: the editor works in 24000-tick days. A template layer with another duration keeps its keyframes,
which are written with `duration: 24000` and an amber note. A keyframe at or past 24000 is a red row (17.4).

### 17.5 Preview (`scene.ts`)

- **One face set per tab.** `skyFaces` becomes one `Group` of six face meshes per tab, all inside `spinGroup`, built
  as now (`facePlacement`, cropped cells, nearest filtering, no colour conversion). The left-edge preview turn
  (section 13.7) turns only that tab's group.
- **Draw order.** Three.js draws all opaque meshes before all transparent ones, and sorts each list by `renderOrder`.
  So the base layer is opaque (`renderOrder` 0), the other layers are transparent with `renderOrder` $i$ and
  `opacity` $= \alpha_i$, and the hero and overlay move to `renderOrder` 1000 and 2000, above any number of tabs.
  `MeshBasicMaterial` with `opacity` α and `NormalBlending` (no premultiplied alpha) computes exactly
  $\alpha s\,S + (1 - \alpha s)\,C$, Nuit's "normal" blend with `ColorModulator (1, 1, 1, α)`. A layer at alpha 0 is
  hidden, as Nuit drops it. Every sky material has `depthTest` and `depthWrite` off.
- **Modes.** *All, blended by time:* the included tabs as in 17.2; excluded tabs are hidden, and if the open tab is
  excluded a note says so. *This tab only:* the open tab alone, opaque, plus the hero. With one included tab, both
  modes show it at alpha 1.
- `scene.setSkyLayers(layers: { id, alpha, opaque }[])` sets the order, alphas and visibility each time the time,
  tabs or mode change; `scene.setAtlas(id, image, faceSize)` and `scene.setSkyTurnDeg(id, Δ)` take a tab id.
- **The time readout** adds each included tab's alpha, e.g. `14:00 · θ 30.1° · Night 1 · Day 1.00 · the hero faces N 30° W`.
- **Memory.** Each tab keeps six face textures on the GPU (about 96 MB for 2048 px faces). Four such tabs are fine
  on a desktop. A deleted tab's textures are freed.

### 17.6 The default sky (decision 9)

An included tab with no sky of its own (no file, and no texture in the template) uses the starter's guide atlas:
`starter_pack/…/night.png` for the base tab, `day.png` for the others. Both are labelled 3:2 guide atlases with
1024 px faces and are already bundled (section 16.7). The preview shows the same atlas, so preview and pack agree.
The tab's status line and the pack report both say "using the default sky" (amber).

*This reads "the default sky template" in your answer as the starter's guide atlases. If you meant the plain
`placeholder_atlas.png`, it's a one-line change.*

### 17.7 UI

```
┌ Sky Builder ─────────────────────────── [Reset] ┐
│ [ Night ][ Day ][ + ]           ← tab strip     │
│ ┌ Day ─────────────────────────────────────────┐│
│ │ Name [Day      ]   [✓] Include in the pack   ││
│ │ Layer 2 · assets/nuit/sky/sky2_day.json      ││
│ │ Sky  [Auto ▾] [Choose file]  status…         ││
│ │      (face size, left edge, Download atlas)  ││
│ │ Fade                                         ││
│ │   ╭──────╮         ╭─ alpha over the day ─   ││
│ │   tick   clock  alpha                        ││
│ │   [4000]  10:00 [1.00] [×]                   ││
│ │   [8000]  14:00 [1.00] [×]   …               ││
│ │   [+ Add at the current time] [Template's]   ││
│ │ [Copy] [Download sky2_day.json]              ││
│ │ [◀ Move] [Move ▶]  [Delete tab]              ││
│ └──────────────────────────────────────────────┘│
│ Hero image, Hero, Readouts, Preview (+ mode),   │
│ sky3_image.json, Resource pack (as now)         │
```

- **Tab strip** at the top of the panel. A tab button shows its name, dimmed when excluded, and "base" on the first
  included tab. **+** adds a tab named "Sky 3", "Sky 4"… with only the essentials (no sky, no keyframes, Include on,
  default type and left edge; the hero and pack settings are shared anyway), and opens it. Tabs can be **dragged** to reorder; the
  Move buttons do the same from the keyboard. The page's file drop handling ignores these drags, since they carry no
  files. A tab strip like this is a set of `<button role="tab">` elements, much like a Swing `JTabbedPane`.
- **Tab content.** The existing Sky row (type, file, status, face size, left edge, Download atlas) moves in, unchanged
  apart from acting on the open tab. **Name** must be unique and non-empty. **Delete tab** asks first and is disabled
  for the last tab. For the base, the Fade area says "Base layer: always on, so it has no keyframes". A base that has
  keyframes keeps them, unused, for when it stops being the base.
- **Keyframe editor.** Rows sorted by tick; each tick box shows its clock time beside it. **Add at the current time**
  adds a row at the preview's tick, with the alpha the tab has there. **Template's** puts back the template layer's
  keyframes. The graph is a small inline SVG: the alpha sampled every 100 ticks, dots at the keyframes, and a line at
  the preview time. Red and amber problems show under the rows.
- **Per-tab export:** **Copy** and **Download `<file name>`** give `layerJson` for the open tab, after the same
  confirm as the hero when there is a red problem. An excluded tab has none, and says why.
- **Files section.** The Sky row leaves it; the Hero image row stays. The panel's hint and the Reset label change to
  "sky tabs and hero".
- **Output section.** The hero's **Layer** box becomes a read-out ("Layer 3: above the 2 included skies").
- **Preview section** gains **Show: All, blended by time / This tab only**.
- **Resource pack section.** "Sky goes to" is removed. A summary lists what the pack will hold, such as "Night
  (layer 1, base) · Day (layer 2) · hero (layer 3) · Sunrise: not included", with the amber warnings from
  `tabWarnings`.
- **Drops.** A sky image dropped anywhere goes to the **open tab**, and the note names it ("went to the Day tab's sky").

### 17.8 Pack assembly (`pack.ts`)

`assemblePack(template, inputs)` takes the tabs instead of `skyTarget`. For each tab, in order:

| Tab | Layer JSON | Texture |
|---|---|---|
| Included, from the template | `layerJson` at the template's path | User sky → its PNG at the template's texture path. Template sky → left as it is. |
| Included, new | `layerJson` at `assets/nuit/sky/sky<layer>_<slug>.json` | `<folder>/<slug>.png`: the user's PNG, or the default sky (17.6) |
| Excluded, from the template | removed | removed, unless another layer or the hero uses the same path |
| Excluded, new | nothing | nothing |

- `<folder>` is the folder of the base layer's template texture (`assets/sasheen/textures/sky/`). Without one, it is
  the hero texture's folder. A clash with a file already in the pack (including the hero's texture) adds `_2`, `_3`…
- The hero's JSON gets layer $m + 1$ through the normal JSON path (`state.hero.layer` is set by `layerPlan`). An
  imported, pinned JSON keeps its uvRange and mapping; only its layer changes (`editPinned`), with a note.
- Other Nuit layers in the template (decorations, monocolor, a second hero) are copied unchanged, with an amber note if
  their `layer` value falls among the renumbered ones.
- Existing warnings stay: rotation mismatch, top-level `blend` (now also "and it was removed"), atlas over 8192 px.
- Red keyframe problems (17.4) are asked about first, like the hero's red errors.
- **Bug fix (17.1):** `readTemplate` reports each sky layer's `layer` value and keyframes, and no longer reads `alwaysOn`.
  `SkyTarget` and `Session.packSky` are removed.

### 17.9 Saving (`saved.ts`, `imagestore.ts`, `main.ts`)

- **Settings:** a new key `sky-builder/v2` holds the hero, view, preview mode, open tab, and the tabs without their
  images. It is saved half a second after a change, as now, and **at once when you switch tabs** (decision 12).
- **Images:** IndexedDB slots become `sky:<tab id>`, plus `hero` and `pack` as now. Excluding a tab keeps its
  image; deleting the tab, or Reset, forgets it.
- **Migration (decision 13):** with no v2 entry, a v1 entry's hero, view and sky settings are read, and its stored
  `sky` image becomes the Day tab's sky. The other tabs come from the template (the remembered one, or the starter).
  `packSky` is dropped. The v1 key and slot are then deleted.
- **Start-up:** tabs from the saved settings, then each tab's image as it loads (panoramas re-convert, one worker per
  tab). Without saved settings: tabs from the starter (Night, base, and Day, both included), so the default preview
  at noon shows the starter's day guide atlas. `placeholder_atlas.png` is still the sample for M2-style checks: load it
  into a tab, or use This tab only.
- **Reset** returns to the starter's tabs and forgets every stored image and the template.

### 17.10 Tests

- `math.fadeAlpha`: the starter's keyframes at 0, 2000, 6000, 12000, 18000 and 22000 give 0.5, 0.75, 1, 0.5, 0 and
  0.25; empty gives 1; one keyframe is constant; unsorted input; a keyframe at tick 0; equal neighbours. Plus an
  **independent check**: for random keyframe sets, every 10 ticks matches a plain periodic linear interpolation (the
  keyframes repeated over three days), which shares no code with the port.
- `tabs.test.ts`: `tabsFromTemplate` on the starter (Night base, Day with its four keyframes), on a template **without**
  `alwaysOn` (the bug), and with layers in an odd file order; `mergeTemplate` keeping user skies and edited
  keyframes; `layerPlan` with exclusions and reordering; `slugify`; `keyFrameProblems`; `tabWarnings`; `layerJson` (only
  the three fields change, `alwaysOn` and top-level `blend` gone, base written with `{}`).
- `pack.test.ts`, rewritten for tabs: every row of the 17.8 table; one included tab; none; a shared texture kept; name
  clashes; the zip round trip; the starter with its default tabs gives an unchanged pack apart from the planned edits.
- `saved.test.ts`: v2 round trip, a damaged tab dropped field by field, and the v1 migration.
- `view.test.ts`: draw order and opacity for several tabs, opaque base, and modes.
- **Headless Edge**, as before: the starter's tabs at 6 AM, noon, 6 PM and midnight (Day alpha 0.5, 1, 0.5, 0); a
  panorama in a new Sunrise tab with keyframes; Include off/on and the pack's file list; per-tab Download bytes equal
  to the zip's; reload restores the tabs and images; a v1 session migrates.
- **Your check in game:** the assembled pack at `/time set 0`, `6000`, `12000` and `18000` against the preview at the
  same ticks.

### 17.11 Commits, on branch `sky-tabs`

1. `fix(pack)`: sky layer roles from empty `keyFrames`, not `alwaysOn`, with the test for a template without it.
2. `feat(math)`: `fadeAlpha`, with its tests.
3. `feat(tabs)`: the pure tab model and `layerJson`, with tests.
4. `feat(pack)`: assembly from tabs, with tests; `saved.ts` v2 and migration, with tests.
5. `feat(scene)`: one face set per tab, opacity and modes, with `view.test.ts`.
6. `feat(ui)`: the tab strip, tab content, keyframe editor and graph, preview mode, pack summary, and the wiring in `main.ts`.
7. `docs`: BRIEF (17.12), the as-built notes here, the README and its screenshots.

### 17.12 BRIEF changes (applied with commit 7, or first if you prefer)

- **§2:** the pack has one sky layer per included tab (the first is the always-on base; the rest fade by keyframes)
  and the hero on top; the tool now also writes the sky layer files.
- **§4:** a new **4.9 Fade and layer order**, from 17.1 and 17.2, citing `Fade.java`, `AbstractSkybox.updateAlpha` and
  `SkyboxManager`; and that `alwaysOn` isn't a 26.2 field.
- **§5:** the hero's `layer` is set automatically to $m + 1$.
- **§8:** sky inputs per tab; the keyframe editor; Include; per-tab export; the Layer box becomes a read-out; "Sky goes
  to" removed.
- **§9:** the crossfade moves from "Stretch" to required, for $n$ layers.
- **§10:** the day/night menu is done; several heroes stays a stretch goal.
- **§13:** the three Nuit files above.
- **§14:** a "Sky tabs" milestone with the checks in 17.10.

### 17.13 As built

**Where the code is.**
- `math.fadeAlpha` is the port of Nuit's fade.
- `src/tabs.ts` holds the pure tab model:
  - `mergeTemplate`, `layerPlan`, `effectiveKeyFrames`, `previewLayers`, `keyFrameProblems`, `skySource` and
    `tabNotes`;
  - `layerJson` and `layerOutputs`, which write the layer files.
- `pack.ts` has `assembleTabs`, and `readTemplate` now reports each sky layer's `layer` value, keyframes and duration,
  plus the template's other Nuit layers.
- `scene.ts` has `layerDrawSettings` (pure) and one face group per tab (`setSkyLayers`, `setAtlas(tabId, …)`,
  `setSkyTurnDeg(tabId, …)`, `removeSkyLayer`).
- `saved.ts` has v2 and `fromSavedV1`.
- `imagestore.ts` has the `sky:<tab id>` slots.
- The tab strip, panel, keyframe editor, graph, Show selector and pack summary are in `ui.ts` and `index.html`.
- `main.ts` has the per-tab sky state: its own file, load counter, converter, status, panorama options and
  pack PNG.

**Differences from the plan.**
- **Commit order.** Every commit builds and passes its tests. So `assembleTabs` first sat beside `assemblePack`,
  and `main.ts` showed its single sky as the only layer until the UI commit. That commit then removed
  `assemblePack`, `SkyTarget` and `Session.packSky`. `saved.ts` v2 moved into the UI commit too, because its
  `Session` type is tied to `main.ts`.
- **Template layers.** `readTemplate` keeps a sky layer's `role` (night or day, now from empty keyFrames) as a label.
  Nothing decides anything by it any more.
- **Restoring a session** links saved tabs to the remembered template's layers, by file and then by name, without
  adding a tab for a layer no tab takes. So a deleted tab stays deleted, while loading a template adds missing tabs
  (decision 6).
- **Keyframe edits** commit on Enter or when leaving the box, as the whole list. Alphas are clamped to [0, 1] and the
  rows re-sorted by tick. **Add at the current time** refuses a tick that already has a keyframe, with a note, rather
  than make a red duplicate.
- **"Use the template's sky" / "Use the default sky"** appears when a tab has its own sky, and forgets it.
- **Hero layer.** An imported JSON's layer is replaced by the tabs' hero layer, with an import note when it differs.
- **Shared names.** A new tab's file name uses its layer number at the time of writing (for example
  `sky2_sunrise.json` when Night is left out). It can share a `sky<n>_` prefix with another file
  (`sky3_image.json`); Nuit loads every file in the folder, so only the `layer` values matter.

**Checked in headless Edge** (fresh profiles, the dev server, files picked through the DevTools protocol):
- **The starter's tabs.**
  - Night (base) and Day open on the template's guide atlases.
  - The Day alpha reads 0.50, 1.00, 0.50 and 0.00 at 6 AM, noon, 6 PM and midnight.
  - The 6 AM view shows the two atlases half blended; midnight shows Night alone.
- **Editing keyframes.**
  - Setting Day's 4000 keyframe to 0.6 gives 0.80 at noon; **Template's** restores it.
  - Tick 24000 gives a red row and a red note.
- **A new tab.**
  - **+** makes "Sky 3" (layer 3) with both amber notes, and the hero moves to layer 4.
  - The name "Day" is refused.
  - Renamed "Sunrise" with keyframes {0: 0, 23000: 1}, it is at alpha 1 at 05:00.
- **Excluding Night.**
  - Day becomes "Layer 1, the base: always on", and its editor is hidden.
  - The preview note explains that the blend leaves Night out.
  - The hero goes to layer 3.
- **Per-tab Download** of Sunrise gives the starter day layer's fields with `texture`
  `sasheen:textures/sky/sunrise.png`, `layer` 2 and the two keyframes.
- **Assemble pack**, starter skies:
  - `sky1_night.json` and `night.png` are left out (with a note), and `sky2_day.json` has layer 1 and `{}`.
  - `sky2_sunrise.json` and a `sunrise.png` holding the default day atlas are added, and the hero is at layer 3.
- **Assemble pack**, the tabs' own skies:
  - Day's `placeholder_atlas.png` goes in byte for byte (49 469 bytes).
  - Sunrise's panorama, converted in its own worker in 0.5 s, goes in as its converted PNG.
- **Move**, **Delete**, **This tab only** and **Reset** behave as planned.
- **A reload** brings back the tabs, Include, the open tab, the keyframes, the time and both tabs' files (the
  panorama is converted again).
- **A v1 session** (a v1 entry and the old `sky` image) comes back with its sky as the Day tab's, typed `atlas`,
  under `sky:<id>`, and with the hero's ψ = 30. The v1 key and the `sky` slot are removed.
- No console errors throughout.

**Tests:** 214 in all, adding `fadeAlpha` (with the independent periodic check), `tabs.test.ts`, `assembleTabs`, the
blended draw order in `view.test.ts`, and v2 sessions with the v1 migration.

**In game (2026-10-25):** the developer's check passed. An assembled pack matched the preview at `/time set 0`, `6000`,
`12000` and `18000`.

**UI text trimmed (2026-10-25, at the developer's request):**
- **Removed:** the explanatory hints (sky tabs, Files, remembered settings, the noon-bearing line under Turn ψ, the
  hero's layer read-out and the Resource pack intro), and the status line for a template or default sky.
- **Shortened:**
  - the tab's layer line, to `Layer 1 (base): <file>`;
  - the overlay checkbox, to "Toggle overlay";
  - the starter's template line.
- **Separators:** the `·` separator in UI text is replaced by `/` throughout: statuses, the time line, the HUD,
  readouts and the overlay's face labels. An example is `noon.png/2304 × 1536/faces 768 px`, and the time line ends in
  `/hero facing north`.

---

*Sources checked:* the Nuit 26.2/dev files listed above, plus `Fade.java`, `AbstractSkybox.java` and
`SkyboxManager.java` for section 17; vanilla 26.2 `data/minecraft/timeline/day.json` via
[misode/mcmeta](https://github.com/misode/mcmeta/blob/26.2-data/data/minecraft/timeline/day.json); Minecraft Wiki,
[Environment attribute](https://minecraft.wiki/w/Environment_attribute) and [Timeline](https://minecraft.wiki/w/Timeline);
three r186 (installed) for the Euler check.
