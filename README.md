# Sky Builder

Place an image (the "hero") in a Minecraft sky made with the [Nuit](https://github.com/FlashyReese/nuit) mod,
see it live in 3D, and export the `sky3_image.json` that Nuit reads. No more editing numbers, reloading the
game and checking.

![The hero placed in the sky, with the compass overlay and the controls](docs/screenshots/preview.png)

**Use it at <https://0xsasheen.github.io/sky-builder/>.** Everything runs in your browser; your images never leave
your computer.

## What it does

- **Shows your sky** as the cube Nuit draws, with drag-to-look. Load a sky atlas, or a panorama, which it
  converts for you.
- **Blends day and night skies** (and any more you like, such as a sunrise) as Nuit does. Each sky is a tab with its
  own image and fade keyframes, and the preview fades them by the time of day.
- **Places the hero** with a few controls: its size, the height of its bottom edge, and its compass direction.
  *Tilted* mode keeps it facing you like a billboard; *wall* mode stands it upright on the north wall.
- **Warns you** when the image would spill off its cube face (Nuit would bend it over the edge) or tip over the
  zenith, and shows its angular size and edges.
- **Plays the day**: a time slider using vanilla's sun curve, so you can watch the sky turn, the day and night
  skies fade into each other, and the hero cross the sky, as they will in game.
- **Exports** `sky3_image.json` and `hero.png.mcmeta` exactly as Nuit 26.2 expects them, and **imports** an existing
  `sky3_image.json` so you can keep editing it.
- **Assembles a resource pack** from a template, with every sky layer and the hero, ready to drop into
  `resourcepacks/`.
- **Remembers** your files and settings in your browser until you press *Reset*.

## Quick start

1. **Skies.** Under **Sky tabs**, open a tab (**Night**, **Day**, or a new one with **+**) and drop its sky onto the
   page. It can be an atlas (a 3 × 2 grid of cube faces, the layout `nuit:square-textured` uses) or a 2:1
   equirectangular panorama. A panorama is converted in the browser: use **Download atlas (PNG)** to keep the atlas
   for your pack. If the converted sky comes out turned, drag **Left edge** until it lines up.
   - The first included tab is the **base**, always on. Each tab after it fades in over the ones before, by its
     **Fade** keyframes: at each tick, how visible it is, from 0 to 1. The Day tab starts with the starter pack's
     (full day from 10 AM to 2 PM, gone from 10 PM to 2 AM).
   - Untick **Include in the pack** to leave a sky out. With one sky included, it is always on and just turns.
2. **Hero.** Drop your hero image. PNG transparency is kept.
3. **Place it.** Set **Height β** (or use the × and ÷ buttons), **Bottom b** (the elevation of its bottom edge) and
   **Turn ψ** (positive turns it west). **Look at hero** points the camera at it.
4. **Check it.** Move the time slider or press ▶; the line under it shows how visible each sky is. Fix anything
   shown in red; you can still export, after a confirmation.
5. **Name it.** Set **Texture** to where the image will be in your pack, such as `mypack:textures/sky/hero.png`.
6. **Export.** Download `sky3_image.json` and the `.mcmeta` file.

![A panorama converted to an atlas in the Day tab, with the left-edge control](docs/screenshots/panorama.png)

![Night and Day half blended at 6 AM, with the Day tab's fade keyframes](docs/screenshots/tabs.png)

### Or assemble the whole pack

In **Resource pack**, choose your own pack template (a `.zip`), or keep the built-in starter. Loading a template
makes one sky tab per sky layer it has. Then press **Assemble pack**. You get a new zip with:

- your hero, its `.mcmeta` and `sky3_image.json`;
- each included sky tab's layer file and sky. A tab without a sky of its own keeps the template's, or gets a guide
  atlas.

Layers whose tabs you left out are removed. Everything else in the template is copied as it is. Drop the zip into
`resourcepacks/`. Each tab can also export just its layer file (**Download sky2_day.json**, for example).

## Putting it in your pack

```
assets/
  nuit/sky/
    sky1_night.json        your night layer (nuit:square-textured)
    sky2_day.json          your day layer
    sky3_image.json        from Sky Builder
  <namespace>/textures/sky/
    hero.png               your hero image
    hero.png.mcmeta        from Sky Builder: smooth filtering and clamped edges
```

- **The hero turns with the sky** only if every sky layer's `rotation` matches the hero's: `"speed": 1.0`,
  `"axis": {"0": [0.0, 0.0, 0.0]}` and `"skyboxRotation": false`. Only `mapping` differs between layers.
- **Layers draw in `layer` order.** Sky Builder numbers them for you: the included sky tabs are 1, 2, … in tab
  order, and the hero comes last.
- **A sky layer with no fade keyframes is always on**, and hides every layer below it. Only the first, the base,
  should have none. (Nuit 26.2 has no `alwaysOn` setting; older packs that have one can drop it.)
- Press **F3 + T** in game to reload resource packs.

![The JSON panel, with export and import](docs/screenshots/export.png)

## What it assumes

Minecraft Java 26.2 with Nuit for 26.2, the vanilla day cycle (no datapacks that change time), and no shader packs.
The preview follows Nuit's own geometry, rotation order, texture filtering and blending, checked against its
source and in game. The details are in [`docs/PLAN.md`](docs/PLAN.md).

## Converting panoramas offline

[`reference/sky_convert.py`](reference/sky_convert.py) converts between atlases and panoramas in both directions.
It needs Python with numpy and Pillow. The site's panorama converter uses the same convention, and matches the
script's output to within 1 per colour channel.

## Development

```
npm ci            # install
npm run dev       # dev server at http://localhost:5173/sky-builder/
npx vitest        # tests
npm run build     # production build into dist/
```

- [`docs/BRIEF.md`](docs/BRIEF.md) is the specification, and [`docs/PLAN.md`](docs/PLAN.md) records the design
  and how each detail was checked.
- The maths is in `src/math.ts` and the sky tabs in `src/tabs.ts` (pure functions, tested); `src/json.ts` writes and
  reads the exact JSON; `src/pack.ts` builds packs; `src/scene.ts` is the Three.js preview.
- Every push to `main` is tested, built and published to GitHub Pages by
  [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## Credits

- [Nuit](https://github.com/FlashyReese/nuit) by FlashyReese, the sky mod this tool targets.
- Built with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/).
- Not affiliated with Mojang, Microsoft or the Nuit project.

## Licence

[MIT](LICENSE)
