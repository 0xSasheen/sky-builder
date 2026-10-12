// A minimal PNG reader for test fixtures: 8-bit RGB or RGBA, not interlaced (what Pillow writes).
// Uses only web-standard APIs, so the tests need no Node type definitions: fixtures are imported
// with Vite's `?inline` (a base64 data URL), and DecompressionStream inflates the zlib data.

import type { RgbaImage } from '../src/schema.ts';

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes a `data:image/png;base64,…` URL, as `import x from './a.png?inline'` gives. */
export async function decodePng(dataUrl: string): Promise<RgbaImage> {
  const file = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  const view = new DataView(file.buffer);
  let pos = 8; // skip the signature
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (pos < file.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...file.subarray(pos + 4, pos + 8));
    const body = file.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error('Only 8-bit, non-interlaced RGB or RGBA PNGs are supported');
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    pos += 12 + length;
  }
  const compressed = new Uint8Array(idat.reduce((n, b) => n + b.length, 0));
  idat.reduce((offset, b) => { compressed.set(b, offset); return offset + b.length; }, 0);
  const raw = await inflate(compressed);

  // Undo the per-row filters (PNG spec, section 9).
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= channels ? rows[y * stride + i - channels] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? rows[(y - 1) * stride + i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[y * stride + i] = (x + predictor) & 0xff;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    for (let ch = 0; ch < 3; ch++) data[p * 4 + ch] = rows[p * channels + ch];
    data[p * 4 + 3] = channels === 4 ? rows[p * channels + 3] : 255;
  }
  return { width, height, data };
}
