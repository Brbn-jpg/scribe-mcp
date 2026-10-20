import { deflateRawSync } from "node:zlib";
import {
  type Aspect,
  type Locale,
  ASPECT_RATIOS,
  ASPECTS,
  DRAW_COLOR_KEYS,
  DRAW_COORD_MAX,
  LOCALE_PATH_PREFIXES,
  MAX_DRAW_POINTS,
  MAX_DRAW_STROKES,
  MAX_RECIPE_LINK_CHARS,
  RECIPE_LINK_VERSION,
} from "./constants.ts";
import { DEFAULT_BASE_URL, LinkError, type LinkSettings } from "./link.ts";
import { PathError, pathToPolylines, type Point } from "./svg-path.ts";

export interface DrawingPath {
  /** SVG path data, e.g. "M10 10 C 20 0, 40 0, 50 10". */
  d: string;
  /** A named ink (blue, red, green, violet, amber) or #rrggbb. Defaults to blue. */
  color?: string;
}

export interface DrawingInput {
  paths: DrawingPath[];
  /** "minX minY width height" framing the drawing; defaults to the paths' bounding box. */
  viewBox?: string;
  aspect?: Aspect;
  settings?: Pick<LinkSettings, "background" | "pen" | "speedMultiplier" | "resolution" | "fps">;
  locale?: Locale;
  baseUrl?: string;
}

export interface BuiltDrawingLink {
  url: string;
  aspect: Aspect;
  strokes: number;
  points: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Share of the artboard left empty around a drawing framed by its own bounding box. */
const AUTO_MARGIN = 0.08;

function parseViewBox(value: string): Box {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2]! <= 0 || parts[3]! <= 0) {
    throw new LinkError(`viewBox must be "minX minY width height" with a positive size, got "${value}".`);
  }
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}

function resolveColor(value: string | undefined): string {
  if (value === undefined) return "blue";
  const color = value.trim().toLowerCase();
  if ((DRAW_COLOR_KEYS as readonly string[]).includes(color) || /^#[0-9a-f]{6}$/.test(color)) return color;
  throw new LinkError(`Unknown colour "${value}". Use ${DRAW_COLOR_KEYS.join(", ")} or #rrggbb.`);
}

function boundingBox(lines: Point[][]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { x: minX, y: minY, w: Math.max(maxX - minX, 1e-9), h: Math.max(maxY - minY, 1e-9) };
}

/** The aspect whose artboard ratio is closest to the content's, on a log scale. */
function closestAspect(ratio: number): Aspect {
  let best: Aspect = "square";
  for (const aspect of ASPECTS) {
    if (Math.abs(Math.log(ASPECT_RATIOS[aspect] / ratio)) < Math.abs(Math.log(ASPECT_RATIOS[best] / ratio))) best = aspect;
  }
  return best;
}

/** Builds a /scribe#r= link for a drawing; throws LinkError with a message meant for the agent. */
export function buildDrawingLink(input: DrawingInput): BuiltDrawingLink {
  if (input.paths.length === 0) throw new LinkError("Pass at least one path to draw.");
  const frame = input.viewBox === undefined ? null : parseViewBox(input.viewBox);

  const flatten = (tolerance: number) =>
    input.paths.map((path, index) => {
      try {
        return pathToPolylines(path.d, tolerance);
      } catch (error) {
        if (error instanceof PathError) throw new LinkError(`Path ${index + 1}: ${error.message}`);
        throw error;
      }
    });
  // a coarse pass sizes the drawing, then the real pass flattens with a
  // tolerance relative to that size, so a 24-unit icon and a 2000-unit
  // illustration come out equally smooth
  const coarse = flatten(Number.POSITIVE_INFINITY).flat();
  if (coarse.length === 0) throw new LinkError("The paths contain nothing to draw (every subpath is a single point).");
  const coarseBox = frame ?? boundingBox(coarse);
  const lines = flatten(Math.max(coarseBox.w, coarseBox.h) / 300);
  const content = frame ?? boundingBox(lines.flat());

  const aspect = input.aspect ?? closestAspect(content.w / content.h);
  const ratio = ASPECT_RATIOS[aspect];
  // artboard units: width `ratio`, height 1
  const margin = frame ? 0 : AUTO_MARGIN;
  const scale = Math.min((ratio * (1 - 2 * margin)) / content.w, (1 - 2 * margin) / content.h);
  const cx = content.x + content.w / 2;
  const cy = content.y + content.h / 2;
  const toCoord = (value: number) => {
    // NaN/Infinity from overflowing arithmetic would serialise as null and the
    // studio would reject the whole link (#470)
    if (!Number.isFinite(value)) throw new LinkError("The drawing has coordinates that are out of range.");
    return Math.min(DRAW_COORD_MAX, Math.max(0, Math.round(value * DRAW_COORD_MAX)));
  };

  const strokes: { color: string; pts: number[] }[] = [];
  let points = 0;
  input.paths.forEach((path, index) => {
    const color = resolveColor(path.color);
    for (const line of lines[index]!) {
      const pts: number[] = [];
      for (const [x, y] of line) {
        const u = toCoord((ratio / 2 + (x - cx) * scale) / ratio);
        const v = toCoord(0.5 + (y - cy) * scale);
        if (pts.length >= 2 && pts[pts.length - 2] === u && pts[pts.length - 1] === v) continue;
        pts.push(u, v);
      }
      if (pts.length < 4) continue;
      strokes.push({ color, pts });
      points += pts.length / 2;
    }
  });
  if (strokes.length === 0) throw new LinkError("The drawing is too small to see once fitted to the artboard.");
  if (strokes.length > MAX_DRAW_STROKES || points > MAX_DRAW_POINTS) {
    throw new LinkError(`The drawing has ${strokes.length} strokes and ${points} points; Scribe accepts ${MAX_DRAW_STROKES} and ${MAX_DRAW_POINTS}.`);
  }

  const link = encodeDrawLink({ aspect, strokes, settings: input.settings, locale: input.locale, baseUrl: input.baseUrl });
  if (link === null) {
    throw new LinkError(`This drawing is too detailed for a link (limit ${MAX_RECIPE_LINK_CHARS} encoded characters). Use fewer or simpler paths.`);
  }
  return { url: link, aspect, strokes: strokes.length, points };
}

export interface DrawLinkInput {
  aspect: Aspect;
  /** pts flat [x0, y0, ...] in 0..DRAW_COORD_MAX of the artboard. */
  strokes: { color: string; pts: number[] }[];
  settings?: Record<string, unknown>;
  locale?: Locale;
  baseUrl?: string;
  /** Link cap override for tests; defaults to the studio's MAX_RECIPE_LINK_CHARS. */
  maxChars?: number;
}

/** Encodes a mode "draw" recipe link, or null when it would exceed the link cap. */
export function encodeDrawLink(input: DrawLinkInput): string | null {
  const settings = Object.fromEntries(Object.entries(input.settings ?? {}).filter(([, value]) => value !== undefined));
  const payload = {
    v: RECIPE_LINK_VERSION,
    mode: "draw",
    aspect: input.aspect,
    strokes: input.strokes,
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 }).toString("base64url");
  if (encoded.length > (input.maxChars ?? MAX_RECIPE_LINK_CHARS)) return null;
  const base = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return `${base}${LOCALE_PATH_PREFIXES[input.locale ?? "en"]}/scribe#r=${encoded}`;
}
