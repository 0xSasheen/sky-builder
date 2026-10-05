# Sky Builder: project brief

This is the full specification. `CLAUDE.md` holds the short version of the
rules; this file explains why they exist and everything the tool needs to do.

---

## 0. Your first task: plan, don't code

1. Read this entire brief, `CLAUDE.md`, and every file in `reference/`.
2. Inspect the repo: it is a fresh Vite `vanilla-ts` scaffold with `three` and
   `@types/three` installed.
3. Fetch the Nuit source files listed in §13 and confirm the facts in §4 for
   yourself. Note anything that disagrees with this brief.
4. Write `docs/PLAN.md` containing:
   - the architecture: modules, what each exports, and how data flows between them
   - the type definitions for the JSON schema (§5) and the tool's state
   - the API of `src/math.ts`, and how each test vector (§7) maps to a test
   - how the sky cube and hero quad are built (§9), including how you will
     verify orientation with `reference/samples/placeholder_atlas.png`
   - the milestones (§14), adjusted if you think they should be
   - your questions, including anything in §12 you need decided
5. **Stop.** Do not write source code until the plan is approved.

---

## 1. Goal

The developer makes custom skies for Minecraft Java 26.2 using the **Nuit**
mod. A "hero" image (usually anime character art) is placed in the sky as its
own layer, and its position is controlled by numbers in a JSON file. Today,
each new position means working the math out by hand, editing JSON, reloading
the game, and checking.

The tool replaces that loop:

1. Load the sky atlas and the hero image. The hero's pixel size is read automatically.
2. Move sliders for size, height and compass direction.
3. See a live first-person preview of the sky and hero.
4. Copy or download the finished `sky3_image.json`.

The preview must agree with the game. That is the whole value of the tool.

**Target environment:** plain Nuit on Minecraft Java 26.x with vanilla data. Don't
assume the user has anything else installed: no datapacks that change timelines,
no shader packs, no other sky mods.

---

## 2. Background: how the sky pack works

The resource pack has three sky layers, drawn in order of `layer` number:

| File | Layer | Type | What it is |
|---|---|---|---|
| `sky1_night.json` | 1 | `nuit:square-textured` | Night sky atlas. Always on, so it's the opaque base |
| `sky2_day.json` | 2 | `nuit:square-textured` | Day sky atlas. Fades in and out on top of night by time of day |
| `sky3_image.json` | 3 | `nuit:multi-textured` | The hero. **This is the file the tool generates** |

All three rotate together, once per in-game day, around the vertical axis.
Their `rotation` blocks must be identical **except for `mapping`**, which only
the hero layer changes. Working copies are in `reference/pack-example/`.

Textures live at `assets/sasheen/textures/sky/` and are referenced as
`sasheen:textures/sky/<name>.png`. The JSON files live at `assets/nuit/sky/`.

**The sky atlas** is one image split into a 3 × 2 grid of square cube faces:

```
+--------+--------+--------+
| Bottom |  Top   | South  |   row 0
+--------+--------+--------+
|  West  | North  |  East  |   row 1
+--------+--------+--------+
  col 0    col 1    col 2
```

**Why one face:** each cube face is a flat square wall. An image drawn inside
one face needs no warping; the camera's perspective handles everything.
`multi-textured` draws the hero inside a rectangle (`uvRange`) of this atlas
grid. The tool always puts the hero in the **North** cell, then aims it with
`mapping`: X tilts it up to an elevation, and Y turns it to a compass
direction. Tilting the face makes it face the player, like a billboard.

---

## 3. Geometry and conventions

### World axes
+x = east, +y = up, −z = north. This is right-handed with y up, the same as
Minecraft and Three.js. A default Three.js camera looks down −z, which is north.

### Atlas UV
u ∈ [0, 1] spans the three columns left to right. v ∈ [0, 1] spans the two
rows **top to bottom (V = 0 is the top)**. Cell (col, row) covers
$u \in [\tfrac{col}{3}, \tfrac{col+1}{3}]$ and $v \in [\tfrac{row}{2}, \tfrac{row+1}{2}]$.

### Face table
For a face with centre $\mathbf{c}$, image-right $\mathbf{r}$ and image-up
$\mathbf{u}$, a point at normalised face coordinates $s$ (right) and $t$ (up),
both in $[-1, 1]$, lies at $\mathbf{c} + s\,\mathbf{r} + t\,\mathbf{u}$.

