# Sky Builder: implementation plan

Status: **M1 done (2026-10-08), on branch `m1-math`.** Math, JSON and face tests pass (`npx vitest run`). Next: M2.
Decisions are in section 11.

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
  main.ts        creates state, wires ui -> state -> json -> scene, owns the render loop
tests/
  math.test.ts   test vectors §7, scaling, inverse, round trip, spin, constraints
  json.test.ts   byte-for-byte §5 for case 3, import/parse cases
  faces.test.ts  Nuit face matrices vs our face table; hero placement (uses three, not the DOM)
```

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
   so image row 0 is at $t = +1$ as §3 requires. `ClampToEdgeWrapping`, `MeshBasicMaterial`, `depthWrite: false`.
   No `CubeTexture` and no `scene.background`.
5. Colour: every texture uses `colorSpace = NoColorSpace`, and the renderer uses
   `outputColorSpace = LinearSRGBColorSpace`. Nothing is converted, so blending happens on the raw
   (gamma-encoded) PNG values, as in Minecraft.

### Hero

`uvRangeToFaceRect(json…uvRange)` gives $s_0, s_1, t_0, t_1$. A `PlaneGeometry(s_1 - s_0,\ t_1 - t_0)` is
translated to $\left(\tfrac{s_0+s_1}{2},\ \tfrac{t_0+t_1}{2},\ -1\right)$. It already faces +z, toward the camera, so no extra
rotation is needed. Full-image texture, `transparent: true`, `depthTest: false`, `renderOrder: 10`.
The hero is redrawn only when `applyJson` sees a changed uv or mapping.

### Camera and look controls (`view.ts`)

`camera.rotation.set(pitch, yaw, 0, 'YXZ')`. Three.js yaw is counter-clockwise from above, so
"compass bearing clockwise from north" $\phi$ maps to `yaw = −φ`. Dragging right increases $\phi$.
Pitch is clamped to ±89°. "Look at hero" computes the hero centre's world direction
$\mathbf d = \text{Spin}\cdot M\cdot(0, t_c, -1)$ and sets $\phi = \operatorname{atan2}(d_x, -d_z)$, pitch $= \arcsin(d_y/|\mathbf d|)$.
FOV is **vertical** in both Three.js and Minecraft, so the slider value is passed through as is.

### Verifying orientation with `placeholder_atlas.png` (M2)

1. Automated: `faces.test.ts` (section 4) proves the table equals Nuit's matrices.
2. Visual checks from BRIEF §14 M2 (north centred, W left, E right; TOP shows S at the top at pitch +89°;
   turning right goes E → S → W with continuous horizon lines and matching edge letters).
3. An optional overlay draws the cube edges and face labels from the table itself, independent of the
   texture, so a texture/table mismatch shows up as a label disagreeing with the painted letters.
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
- The atlas loader checks $2W = 3H$ exactly and rejects anything else with the actual size in the message. It warns if
  $W \bmod 3 \ne 0$. The default atlas is `reference/samples/placeholder_atlas.png`, bundled through a Vite asset import.
- Images load through `URL.createObjectURL`. Nothing leaves the browser.
- Warnings appear inline next to readouts (amber at 0.95, red at 1.0 or the zenith).

---

## 9. Milestones (BRIEF §14, adjusted)

| | Contents | Acceptance |
|---|---|---|
| **M1 Math** | `npm i -D vitest`; add `"strict": true` to tsconfig (the scaffold omits it); `constants.ts`, `math.ts`, `schema.ts`, `json.ts`; the three test files | `npx vitest` green: all 7 vectors, case 3 byte-identical, face matrices match Nuit |
| **M2 Sky** | remove scaffold (counter, assets, style); `vite.config.ts` with `base: '/sky-builder/'`; `scene.ts` sky cube; `view.ts` drag-look; overlay | BRIEF M2 visual checks |
| **M3 Hero** | hero from JSON, `ui.ts` hero controls, readouts, warnings, wall-mode toggle (its math is done in M1) | BRIEF M3 check at T = 6000 |
| **M3½ In-game check** | *You* run section 10 (about 5 minutes); I flip `SIGN_MAPPING_Y` if needed | Y sign confirmed |
| **M4 Time and I/O** | time slider, play/pause, spin; Copy and Download; mcmeta; import (pinned, aspect warning) | export → import → export identical |
| **M5 Polish** | drag-and-drop; `localStorage` (view and hero params, try/catch); Pages build; README with screenshots | `npm run build` + `vite preview` at `/sky-builder/` |
| *After M5* | day/night crossfade (`fadeAlpha`); several heroes (one layer file each) | |

Each milestone is a small series of commits. I stop after each one with a summary and test steps.

The BRIEF has already been updated for the decisions in section 11 (on 2026-10-04): the name, §1 target
environment, §3, §4.5–4.7, §6.1, §7, §8, §9 colour, §10, §11, §12 status, §13 vanilla data source, and §14 M3.

---

## 10. In-game checks (for M3½)

Only two things are left that the source can't settle. Both use the working pack in a creative world.

**A. Sign of mapping Y** (BRIEF §12.2)

1. In `sky3_image.json`, change `"mapping": {"0": [22.47, 0.0, 0.0]}` to `[22.47, 30.0, 0.0]`.
2. In game, press **F3+T** to reload resource packs, then run `/time set noon`.
   Near noon the sky turns only about 0.2° per second, so there is no need to stop time.
3. Press **F3** and turn until the "Facing" line says **north**, with the yaw near 180 or −180. Look up a little.
4. Prediction: the hero is **to the left** of the crosshair (west), about 30° off centre, so its centre is at yaw ≈ 150.
   - Hero on the left: the source reading is right, and nothing changes.
   - Hero on the right (yaw ≈ −150): tell me, and I flip `SIGN_MAPPING_Y` to −1.
5. Put mapping Y back to `0.0` and press F3+T again.

Optional sanity check of the spin: with Y = 0, `/time set 18000` (midnight) should put the hero due **south**.

**B. `hero.png.mcmeta`** (BRIEF §12.5)

Look at the hero through a **spyglass**, which magnifies it enough to see individual texture pixels. Then
temporarily rename `hero.png.mcmeta` and press F3+T. If the image goes from smooth to blocky, crisp pixels,
the file is being applied (`blur: true` means smooth filtering). If nothing changes, it isn't, and the tool's mcmeta
download is harmless but unnecessary.

---

## 11. Decisions (2026-10-04)

| # | Topic | Decision |
|---|---|---|
| 1 | Mapping X sign | **Closed.** `SIGN_MAPPING_X = +1`. The source agrees with the running config, so no further in-game test is needed. |
| 2 | Mapping Y sign and UI | The slider is the **raw mapping Y** (positive = west), with a noon-bearing readout. `SIGN_MAPPING_Y = +1`, pending check A in section 10. |
| 3 | Spin | **Vanilla 26.2 curve** (cubic Bézier from `day.json`), with no linear option. Target: plain Nuit and vanilla 26.x, no datapacks. Time defaults to 6000. |
| 4 | Bottom face | **Closed** (source-verified, §1.4). |
| 5 | mcmeta | Keep the download; check B in section 10. |
| 6 | Scope | Wall mode in M3; crossfade after M5. |
| 7 | Name | **sky-builder** everywhere; Pages `base: '/sky-builder/'`. |
| 8 | Colour | No colour conversion (`NoColorSpace` + `LinearSRGBColorSpace`), matching Minecraft's gamma-space blending. |
| 9 | Import | Pin the imported JSON. If the loaded image's aspect differs from the uvRange by more than 1%, **warn only**. |
| 10 | BRIEF edits | Applied. |

---

*Sources checked:* the Nuit 26.2/dev files listed above; vanilla 26.2 `data/minecraft/timeline/day.json` via
[misode/mcmeta](https://github.com/misode/mcmeta/blob/26.2-data/data/minecraft/timeline/day.json); Minecraft Wiki,
[Environment attribute](https://minecraft.wiki/w/Environment_attribute) and [Timeline](https://minecraft.wiki/w/Timeline);
three r186 (installed) for the Euler check.
