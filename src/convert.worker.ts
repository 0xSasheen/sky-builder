// Converts a panorama to an atlas off the main thread (PLAN §13.3), so the page keeps responding.
// A Web Worker is like a Java thread that shares no memory: it only exchanges messages. The images are
// *transferred*, not copied: the sender gives up its reference, like handing over a byte[].

import { panoramaToAtlas } from './math.ts';

export interface ConvertRequest {
  /** The decoded panorama (colorSpaceConversion 'none'); this worker closes it. */
  image: ImageBitmap;
  faceSize: number;
}

export type ConvertReply =
  | { type: 'progress'; stage: 'convert'; done: number; total: number }
  | { type: 'progress'; stage: 'encode' }
  | { type: 'done'; atlas: ImageBitmap; png: Blob }
  | { type: 'error'; message: string };

function reply(message: ConvertReply, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

self.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  const { image, faceSize } = event.data;
  try {
    // Read the pixels. Panoramas are opaque, so the canvas's premultiplied storage loses nothing.
    const source = new OffscreenCanvas(image.width, image.height);
    const sourceContext = source.getContext('2d')!;
    sourceContext.drawImage(image, 0, 0);
    image.close();
    const pixels = sourceContext.getImageData(0, 0, source.width, source.height);

    const atlas = panoramaToAtlas(pixels, faceSize, undefined,
      (done, total) => reply({ type: 'progress', stage: 'convert', done, total }));

    // A PNG for the download button, and a bitmap for the preview.
    reply({ type: 'progress', stage: 'encode' });
    const canvas = new OffscreenCanvas(atlas.width, atlas.height);
    canvas.getContext('2d')!.putImageData(new ImageData(atlas.data, atlas.width, atlas.height), 0, 0);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    const bitmap = canvas.transferToImageBitmap();
    reply({ type: 'done', atlas: bitmap, png }, [bitmap]);
  } catch (error) {
    // Most likely out of memory on a very large panorama.
    reply({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