| Face | Cell | Centre $\mathbf{c}$ | Right $\mathbf{r}$ | Up $\mathbf{u}$ |
|---|---|---|---|---|
| bottom | (0, 0) | (0, −1, 0) | (1, 0, 0) | (0, 0, −1) |
| top | (1, 0) | (0, 1, 0) | (1, 0, 0) | (0, 0, 1) |
| south | (2, 0) | (0, 0, 1) | (−1, 0, 0) | (0, 1, 0) |
| west | (0, 1) | (−1, 0, 0) | (0, 0, −1) | (0, 1, 0) |
| north | (1, 1) | (0, 0, −1) | (1, 0, 0) | (0, 1, 0) |
| east | (2, 1) | (1, 0, 0) | (0, 0, 1) | (0, 1, 0) |

This is the table from `reference/sky_convert.py`. It was verified against a
real atlas (the side faces form a seamless ring and the top face lines up with
all four), and **all six rows, including the bottom face**, were verified against
Nuit's `Utils.MATRIX4F_ROTATED_FACE`, which both `SquareTexturedSkybox` and
`MultiTexturedSkybox` use (see PLAN §1.4). A unit test keeps it checked.

Within a cell, image row 0 (the top of the cell) is $t = +1$, and the left
column is $s = -1$.

### Elevation
A point on the north face at height $t$ on the centre line sits at elevation
$\arctan t$. The horizon is $t = 0$, and the face's top edge is 45° up at its centre.

### Time
24 000 ticks = 1 in-game day. Tick $T$ is clock hour $(6 + T/1000) \bmod 24$:
tick 0 = 6 AM, 6000 = noon, 12 000 = 6 PM, 18 000 = midnight. (The Nuit wiki's
conversion table has AM and PM swapped; ignore it.)

---

## 4. How Nuit 26.2 renders a `multi-textured` layer

Confirmed by reading the source (§13), and re-checked during planning (PLAN §1).

1. **Placement.** For each of the 6 faces, the renderer intersects each
   texture's `uvRange` with that face's cell (`Utils.TEXTURE_FACES`). It maps
   the overlap linearly onto the face's quad and draws that part of the texture
   there. Everything outside every `uvRange` is empty (transparent).
2. **Consequence:** a `uvRange` that crosses a cell boundary gets split across
   two faces and visibly bends at the cube edge. The tool must keep the hero
   inside the North cell.
3. **Orientation.** The texture is drawn upright: its top-left corner goes at
   the top-left of its rectangle, with the same orientation as `square-textured`.
4. **Blend.** `properties.blend` is a plain string (`"normal"`, `"add"`,
   `"screen"`, …). The default is `normal` for textured skies. A PNG's alpha is
   respected, so cut-out heroes work.
5. **Rotation.** `rotation.axis` and `rotation.mapping` are **Euler angles in
   degrees** (keyframed by tick), converted to quaternions. The final rotation is

   $$R = Y(\text{time}) \cdot M_{\text{mapping}}$$

   so `mapping` is a fixed, per-layer rotation applied **before** the daily
   spin. Changing `mapping` on the hero layer alone moves the hero relative to
   the clouds, and it stays there as everything spins. With `axis` = [0, 0, 0]
   the spin is about +y. **The spin is applied only if `axis` has at least one
   keyframe**, so the tool must always write `axis`.
6. **Mapping order.** The mapping quaternion is built as
   `rotateLocalX(x).rotateLocalY(y).rotateLocalZ(z)` starting from identity,
   giving $M = R_z R_y R_x$: X is applied first, then Y, then Z. Three.js Euler
   order `'ZYX'` produces exactly the matrix $R_z R_y R_x$. Verified against
   `Rotation.java` and numerically against three r186. Signs: $+X$ tilts the
   North face up and $+Y$ turns it toward west. Both follow from JOML and
   Three.js sharing the same right-handed convention.
