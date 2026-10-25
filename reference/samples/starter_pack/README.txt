NUIT SKY TEST PACK  (new style: hero on its own layer)   Minecraft 26.2
=======================================================================

  assets/nuit/sky/sky1_night.json        layer 1  night placeholder, always on
  assets/nuit/sky/sky2_day.json          layer 2  day placeholder, fades over night
  assets/nuit/sky/sky3_image.json        layer 3  test hero (nuit:multi-textured)
  assets/sasheen/textures/sky/night.png  labelled 3:2 atlas, 1024 px faces
  assets/sasheen/textures/sky/day.png    same, day colours
  assets/sasheen/textures/sky/hero.png   1063 x 1502 test card, transparent window
  assets/sasheen/textures/sky/hero.png.mcmeta   blur + clamp filtering

The placeholders carry real guides: elevation lines every 10 deg (curves
on the side walls, circles on TOP/BOTTOM), bearing lines every 15 deg,
compass labels, and the horizon in yellow.

Hero placement (in sky3_image.json)
  size    40.5 deg tall x 29.3 deg wide
  edges   bottom 3.0 deg, top 43.5 deg, centred on the NORTH face
  uvRange 0.4565 / 0.6578 / 0.5435 / 0.8422     mapping [23.25, 0, 0]

WHAT TO CHECK IN GAME
 1. Follow the compass labels to the NORTH face. The pink card sits over it.
    (The whole sky turns once per in-game day, so north drifts.)
 2. Look up at the card's centre (about 23 deg): a clean upright rectangle,
    TOP at the top, L on the left.
 3. Its bottom edge sits just above the yellow horizon; its top stays below
    the 50 deg circle on the TOP face.
 4. The circle in the card shows the sky behind it  -> transparency works.
 5. As time passes, the card keeps its place against the guides
    -> the three rotation blocks agree.
 6. /time set 6000 shows DAY, /time set 18000 shows NIGHT.

If something is off
  - card below the horizon     -> flip the sign: mapping [-23.25, 0, 0]
  - card bent at an edge       -> uvRange crosses out of the NORTH cell
  - magenta/black checkerboard -> texture path does not match the file
  - shimmering card            -> check hero.png.mcmeta is named exactly that

Swapping in real art
  - day.png / night.png: any 3:2 atlas, e.g. from sky_convert.py to-atlas
  - hero.png: if the aspect ratio changes, recompute minU / maxU
      a = width / height,  k = tan(height_deg / 2)
      minU = 1/3 + (1 - a*k)/6     maxU = 1/3 + (1 + a*k)/6
      minV = 1/2 + (1 - k)/4       maxV = 1/2 + (1 + k)/4
      mapping X = bottom_deg + height_deg / 2
  - keep speed / axis / skyboxRotation identical in all three files
