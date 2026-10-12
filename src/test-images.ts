import type { RgbImage } from "./painter.ts";

/** A small synthetic "photo": a warm gradient with a red disc and a dark bar. */
export function sampleImage(width = 160, height = 120): RgbImage {
  const n = width * height;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      r[i] = 0.9 - 0.3 * (y / height);
      g[i] = 0.8 - 0.4 * (x / width);
      b[i] = 0.6;
      if ((x - width * 0.35) ** 2 + (y - height * 0.5) ** 2 < (height * 0.25) ** 2) [r[i], g[i], b[i]] = [0.85, 0.1, 0.1];
      if (x > width * 0.65 && x < width * 0.8 && y > height * 0.2 && y < height * 0.8) [r[i], g[i], b[i]] = [0.1, 0.1, 0.15];
    }
  }
  return { width, height, r, g, b };
}

/** Uncompressible noise, to push a painting past the link cap. */
export function noiseImage(width = 400, height = 400): RgbImage {
  let s = 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const n = width * height;
  const plane = () => Float32Array.from({ length: n }, rnd);
  return { width, height, r: plane(), g: plane(), b: plane() };
}