7. **Spin.** With `skyboxRotation: false`, Nuit does **not** use `speed` as a
   rate. Any non-zero `speed` makes the layer follow vanilla's sun angle:
   $\theta(T)$ = the `minecraft:visual/sun_angle` environment attribute, in
   degrees, applied as $Y(+\theta)$. (`speed: 0` disables the spin; only
   `skyboxRotation: true` gives an even $\text{speed}\cdot 360°\cdot T/24000$.)
   In vanilla 26.2 (`data/minecraft/timeline/day.json`), `sun_angle` runs from
   0° at tick 6000 (noon) to 360° one day later, eased by
   `cubic_bezier [0.362, 0.241, 0.638, 0.759]`:

   $$p = \operatorname{frac}\!\left(\frac{T - 6000}{24000}\right), \qquad
   \theta(T) = 360° \cdot \operatorname{bezier}(p)$$

   where $\operatorname{bezier}$ is a CSS-style cubic Bézier: solve
   $x(s) = p$, then return $y(s)$. This matches the pre-timeline vanilla
   formula to within 0.06°. Key values: θ(0) ≈ 282.4°, θ(6000) = 0°,
   θ(12000) ≈ 77.6°, θ(18000) = 180°. So with mapping Y = 0, the hero is due
   north at noon, about 78° east of north at tick 0, and due south at midnight.

---

## 5. Output: `sky3_image.json` (exact format)

```json
{
  "schemaVersion": 1,
  "type": "nuit:multi-textured",
  "properties": {
    "layer": 3,
    "blend": "normal",
    "fade": { "duration": 24000, "keyFrames": {} },
    "rotation": {
      "speed": 1.0,
      "mapping": {"0": [22.47, 0.0, 0.0]},
      "axis": {"0": [0.0, 0.0, 0.0]},
      "skyboxRotation": false
    },
    "sunSkyTint": false,
    "visibleUnderwater": true
  },
  "conditions": {
    "worlds": {"entries": ["minecraft:overworld"]}
  },
  "animatableTextures": [
    {
      "texture": "sasheen:textures/sky/hero.png",
      "uvRange": {"minU": 0.4249, "minV": 0.5909, "maxU": 0.5751, "maxV": 0.9091},
      "gridColumns": 1,
      "gridRows": 1
    }
  ]
}
```

Rules:

- Round `uvRange` values to **4 decimal places** and `mapping` to **2**.
- **Render the preview from the rounded values**, so the preview matches the
  game exactly.
- Editable fields: `texture`, `layer`, `mapping` (X and Y; Z stays 0) and `uvRange`.
- Everything else stays fixed, especially `speed`, `axis` and `skyboxRotation`,
  which must match the sky layers.
- Empty `keyFrames` means always visible. `conditions.worlds` is a legacy alias
  that 26.2 accepts; it's what the working pack uses, so keep it.
- Also offer `hero.png.mcmeta` for download, containing:
  `{"texture": {"blur": true, "clamp": true}}`

---

## 6. The math

Inputs: hero size $W \times H$ in pixels, angular height $\beta$ (degrees),
bottom-edge elevation $b$ (degrees), compass turn $\psi$ (degrees).

### 6.1 Tilted mode (the default, and what the pack uses now)

The hero is centred on the North face, then tilted up by mapping X.

1. Aspect ratio: $a = W / H$.
2. Half-height on the face: $k = \tan(\beta/2)$. Half-width: $a k$.
3. Convert face coordinates to atlas UV inside the North cell:
   $u = \tfrac13 + \tfrac{s+1}{6}$ and $v = \tfrac12 + \tfrac{1-t}{4}$.
4. The hero spans $s \in [-ak, ak]$ and $t \in [-k, k]$, which gives

$$\text{minU} = \tfrac13 + \tfrac{1-ak}{6}, \qquad \text{maxU} = \tfrac13 + \tfrac{1+ak}{6}$$

$$\text{minV} = \tfrac12 + \tfrac{1-k}{4}, \qquad \text{maxV} = \tfrac12 + \tfrac{1+k}{4}$$

   (minV comes from the top edge, $t = +k$, because V = 0 is the top.)

5. Tilt so the bottom edge lands at elevation $b$. The centre sits at
   $b + \beta/2$, so mapping X $= b + \tfrac{\beta}{2}$.
6. Mapping Y $= \psi$. The ψ slider is the raw mapping Y value (positive turns
   the hero toward west); a readout shows the resulting compass direction at
   noon. The preview applies it with the sign constant from `src/constants.ts`.
7. Derived readouts: angular width $= 2\arctan(ak)$; top-edge elevation $= X + \beta/2$.

