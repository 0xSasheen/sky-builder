# Sky Tool: project instructions

A browser tool (Vite + TypeScript + Three.js) for placing a "hero" image in a
Minecraft 26.2 skybox rendered by the Nuit mod. You load a sky atlas and a hero
image, adjust sliders, see a live 3D preview, and export `sky3_image.json`.

**Before any task, read `docs/BRIEF.md` in full.** It is the spec. Supporting
files are in `reference/` (index in BRIEF §13).

## Hard rules

1. **Plan before code.** For anything beyond a trivial fix, write or update
   `docs/PLAN.md` first. Stop and wait for approval before editing source files.
2. **All math goes in `src/math.ts`** as pure functions with no DOM or Three.js
   imports. It is tested against `reference/test-vectors.json` with vitest.
   Never change a formula without updating the tests and BRIEF §6.
3. **The JSON drives the preview.** Sliders → math → JSON object → renderer.
   The renderer reads only the JSON object, the same values Nuit will read.
4. **Rotation order:** Nuit applies `mapping` as X, then Y, then Z
   (matrix $R_z R_y R_x$). In Three.js that is Euler order `'ZYX'`.
   Never use the default `'XYZ'`.
5. **Axes:** +x = east, +y = up, −z = north. Atlas UV: u runs across 3 columns,
   v runs down 2 rows, and **V = 0 is the top**. The face table is BRIEF §3.
6. **The in-game sign of `mapping` X and Y is not yet confirmed.** Keep both
   signs as named constants in `src/constants.ts`, never inline.
7. **The output JSON must match BRIEF §5 exactly.** In 26.2, `"blend"` is a
   string inside `properties`; a top-level `"blend"` object is silently ignored.
8. **Never commit third-party or personal artwork.** Real textures go in
   `reference/private/`, which is git-ignored. Use `reference/samples/` for tests.
9. TypeScript `strict`. Plain DOM for the UI; no UI framework unless approved.

## Working style

- The developer is fluent in Java. When introducing a TypeScript, JavaScript or
  Three.js idiom, give the Java equivalent in a sentence.
- Explain math step by step, without skipping steps, in LaTeX notation.
- Stop after each milestone (BRIEF §14) with a summary and how to test it.
  Keep commits small and focused.
- If something about Nuit is uncertain, check the source links in BRIEF §13
  rather than guessing, and say what you checked.

## Commands

```
npm run dev       # dev server with live reload
npm run build     # production build into dist/
npx vitest        # run the math tests
```
