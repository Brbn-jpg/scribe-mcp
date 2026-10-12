/* Photo -> Scribe painting. A TypeScript port of the greedy painter used for
   Todrawn's own Scribe ads (brag-output-2026-10-12-pita/draw/trace.py).

   1. Underpaint: straight horizontal rows of colour runs from a blurred copy,
      so the photo rectangle is covered edge to edge with no paper showing.
   2. Painting: batches of strokes, coarse to fine. Each starts where the
      simulated canvas differs most from the photo, follows the image
      structure (perpendicular to the structure-tensor gradient), takes the
      mean photo colour under its own footprint, and is kept only if it
      lowers the error.

   Everything is simulated the way Scribe renders a Draw stroke: one pen
   width, round caps, the pen's opacity, later strokes over earlier ones.
   Pure: no decoders, no I/O, so the frontend contract test can import it. */

import type { Aspect } from "./constants.ts";

export type Pen = "ballpoint" | "marker" | "fineliner" | "pencil";
export type Detail = "low" | "medium" | "high";

/** Planar RGB in 0..1. */
export interface RgbImage {
  width: number;
  height: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

export interface PaintedStroke {
  color: string;
  /** Artboard units, y down. */
  pts: [number, number][];
}

export interface Painting {
  aspect: Aspect;
  /** Artboard size in Draw units (long edge 960, the editor's own canvas). */
  width: number;
  height: number;
  strokes: PaintedStroke[];
  underpaintStrokes: number;
  meanAbsDiff: number;
}

export interface PaintOptions {
  aspect?: Aspect;
  pen?: Pen;
  detail?: Detail;
  seed?: number;
}

/** Width in Draw units and opacity of each pen (frontend lib/scribe/tools.ts PEN_CHARACTER). */
export const PEN_STYLE: Record<Pen, { width: number; alpha: number }> = {
  ballpoint: { width: 9, alpha: 0.92 },
  marker: { width: 16, alpha: 0.78 },
  fineliner: { width: 5, alpha: 0.95 },
  pencil: { width: 7, alpha: 0.62 },
};

/** Artboard size per aspect in Draw units (DRAW_CANVAS_LONG_EDGE_PX = 960). */
export const ARTBOARD: Record<Aspect, [number, number]> = {
  landscape: [960, 540],
  portrait: [540, 960],
  square: [960, 960],
  feed: [768, 960],
};

export const DETAIL_BUDGET: Record<Detail, number> = { low: 1200, medium: 2000, high: 2800 };

/** Paper left around the photo, in Draw units. */
const MARGIN = 16;

// ---------------------------------------------------------------- image ops

type Plane = Float32Array;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Area-average downscale, bilinear upscale. */
function resizePlane(src: Plane, sw: number, sh: number, tw: number, th: number): Plane {
  const out = new Float32Array(tw * th);
  const fx = sw / tw;
  const fy = sh / th;
  if (fx >= 1 && fy >= 1) {
    for (let y = 0; y < th; y++) {
      const y0 = Math.floor(y * fy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      for (let x = 0; x < tw; x++) {
        const x0 = Math.floor(x * fx);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src[yy * sw + xx]!;
        out[y * tw + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }
  for (let y = 0; y < th; y++) {
    const sy = Math.min(Math.max((y + 0.5) * fy - 0.5, 0), sh - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, sh - 1);
    const ty = sy - y0;
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(Math.max((x + 0.5) * fx - 0.5, 0), sw - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, sw - 1);
      const tx = sx - x0;
      const top = src[y0 * sw + x0]! * (1 - tx) + src[y0 * sw + x1]! * tx;
      const bot = src[y1 * sw + x0]! * (1 - tx) + src[y1 * sw + x1]! * tx;
      out[y * tw + x] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

function boxBlurPass(src: Plane, w: number, h: number, r: number): Plane {
  if (r < 1) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(Math.max(k, 0), w - 1)]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + Math.min(x + r + 1, w - 1)]! - src[row + Math.max(x - r, 0)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(Math.max(k, 0), h - 1) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(y + r + 1, h - 1) * w + x]! - tmp[Math.max(y - r, 0) * w + x]!;
    }
  }
  return out;
}

/** Gaussian approximated by three box passes. */
function blur(src: Plane, w: number, h: number, sigma: number): Plane {
  if (sigma < 0.5) return src.slice();
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  return boxBlurPass(boxBlurPass(boxBlurPass(src, w, h, r), w, h, r), w, h, r);
}

function sobel(lum: Plane, w: number, h: number): [Plane, Plane] {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const at = (x: number, y: number) => lum[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      gx[y * w + x] = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      gy[y * w + x] = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
    }
  }
  return [gx, gy];
}

const luminance = (r: Plane, g: Plane, b: Plane): Plane => {
  const out = new Float32Array(r.length);
  for (let i = 0; i < r.length; i++) out[i] = 0.299 * r[i]! + 0.587 * g[i]! + 0.114 * b[i]!;
  return out;
};

function hex(c: number): string {
  return Math.round(Math.min(Math.max(c, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");
}
const q8 = (c: number) => Math.round(Math.min(Math.max(c, 0), 1) * 255) / 255;

/** The artboard whose ratio is closest to the photo's, on a log scale. */
function closestAspect(ratio: number): Aspect {
  let best: Aspect = "square";
  for (const aspect of Object.keys(ARTBOARD) as Aspect[]) {
    const [w, h] = ARTBOARD[aspect];
    const [bw, bh] = ARTBOARD[best];
    if (Math.abs(Math.log(w / h / ratio)) < Math.abs(Math.log(bw / bh / ratio))) best = aspect;
  }
  return best;
}

// ---------------------------------------------------------------- painter

export function paintImage(image: RgbImage, options: PaintOptions = {}): Painting {
  const pen = options.pen ?? "fineliner";
  const { width: PEN, alpha: ALPHA } = PEN_STYLE[pen];
  const budget = DETAIL_BUDGET[options.detail ?? "medium"];
  const rnd = mulberry32(options.seed ?? 3);
  const aspect = options.aspect ?? closestAspect(image.width / image.height);
  const [W, H] = ARTBOARD[aspect];

  // photo rectangle: fitted inside the artboard with a small paper margin
  const fit = Math.min((W - 2 * MARGIN) / image.width, (H - 2 * MARGIN) / image.height);
  const RW = Math.round(image.width * fit);
  const RH = Math.round(image.height * fit);
  const OX = Math.round((W - RW) / 2);
  const OY = Math.round((H - RH) / 2);

  // target and canvas at 1 px per Draw unit, full artboard, white paper outside the photo
  const N = W * H;
  const T = [new Float32Array(N).fill(1), new Float32Array(N).fill(1), new Float32Array(N).fill(1)];
  const C = [new Float32Array(N).fill(1), new Float32Array(N).fill(1), new Float32Array(N).fill(1)];
  const inside = new Uint8Array(N);
  const planes = [image.r, image.g, image.b];
  for (let ch = 0; ch < 3; ch++) {
    const small = resizePlane(planes[ch]!, image.width, image.height, RW, RH);
    for (let y = 0; y < RH; y++) T[ch]!.set(small.subarray(y * RW, (y + 1) * RW), (OY + y) * W + OX);
  }
  for (let y = OY; y < OY + RH; y++) inside.fill(1, y * W + OX, y * W + OX + RW);

  // saliency: sharp regions (the subject) weigh more than a soft background
  const lumT = luminance(T[0]!, T[1]!, T[2]!);
  const hi = blur(lumT, W, H, 3);
  for (let i = 0; i < N; i++) hi[i] = Math.abs(lumT[i]! - hi[i]!);
  const detail = blur(hi, W, H, 12);
  const sample: number[] = [];
  for (let i = 0; i < N; i += 7) if (inside[i]) sample.push(detail[i]!);
  sample.sort((a, b) => a - b);
  const p97 = (sample[Math.floor(sample.length * 0.97)] ?? 1) + 1e-6;
  const SAL = new Float32Array(N);
  for (let i = 0; i < N; i++) SAL[i] = Math.min(1.4, Math.max(0.45, 0.45 + (0.55 * detail[i]!) / p97));

  const strokes: PaintedStroke[] = [];

  /** Anti-aliased round-capped coverage of a polyline, in its bounding box. */
  const footprint = (pts: [number, number][]) => {
    const r = PEN / 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const x0 = Math.max(0, Math.floor(minX - r - 1));
    const y0 = Math.max(0, Math.floor(minY - r - 1));
    const x1 = Math.min(W, Math.ceil(maxX + r + 1));
    const y1 = Math.min(H, Math.ceil(maxY + r + 1));
    const bw = x1 - x0;
    const bh = y1 - y0;
    const mask = new Float32Array(Math.max(bw, 0) * Math.max(bh, 0));
    for (let py = 0; py < bh; py++) {
      const cy = y0 + py + 0.5;
      for (let px = 0; px < bw; px++) {
        const cx = x0 + px + 0.5;
        let d2 = Infinity;
        for (let k = 0; k < pts.length; k++) {
          const [ax, ay] = pts[k]!;
          const [bx, by] = pts[Math.min(k + 1, pts.length - 1)]!;
          const vx = bx - ax, vy = by - ay;
          const len2 = vx * vx + vy * vy;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((cx - ax) * vx + (cy - ay) * vy) / len2)) : 0;
          const dx = cx - (ax + t * vx), dy = cy - (ay + t * vy);
          d2 = Math.min(d2, dx * dx + dy * dy);
        }
        mask[py * bw + px] = Math.min(1, Math.max(0, r + 0.5 - Math.sqrt(d2)));
      }
    }
    return { x0, y0, bw, bh, mask };
  };

  const commit = (pts: [number, number][], rgb: [number, number, number]) => {
    const col: [number, number, number] = [q8(rgb[0]), q8(rgb[1]), q8(rgb[2])];
    const { x0, y0, bw, bh, mask } = footprint(pts);
    for (let py = 0; py < bh; py++) {
      for (let px = 0; px < bw; px++) {
        const m = mask[py * bw + px]! * ALPHA;
        if (m <= 0) continue;
        const i = (y0 + py) * W + x0 + px;
        for (let ch = 0; ch < 3; ch++) C[ch]![i] = C[ch]![i]! * (1 - m) + col[ch]! * m;
      }
    }
    strokes.push({
      color: `#${hex(col[0])}${hex(col[1])}${hex(col[2])}`,
      pts: pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
    });
  };

  // ------------------------------------------------ 1. underpaint rows
  {
    const B = T.map((p) => blur(p, W, H, 2.2));
    const row = PEN * 0.86;
    const ys: number[] = [];
    for (let y = OY + PEN / 2 - 0.6; y <= OY + RH - PEN / 2 + 0.6 + 1e-6; y += row) ys.push(y);
    if (ys.length) ys[ys.length - 1] = OY + RH - PEN / 2 + 0.6;
    type Planned = { pts: [number, number][]; c: [number, number, number] };
    const plan = (tol: number, minRun: number): Planned[] => {
    const out: Planned[] = [];
    ys.forEach((yu, rowIndex) => {
      const yy = Math.min(Math.round(yu), H - 1) * W;
      type Run = { a: number; b: number; c: [number, number, number] };
      const runs: Run[] = [];
      let a = 0;
      let sum: [number, number, number] = [0, 0, 0];
      let cnt = 0;
      for (let x = 0; x < RW; x++) {
        const px: [number, number, number] = [B[0]![yy + OX + x]!, B[1]![yy + OX + x]!, B[2]![yy + OX + x]!];
        if (cnt > 0) {
          const mean = sum.map((s) => s / cnt);
          if (Math.max(...px.map((v, k) => Math.abs(v - mean[k]!))) > tol) {
            runs.push({ a, b: x, c: mean as [number, number, number] });
            a = x;
            sum = [0, 0, 0];
            cnt = 0;
          }
        }
        sum = [sum[0] + px[0], sum[1] + px[1], sum[2] + px[2]];
        cnt++;
      }
      runs.push({ a, b: RW, c: sum.map((s) => s / cnt) as [number, number, number] });
      // absorb short runs into the closer neighbour
      for (let merged = true; merged && runs.length > 1; ) {
        merged = false;
        for (let k = 0; k < runs.length; k++) {
          const run = runs[k]!;
          if (run.b - run.a >= minRun) continue;
          const nbrs = [k - 1, k + 1].filter((j) => j >= 0 && j < runs.length);
          const dist = (j: number) => runs[j]!.c.reduce((s, v, i) => s + Math.abs(v - run.c[i]!), 0);
          const j = nbrs.reduce((best, cur) => (dist(cur) < dist(best) ? cur : best));
          const o = runs[j]!;
          const wa = o.b - o.a, wb = run.b - run.a;
          runs[j] = {
            a: Math.min(o.a, run.a),
            b: Math.max(o.b, run.b),
            c: o.c.map((v, i) => (v * wa + run.c[i]! * wb) / (wa + wb)) as [number, number, number],
          };
          runs.splice(k, 1);
          merged = true;
          break;
        }
      }
      const ordered = rowIndex % 2 === 0 ? runs : [...runs].reverse();
      for (const run of ordered) {
        const xa = OX + run.a + (run.a === 0 ? PEN / 2 - 0.3 : -1.2);
        const xb = OX + run.b + (run.b === RW ? -(PEN / 2 - 0.3) : 1.2);
        out.push({ pts: rowIndex % 2 === 0 ? [[xa, yu], [xb, yu]] : [[xb, yu], [xa, yu]], c: run.c });
      }
    });
    return out;
    };
    // coarser runs until the underpaint leaves most of the budget for real painting
    let tol = 0.12, minRun = PEN * 5.2;
    let rows = plan(tol, minRun);
    for (let tries = 0; rows.length > budget * 0.6 && tries < 6; tries++) {
      tol *= 1.25;
      minRun *= 1.35;
      rows = plan(tol, minRun);
    }
    for (const r of rows) commit(r.pts, r.c);
  }
  const underpaintStrokes = strokes.length;

  // ------------------------------------------------ 2. greedy painting
  const k = PEN / 5;
  const schedule = [8, 8, 6, 6, 5, 4.5, 4, 3.5, 3, 3, 2.5, 2.5, 2.2, 2.2, 2, 2].map((r) => r * k);
  const limit = Math.max(budget - underpaintStrokes, 0);
  const clampX = (x: number) => Math.min(Math.max(x, OX + PEN / 2 - 0.5), OX + RW - PEN / 2 + 0.5);
  const clampY = (y: number) => Math.min(Math.max(y, OY + PEN / 2 - 0.5), OY + RH - PEN / 2 + 0.5);
  let used = 0;
  for (let b = 0; used < limit - 5 && b < 40; ) {
    const radius = b < schedule.length ? schedule[b]! : (2.0 - 0.2 * ((b - schedule.length) % 3)) * k;
    const quota = Math.floor((limit - used) / Math.max(schedule.length - b, 1));
    b++;
    // orientation field of the photo blurred to this radius
    const R = T.map((p) => blur(p, W, H, Math.max(radius * 0.45, 0.8)));
    const [sx, sy] = sobel(luminance(R[0]!, R[1]!, R[2]!), W, H);
    const sig = Math.max(radius * 1.2, 2);
    const xx = new Float32Array(N), yy = new Float32Array(N), xy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      xx[i] = sx[i]! * sx[i]!;
      yy[i] = sy[i]! * sy[i]!;
      xy[i] = sx[i]! * sy[i]!;
    }
    const jxx = blur(xx, W, H, sig), jyy = blur(yy, W, H, sig), jxy = blur(xy, W, H, sig);
    // weighted error, smoothed to the radius
    const err = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (!inside[i]) continue;
      const dr = C[0]![i]! - T[0]![i]!, dg = C[1]![i]! - T[1]![i]!, db = C[2]![i]! - T[2]![i]!;
      err[i] = Math.sqrt(dr * dr + dg * dg + db * db) * SAL[i]!;
    }
    const errS = blur(err, W, H, radius * 0.6);
    const g = Math.max(Math.round(radius * 1.4), 4);
    const cand: [number, number, number][] = [];
    for (let cy = OY; cy < OY + RH; cy += g) {
      for (let cx = OX; cx < OX + RW; cx += g) {
        let best = -1, bx = cx, by = cy;
        for (let y = cy; y < Math.min(cy + g, OY + RH); y++) {
          for (let x = cx; x < Math.min(cx + g, OX + RW); x++) {
            const v = errS[y * W + x]!;
            if (v > best) { best = v; bx = x; by = y; }
          }
        }
        cand.push([best, bx, by]);
      }
    }
    cand.sort((p, q) => q[0] - p[0]);

    const step = Math.max(radius * 0.8, 2.2 * k);
    const tol = 0.09 + (radius / k) * 0.012;
    const kept: { sy: number; sx: number; pts: [number, number][]; col: [number, number, number] }[] = [];
    for (const [score, cx0, cy0] of cand.slice(0, quota * 6)) {
      if (kept.length >= quota || score < 0.02) break;
      // trace along the structure until the colour under the pen changes
      const i0 = cy0 * W + cx0;
      const start = [R[0]![i0]!, R[1]![i0]!, R[2]![i0]!];
      const pts: [number, number][] = [[cx0 + 0.5, cy0 + 0.5]];
      let x = cx0 + 0.5, y = cy0 + 0.5, dx = 0, dy = 0;
      for (let n = 0; n < 14; n++) {
        const i = Math.min(Math.max(Math.round(y), 0), H - 1) * W + Math.min(Math.max(Math.round(x), 0), W - 1);
        const theta = 0.5 * Math.atan2(2 * jxy[i]!, jxx[i]! - jyy[i]!);
        const coh = Math.hypot(jxx[i]! - jyy[i]!, 2 * jxy[i]!);
        let ndx: number, ndy: number;
        if (coh < 1e-6) {
          if (n === 0) {
            const a = rnd() * Math.PI;
            ndx = Math.cos(a); ndy = Math.sin(a);
          } else {
            ndx = dx; ndy = dy;
          }
        } else {
          // perpendicular to the dominant gradient
          ndx = -Math.sin(theta); ndy = Math.cos(theta);
        }
        if (dx * ndx + dy * ndy < 0) { ndx = -ndx; ndy = -ndy; }
        if (n > 0) {
          ndx = 0.6 * ndx + 0.4 * dx; ndy = 0.6 * ndy + 0.4 * dy;
          const nn = Math.hypot(ndx, ndy) || 1;
          ndx /= nn; ndy /= nn;
        }
        const nx = clampX(x + step * ndx), ny = clampY(y + step * ndy);
        const j = Math.min(Math.round(ny), H - 1) * W + Math.min(Math.round(nx), W - 1);
        const diff = Math.max(Math.abs(R[0]![j]! - start[0]!), Math.abs(R[1]![j]! - start[1]!), Math.abs(R[2]![j]! - start[2]!));
        if (diff > (n >= 3 ? tol : tol * 1.8)) break;
        x = nx; y = ny; dx = ndx; dy = ndy;
        pts.push([x, y]);
      }
      if (pts.length === 1) pts.push([pts[0]![0] + 0.6, pts[0]![1]]);
      // colour = mean photo colour under the whole footprint; keep only if it helps
      const { x0, y0, bw, bh, mask } = footprint(pts);
      let msum = 0;
      const acc = [0, 0, 0];
      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          const m = mask[py * bw + px]!;
          if (m <= 0) continue;
          const i = (y0 + py) * W + x0 + px;
          msum += m;
          for (let ch = 0; ch < 3; ch++) acc[ch]! += T[ch]![i]! * m;
        }
      }
      if (msum < 1) continue;
      const col = acc.map((v) => q8(v / msum)) as [number, number, number];
      let before = 0, after = 0;
      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          const m = mask[py * bw + px]!;
          if (m <= 0) continue;
          const i = (y0 + py) * W + x0 + px;
          const a = m * ALPHA;
          let e0 = 0, e1 = 0;
          for (let ch = 0; ch < 3; ch++) {
            const c = C[ch]![i]!, t = T[ch]![i]!;
            const n1 = c * (1 - a) + col[ch]! * a;
            e0 += (c - t) ** 2;
            e1 += (n1 - t) ** 2;
          }
          before += Math.sqrt(e0) * SAL[i]! * m;
          after += Math.sqrt(e1) * SAL[i]! * m;
        }
      }
      if (after >= before * 0.97) continue;
      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          const a = mask[py * bw + px]! * ALPHA;
          if (a <= 0) continue;
          const i = (y0 + py) * W + x0 + px;
          for (let ch = 0; ch < 3; ch++) C[ch]![i] = C[ch]![i]! * (1 - a) + col[ch]! * a;
        }
      }
      kept.push({ sy: cy0, sx: cx0, pts, col });
    }
    // replay in a serpentine sweep, so the pen moves like a hand filling in
    const band = g * 5;
    kept.sort((p, q) => {
      const bp = Math.floor(p.sy / band), bq = Math.floor(q.sy / band);
      if (bp !== bq) return bp - bq;
      return bp % 2 === 0 ? p.sx - q.sx : q.sx - p.sx;
    });
    for (const s of kept) {
      strokes.push({
        color: `#${hex(s.col[0])}${hex(s.col[1])}${hex(s.col[2])}`,
        pts: s.pts.map(([px, py]) => [Math.round(px * 100) / 100, Math.round(py * 100) / 100]),
      });
    }
    used += kept.length;
    if (b > schedule.length && kept.length < 10) break;
  }

  let diff = 0, count = 0;
  for (let i = 0; i < N; i++) {
    if (!inside[i]) continue;
    diff += Math.abs(C[0]![i]! - T[0]![i]!) + Math.abs(C[1]![i]! - T[1]![i]!) + Math.abs(C[2]![i]! - T[2]![i]!);
    count += 3;
  }
  return { aspect, width: W, height: H, strokes, underpaintStrokes, meanAbsDiff: diff / Math.max(count, 1) };
}