**Scaling by a factor $f$** (for "×1.15"-style buttons) multiplies $k$, not
$\beta$: $k' = f k$, $\beta' = 2\arctan(k')$. Recompute X from the new $\beta'$.

**Constraints, shown as warnings in the UI:**
- $k \le 0.95$ and $ak \le 0.95$. Past this, the hero is too close to spilling
  into a neighbouring cell. The hard limit is 1.0.
- Top edge $X + \beta/2 < 90°$, or the hero tips over the zenith.
- Bottom edge below 0° is allowed. That part is hidden by terrain in most
  places, but shows over oceans and from mountaintops.

### 6.2 Wall mode (optional; stretch goal)

Mapping X = 0. The hero stands upright on the North wall, off-centre.

1. $t_b = \tan b$; the top is $t_t$ (default 0.95). Height $h = t_t - t_b$.
2. Half-width $s = h a / 2$.
3. $\text{minU} = \tfrac13 + \tfrac{1-s}{6}$, $\text{maxU} = \tfrac13 + \tfrac{1+s}{6}$,
   $\text{minV} = \tfrac12 + \tfrac{1-t_t}{4}$, $\text{maxV} = \tfrac12 + \tfrac{1-t_b}{4}$.

### 6.3 Inverse (for importing a JSON, and for rendering)

From any `uvRange` inside the North cell:

$$s = 6\left(u - \tfrac13\right) - 1, \qquad t = 1 - 4\left(v - \tfrac12\right)$$

The renderer uses this to build the hero quad **from the JSON**, which keeps
the preview identical to what Nuit draws, in any mode. Importing a JSON uses
it to recover the slider values: in tilted mode $k = 2(\text{maxV} - \text{minV})$
and $b = X - \beta/2$.

---

## 7. Test vectors

These are in `reference/test-vectors.json`. Every case must pass to the stated
precision. Image sizes are $W \times H$.

| Case | Inputs | minU | minV | maxU | maxV | X |
|---|---|---|---|---|---|---|
| 1 | 1063×1502, β = 40.5°, b = 3° | 0.4565 | 0.6578 | 0.5435 | 0.8422 | 23.25 |
| 2 | 1063×1502, k = 0.5534, b = −15° | 0.4347 | 0.6117 | 0.5653 | 0.8883 | 13.96 |
| 3 ★ | 1063×1502, k = 0.6364, b = −10° | 0.4249 | 0.5909 | 0.5751 | 0.9091 | 22.47 |
| 4 | 1063×1502, k = 0.8301, b = −5° | 0.4021 | 0.5425 | 0.5979 | 0.9575 | 34.70 |
| 5 | 1063×1502, β = 60°, b = 0° | 0.4319 | 0.6057 | 0.5681 | 0.8943 | 30.00 |
| 6 | wall, 1063×1502, b = 3°, $t_t$ = 0.95 | 0.4471 | 0.5125 | 0.5529 | 0.7369 | 0 |
| 7 | wall, 3396×4000, b = 3°, $t_t$ = 0.95 | 0.4365 | 0.5125 | 0.5635 | 0.7369 | 0 |

★ Case 3 is the configuration **currently running in game and confirmed to
look right**. Cases 2–4 come from repeated scaling: from case 1, scale ×1.5,
then ×1.15 or ×1.5. In the file, `k` values are given unrounded; use them as-is.
**Drive cases 2–4 from `k`, not `heightDeg`:** for case 4, the rounded
`heightDeg` (79.39) gives X = 34.695 exactly, a rounding tie, while `k` gives
34.695014, which rounds to 34.70.

---

## 8. Functional requirements

### Inputs
- **Sky atlas:** file picker plus drag-and-drop. Must be 3:2; reject anything
  else with a clear message. Default to `reference/samples/placeholder_atlas.png`.
- **Hero image:** file picker plus drag-and-drop. Read its width and height
  automatically, with manual override fields. Respect alpha.
- Everything runs locally in the browser. Use object URLs; never upload anything.

### Controls
Each slider has a linked number box, and the two stay in sync.

| Control | Range | Default | Notes |
|---|---|---|---|
| Angular height β | 5°–87° | 40.5° | Or edit k directly |
| Scale buttons | ×1.15, ×1.5, ÷1.15, ÷1.5 | – | Multiply **k** (§6.1) |
| Bottom elevation b | −30° to 60° | 3° | |
| Compass ψ (mapping Y) | −180° to 180° | 0° | Raw mapping Y; positive = toward west |
| Mode | tilted / wall | tilted | Wall mode ships in M3 |
| Time of day | 0–23 999 ticks | 6000 (noon) | **Preview only.** Shows clock time and θ. Play/pause. At noon θ = 0, so the hero sits exactly where the sliders say |
| Camera FOV | 30–110 | 70 | Minecraft's default is 70 |
| Texture path | text | `sasheen:textures/sky/hero.png` | |
| Layer | integer | 3 | |

### Readouts
$a$, $k$, $ak$, angular height and width, top and bottom elevations, distance
to each constraint limit, and warnings when a §6.1 constraint is broken.

### Outputs
- A live JSON panel, with Copy and Download (`sky3_image.json`).
- Download for `hero.png.mcmeta`.
- Import: paste or load an existing `sky3_image.json` and recover the slider
  values (§6.3).

---

## 9. Rendering requirements

- **Camera** fixed at the origin; drag to look (yaw and pitch, pitch clamped to
  ±89°). Use camera Euler order `'YXZ'` for look controls. That is unrelated to
  rule 4, which is about Nuit's mapping. Add buttons for "look at hero" and
  "look north at the horizon".
- **Sky cube:** build six `PlaneGeometry(2, 2)` quads from the face table (§3).
  Each is centred at $\mathbf{c}$, its local x axis along $\mathbf{r}$ and its
  local y axis along $\mathbf{u}$, facing inward. Texture each one with its
  cell cropped from the atlas onto a canvas, so nothing bleeds between cells.
  Use `ClampToEdgeWrapping`, `MeshBasicMaterial`, and `depthWrite: false`.
  **No colour conversion:** textures use `NoColorSpace` and the renderer uses
  `outputColorSpace = LinearSRGBColorSpace`, so blending happens in gamma space
  as it does in Minecraft. This matters for semi-transparent hero edges and the
  crossfade. **Do not use `CubeTexture` or `scene.background`**:
  their conventions differ, and the face table is already verified.
- **Hero:** a `PlaneGeometry` built with the inverse map (§6.3) from the
  rounded JSON `uvRange`. It lies on the plane z = −1 (the North face), facing
  +z toward the camera. Put it inside a `heroGroup` whose rotation is
  `new Euler(sx·X°, sy·Y°, 0, 'ZYX')` in radians, where sx and sy are the sign
  constants. Use `transparent: true`, `depthTest: false`, and a `renderOrder`
  above the sky.
- **Spin:** put the sky planes and `heroGroup` together in a `spinGroup` whose
  y rotation is $+\theta(T)$ from §4.7. The world transform is then
  $\text{Spin} \cdot M \cdot \mathbf{v}$, matching §4.5.
- **Optional:** a toggle overlay that draws face edges and labels.
- **Stretch:** day and night atlases with a crossfade preview using the day
  layer's keyframes (4000 → 1, 8000 → 1, 16 000 → 0, 20 000 → 0, linear,
  wrapping round), with night always on underneath.

