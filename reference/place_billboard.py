#!/usr/bin/env python3
"""
Project a flat image into an equirectangular sky panorama as a "billboard":
a flat poster hanging in the sky, facing the player. Seen in game it is a clean,
undistorted rectangle at any size - no trapezoid, no stretch.

Uses the same panorama convention as sky_convert.py (x = 0 on the SW cube
corner, face centres at W/8, 3W/8, 5W/8, 7W/8 for W, N, E, S), so the output
lines up with panoramas made by that script.

    python place_billboard.py image.png layer.png --height 60 --facing north
    python place_billboard.py image.png out.png --height 60 --over day_pano.png

Options:
    --height DEG     angular height of the image, measured through its centre
    --bottom DEG     elevation of the bottom edge's midpoint (default 5)
    --facing DIR     north | east | south | west   (centred on that cube face)
    --yaw DEG        or an exact yaw instead (0 = north, 90 = east)
    --pano-width N   panorama width (default 8192; height is half)
    --over PANO      composite onto this panorama instead of writing a
                     transparent layer

Without --over the output is a transparent PNG the size of the panorama. In GIMP
use File > Open as Layers on top of your panorama; it lands already aligned.
"""
import argparse, math
import numpy as np
from PIL import Image

YAW0 = -135.0
FACING = {"west": -90.0, "north": 0.0, "east": 90.0, "south": 180.0}


def direction(lam, phi):
    return np.stack([np.sin(lam) * np.cos(phi), np.sin(phi), -np.cos(lam) * np.cos(phi)], -1)


def bilinear_rgba(img, x, y):
    H, W = img.shape[:2]
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[..., None]; fy = (y - y0)[..., None]
    def g(xx, yy):
        inside = (xx >= 0) & (xx < W) & (yy >= 0) & (yy < H)
        out = np.zeros(xx.shape + (4,), np.float32)
        out[inside] = img[yy[inside], xx[inside]]
        return out                                   # outside the image = transparent
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + \
           (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy


def render(src, W, yaw, phic, beta):
    H = W // 2
    IH0, IW0 = src.shape[:2]
    aspect = IW0 / IH0
    h = math.tan(math.radians(beta / 2))             # half-height on the tangent plane
    w = h * aspect                                   # half-width, keeps true aspect

    # Pre-shrink so bilinear sampling doesn't alias: match the centre's pixel density.
    target_h = max(8, int(round(2 * h * H / math.pi)))
    if target_h < IH0:
        im = Image.fromarray(src.astype(np.uint8), "RGBA").resize(
            (max(8, int(round(target_h * aspect))), target_h), Image.LANCZOS)
        src = np.asarray(im).astype(np.float32)
    IH, IW = src.shape[:2]
    # premultiply alpha so transparent edges don't fringe
    src = src.copy(); src[..., :3] *= src[..., 3:4] / 255.0

    lc, pc = math.radians(yaw), math.radians(phic)
    c = direction(np.float64(lc), np.float64(pc))
    r = np.array([math.cos(lc), 0.0, math.sin(lc)])                           # screen-right
    u = np.array([-math.sin(lc) * math.sin(pc), math.cos(pc), math.cos(lc) * math.sin(pc)])  # screen-up

    layer = np.zeros((H, W, 4), np.float32)
    lam = np.radians(YAW0 + (np.arange(W) + 0.5) / W * 360.0)
    top_row = max(0, int((90 - min(90, phic + beta)) / 180 * H) - 2)
    bot_row = min(H, int((90 - max(-90, phic - beta)) / 180 * H) + 2)
    for y0 in range(top_row, bot_row, 256):
        ys = np.arange(y0, min(bot_row, y0 + 256))
        phi = np.radians(90.0 - (ys + 0.5) / H * 180.0)
        L, P = np.meshgrid(lam, phi)
        d = direction(L, P)
        k = d @ c
        front = k > 1e-6
        p = np.where(front[..., None], d / np.where(front, k, 1.0)[..., None], 0)
        s, t = p @ r, p @ u
        ix = (s / w + 1) / 2 * IW - 0.5
        iy = (1 - t / h) / 2 * IH - 0.5
        block = bilinear_rgba(src, ix, iy)
        block[~front] = 0
        layer[ys] = block
    # un-premultiply
    a = layer[..., 3:4]
    layer[..., :3] = np.where(a > 0, layer[..., :3] * 255.0 / np.maximum(a, 1e-6), 0)
    return np.clip(layer, 0, 255)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image"); ap.add_argument("output")
    ap.add_argument("--height", type=float, default=60.0)
    ap.add_argument("--bottom", type=float, default=5.0)
    ap.add_argument("--facing", choices=FACING, default="north")
    ap.add_argument("--yaw", type=float, default=None)
    ap.add_argument("--pano-width", type=int, default=8192)
    ap.add_argument("--over", default=None)
    a = ap.parse_args()

    if not 5 <= a.height <= 120:
        raise SystemExit("--height should be between 5 and 120 degrees")
    yaw = a.yaw if a.yaw is not None else FACING[a.facing]
    phic = a.bottom + a.height / 2
    if phic + a.height / 2 > 89:
        raise SystemExit("image would reach the zenith; lower --bottom or --height")

    src = np.asarray(Image.open(a.image).convert("RGBA")).astype(np.float32)
    W = a.pano_width
    if a.over:
        base = Image.open(a.over).convert("RGBA")
        W = base.size[0]
    layer = render(src, W, yaw, phic, a.height)
    out = Image.fromarray(layer.astype(np.uint8), "RGBA")
    if a.over:
        base.alpha_composite(out); out = base.convert("RGB")
    out.save(a.output)
    asp = src.shape[1] / src.shape[0]
    wdeg = 2 * math.degrees(math.atan(math.tan(math.radians(a.height / 2)) * asp))
    print(f"wrote {a.output}  {out.size[0]} x {out.size[1]}")
    print(f"image: {a.height:.1f} deg tall x {wdeg:.1f} deg wide, centre at yaw {yaw:.0f}, "
          f"elevation {phic:.1f}  (bottom {a.bottom:.1f}, top {phic + a.height/2:.1f})")


if __name__ == "__main__":
    main()
