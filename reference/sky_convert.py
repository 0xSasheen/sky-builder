#!/usr/bin/env python3
"""
Convert between a Nuit / OptiFine 3:2 skybox atlas and an equirectangular panorama.

    python sky_convert.py to-pano  atlas.png pano.png  [--width 8192]
    python sky_convert.py to-atlas pano.png  atlas.png [--face 2048]

Atlas layout (face size F, atlas 3F x 2F):

    +--------+--------+--------+
    | Bottom |  Top   | South  |
    +--------+--------+--------+
    |  West  | North  |  East  |
    +--------+--------+--------+

Panorama convention (width W, height W/2):
    * x = 0 sits on the South-West cube corner, and x increases turning right
      (as seen from inside), so the strip reads  West | North | East | South.
    * Face centres land at x = W/8, 3W/8, 5W/8, 7W/8  (W, N, E, S).
      Anything centred there sits in the middle of one face, clear of every
      vertical seam, and the panorama's own left/right wrap falls on a corner.
    * y = 0 is straight up, y = H/2 the horizon, y = H straight down.

Use this script for BOTH directions. Other tools may start the panorama at a
different compass heading or mirror it, so mixing converters can rotate or
flip the result.
"""
import argparse
import numpy as np
from PIL import Image

# World axes: +x = east, +y = up, -z = north (Minecraft convention).
# Each face: centre c, image-right r, image-up u. A face pixel at normalised
# (s, t), s right and t down, both in [-1, 1], looks along d = c + s*r - t*u.
FACES = {
    #          centre        right         up           atlas (col,row)
    "bottom": ((0, -1, 0), (1, 0, 0),  (0, 0, -1), (0, 0)),
    "top":    ((0, 1, 0),  (1, 0, 0),  (0, 0, 1),  (1, 0)),
    "south":  ((0, 0, 1),  (-1, 0, 0), (0, 1, 0),  (2, 0)),
    "west":   ((-1, 0, 0), (0, 0, -1), (0, 1, 0),  (0, 1)),
    "north":  ((0, 0, -1), (1, 0, 0),  (0, 1, 0),  (1, 1)),
    "east":   ((1, 0, 0),  (0, 0, 1),  (0, 1, 0),  (2, 1)),
}
YAW0 = -135.0   # yaw (deg from north, clockwise) at panorama x = 0


def _bilinear(img, x, y, wrap_x=False):
    H, W = img.shape[:2]
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[..., None];          fy = (y - y0)[..., None]
    x1, y1 = x0 + 1, y0 + 1
    if wrap_x:
        x0 %= W; x1 %= W
    else:
        x0 = np.clip(x0, 0, W - 1); x1 = np.clip(x1, 0, W - 1)
    y0 = np.clip(y0, 0, H - 1); y1 = np.clip(y1, 0, H - 1)
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bot = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def atlas_to_pano(atlas, W, chunk=256):
    A = atlas.astype(np.float32)
    F = A.shape[1] // 3
    assert A.shape[0] == 2 * F, "atlas must be exactly 3:2"
    faces = {n: A[r*F:(r+1)*F, c*F:(c+1)*F] for n, (_, _, _, (c, r)) in FACES.items()}
    H = W // 2
    out = np.zeros((H, W, A.shape[2]), np.float32)
    names = list(FACES)
    vec = {n: [np.array(v, np.float32) for v in FACES[n][:3]] for n in names}

    lam = np.radians(YAW0 + (np.arange(W) + 0.5) / W * 360.0)
    for y0 in range(0, H, chunk):
        ys = np.arange(y0, min(H, y0 + chunk))
        phi = np.radians(90.0 - (ys + 0.5) / H * 180.0)
        L, P = np.meshgrid(lam, phi)
        d = np.stack([np.sin(L) * np.cos(P), np.sin(P), -np.cos(L) * np.cos(P)], -1).astype(np.float32)

        best = np.full(L.shape, -np.inf, np.float32); which = np.zeros(L.shape, np.int8)
        for i, n in enumerate(names):
            k = d @ vec[n][0]
            m = k > best; best[m] = k[m]; which[m] = i

        block = np.zeros(L.shape + (A.shape[2],), np.float32)
        for i, n in enumerate(names):
            m = which == i
            if not m.any():
                continue
            c, r, u = vec[n]
            dm = d[m]
            p = dm / (dm @ c)[:, None]
            s, t = p @ r, -(p @ u)
            block[m] = _bilinear(faces[n], (s + 1) / 2 * F - 0.5, (t + 1) / 2 * F - 0.5)
        out[y0:y0 + len(ys)] = block
    return out


def pano_to_atlas(pano, F):
    P_ = pano.astype(np.float32)
    H, W = P_.shape[:2]
    out = np.zeros((2 * F, 3 * F, P_.shape[2]), np.float32)
    g = (np.arange(F) + 0.5) / F * 2 - 1
    S, T = np.meshgrid(g, g)
    for n, (c, r, u, (col, row)) in FACES.items():
        c, r, u = (np.array(v, np.float32) for v in (c, r, u))
        d = c + S[..., None] * r - T[..., None] * u
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        lam = np.degrees(np.arctan2(d[..., 0], -d[..., 2]))
        phi = np.degrees(np.arcsin(np.clip(d[..., 1], -1, 1)))
        x = ((lam - YAW0) % 360.0) / 360.0 * W - 0.5
        y = (90.0 - phi) / 180.0 * H - 0.5
        out[row*F:(row+1)*F, col*F:(col+1)*F] = _bilinear(P_, x, y, wrap_x=True)
    return out


def _save(arr, path):
    Image.fromarray(np.clip(np.rint(arr), 0, 255).astype(np.uint8)).save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["to-pano", "to-atlas"])
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--width", type=int, default=8192, help="panorama width (to-pano)")
    ap.add_argument("--face", type=int, default=2048, help="face size (to-atlas)")
    a = ap.parse_args()

    img = np.asarray(Image.open(a.src).convert("RGBA"))
    img = img if img[..., 3].min() < 255 else img[..., :3]

    if a.mode == "to-pano":
        if a.width % 2:
            raise SystemExit("--width must be even")
        res = atlas_to_pano(img, a.width)
    else:
        if img.shape[1] != 2 * img.shape[0]:
            raise SystemExit(f"panorama must be exactly 2:1, got {img.shape[1]}x{img.shape[0]}")
        if 3 * a.face > 8192:
            raise SystemExit(f"face {a.face} gives a {3*a.face}-wide atlas; Nuit's limit is 8192 (face <= 2730)")
        res = pano_to_atlas(img, a.face)
    _save(res, a.dst)
    print(f"wrote {a.dst}  {res.shape[1]} x {res.shape[0]}")


if __name__ == "__main__":
    main()