---

## 10. Non-goals

- Converting panoramas to atlases. `reference/sky_convert.py` already does that.
- Editing the sky atlases themselves.
- Any server or backend. The tool is a static site.

**Stretch goals (after M5):** day/night crossfade preview; several heroes (each
would be its own layer file, since `mapping` is per layer); remembering the
last settings in `localStorage`.

---

## 11. Tech and repo

- Vite `vanilla-ts`, TypeScript `strict`, `three` + `@types/three`.
- Tests: `vitest` (add it with `npm i -D vitest`).
- The repo and the site are named **sky-builder**. `vite.config.ts` must set
  `base: '/sky-builder/'` for GitHub Pages.
- `reference/private/` is git-ignored (done).
- `tsconfig.json` must set `"strict": true` (the scaffold omits it).
- Suggested layout (adjust it in the plan if you have a better one):

```
src/
  constants.ts   sign constants, defaults, limits
  math.ts        pure functions (§6), no imports from three or the DOM
  schema.ts      TypeScript types for the JSON (§5)
  json.ts        build, parse and validate sky3_image.json
  scene.ts       Three.js: sky cube, hero, spin, camera
  ui.ts          controls, readouts, file loading, import and export
  main.ts        wiring
tests/
  math.test.ts   drives the cases in reference/test-vectors.json
```

---

## 12. Open questions and unverified facts

Raise these in the plan. Don't guess silently. Status as of 2026-10-04:

1. **Sign of mapping X.** ✅ Closed. Positive X tilts the North face **up**. The
   source says so, and the running config (X = +22.47, hero above the horizon)
   confirms it in game.
2. **Sign of mapping Y.** ⏳ Source says positive Y turns the hero toward the
   **west**. Awaiting one in-game check (PLAN §10).
