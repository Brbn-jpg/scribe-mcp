import { readFile } from "node:fs/promises";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { LinkError } from "./link.ts";
import type { RgbImage } from "./painter.ts";

/** Larger photos are refused rather than decoded into gigabytes of memory. */
const MAX_MEGAPIXELS = 40;

/** Decodes a local PNG or JPEG into planar RGB, compositing transparency over white paper. */
export async function readImage(path: string): Promise<RgbImage> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    throw new LinkError(`Could not read the image at "${path}". Pass an absolute path to a PNG or JPEG file.`);
  }
  let width: number, height: number, rgba: Uint8Array;
  try {
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      const png = PNG.sync.read(buffer);
      ({ width, height } = png);
      rgba = png.data;
    } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: 1024 });
      ({ width, height } = img);
      rgba = img.data;
    } else {
      throw new LinkError("Only PNG and JPEG images are supported. Convert the image (for example WebP or HEIC) to PNG or JPEG first.");
    }
  } catch (error) {
    if (error instanceof LinkError) throw error;
    throw new LinkError(`The image could not be decoded: ${(error as Error).message}`);
  }
  if (width * height > MAX_MEGAPIXELS * 1e6) throw new LinkError(`The image is larger than ${MAX_MEGAPIXELS} megapixels; resize it first.`);
  const n = width * height;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    r[i] = (rgba[i * 4]! / 255) * a + (1 - a);
    g[i] = (rgba[i * 4 + 1]! / 255) * a + (1 - a);
    b[i] = (rgba[i * 4 + 2]! / 255) * a + (1 - a);
  }
  return { width, height, r, g, b };
}
