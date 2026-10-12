import { type Aspect, DRAW_COORD_MAX, type Locale } from "./constants.ts";
import { encodeDrawLink } from "./drawing.ts";
import { LinkError } from "./link.ts";
import { type Detail, type Painting, paintImage, type Pen, type RgbImage } from "./painter.ts";

export interface PaintLinkInput {
  aspect?: Aspect;
  pen?: Pen;
  detail?: Detail;
  background?: "paper" | "dark";
  speedMultiplier?: number;
  locale?: Locale;
  baseUrl?: string;
  /** Link cap override for tests. */
  maxChars?: number;
}

export interface PaintedLink {
  url: string;
  aspect: Aspect;
  strokes: number;
  /** Strokes dropped from the end (the finest detail) to fit the link cap. */
  trimmed: number;
  meanAbsDiff: number;
}

/** Paints an image and packs it into a /scribe#r= draw link, trimming the finest strokes if the link would be too long. */
export function paintToLink(image: RgbImage, input: PaintLinkInput = {}): PaintedLink {
  const painting: Painting = paintImage(image, { aspect: input.aspect, pen: input.pen, detail: input.detail });
  const q = (v: number, max: number) => Math.min(DRAW_COORD_MAX, Math.max(0, Math.round((v / max) * DRAW_COORD_MAX)));
  const all = painting.strokes.map((s) => {
    const pts = s.pts.flatMap(([x, y]) => [q(x, painting.width), q(y, painting.height)]);
    // a stroke that collapsed onto one coordinate still needs two points
    if (pts.length === 4 && pts[0] === pts[2] && pts[1] === pts[3]) pts[2] = Math.min(DRAW_COORD_MAX, pts[2]! + 1);
    return { color: s.color, pts };
  });
  const settings = { background: input.background ?? "paper", pen: input.pen ?? "fineliner", speedMultiplier: input.speedMultiplier };
  let keep = all.length;
  for (;;) {
    const url = encodeDrawLink({ aspect: painting.aspect, strokes: all.slice(0, keep), settings, locale: input.locale, baseUrl: input.baseUrl, maxChars: input.maxChars });
    if (url) return { url, aspect: painting.aspect, strokes: keep, trimmed: all.length - keep, meanAbsDiff: painting.meanAbsDiff };
    keep = Math.floor(keep * 0.93);
    if (keep <= painting.underpaintStrokes) {
      throw new LinkError("This image is too detailed to fit in a link even at its coarsest. Try detail \"low\" or a smaller artboard.");
    }
  }
}