3. **Spin direction and phase.** ✅ Closed from source and vanilla 26.2 data;
   see §4.7.
4. **Bottom face orientation.** ✅ Closed from source; see §3.
5. **Whether Minecraft applies `hero.png.mcmeta`.** ⏳ Not settled by the
   source. Keep the download; check in game (PLAN §10).
6. **Scope.** ✅ Wall mode ships in M3. The crossfade waits until after M5.

---

## 13. Reference index

### In the repo (`reference/`)

| File | What it is |
|---|---|
| `test-vectors.json` | §7 as data, for the tests |
| `samples/placeholder_atlas.png` | Labelled 3 × 2 atlas (512 px faces) with UP markers, horizon lines, and the neighbouring compass letters on each edge. Use it to check orientation |
| `samples/test_hero_1063x1502.png` | Grid test card at the hero's real size, marked TOP, BOTTOM, L and R |
| `pack-example/assets/nuit/sky/*.json` | The three working layer files. Note: `sky1`/`sky2` still have the old top-level `"blend"` object, which 26.2 ignores |
| `pack-example/.../hero.png.mcmeta` | The filtering metadata |
| `sky_convert.py` | Atlas ↔ panorama converter. Source of the face table in §3 |
| `place_billboard.py` | Earlier panorama-based method, kept for reference only |
| `private/` | Git-ignored. Put real sky textures and hero art here for local testing |

### Nuit 26.2 source

The docs site (wiki.nuit.flashyreese.me) blocks automated access, so use GitHub.
Base path:
`https://raw.githubusercontent.com/FlashyReese/nuit/26.2/dev/`

- `docs/schema.md`: the official schema for 26.2
- `common/src/main/java/me/flashyreese/mods/nuit/skybox/textured/MultiTexturedSkybox.java`: §4.1–4.3
- `common/src/main/java/me/flashyreese/mods/nuit/util/Utils.java`: `TEXTURE_FACES`, UV intersection and mapping
- `common/src/main/java/me/flashyreese/mods/nuit/components/Rotation.java`: §4.5–4.7
- `common/src/main/java/me/flashyreese/mods/nuit/components/Properties.java`: property fields and defaults
- `common/src/main/java/me/flashyreese/mods/nuit/components/Blend.java`: the blend string
- `common/src/main/java/me/flashyreese/mods/nuit/skybox/textured/SquareTexturedSkybox.java`: face orientation for the sky layers

### Vanilla 26.2 data

Minecraft's built-in datapack is mirrored at `https://github.com/misode/mcmeta`
(tag `26.2-data`). `data/minecraft/timeline/day.json` holds the
`minecraft:visual/sun_angle` track used in §4.7. Wiki reference:
`https://minecraft.wiki/w/Environment_attribute` and `https://minecraft.wiki/w/Timeline`.

### Three.js
`https://threejs.org/docs/`: in particular `Euler` (rotation order),
`PlaneGeometry`, `CanvasTexture`, `MeshBasicMaterial` and `PerspectiveCamera`.

---

## 14. Milestones and acceptance criteria

After each one, stop and report what was done and exactly how to check it.

- **M0, Plan.** `docs/PLAN.md` written and questions asked. **Wait for approval.**
- **M1, Math.** `math.ts`, `schema.ts` and `json.ts` exist; all §7 cases pass
  in vitest; the JSON output matches §5 byte for byte for case 3.
- **M2, Sky.** The placeholder atlas renders as a cube with drag-to-look.
  Checks:
  - Facing north at pitch 0: NORTH is centred, W is on the left, E is on the
    right, and the horizon line runs across the middle of the screen.
  - Facing north, pitch +89°: TOP shows S at the top of the screen, N at the
    bottom, W on the left and E on the right.
  - Turning right from north passes E, then S, then W, with no seams or jumps.
- **M3, Hero.** The hero is rendered from the JSON. Sliders, readouts and
  warnings are live. Check: with case 3's values, the test card and the time
  at 6000 (θ = 0), at yaw 0 and pitch 22.47° the card is an upright rectangle centred on screen, with
  TOP at the top, L on the left, and its bottom edge 10° below the horizon.
- **M4, Time and I/O.** Time-of-day spin with play/pause; Copy and Download;
  `.mcmeta` download; JSON import that restores the sliders (round trip:
  export → import → identical JSON).
- **M5, Polish.** Drag-and-drop, `localStorage`, a `vite build` that works on
  GitHub Pages, and a README with screenshots.
