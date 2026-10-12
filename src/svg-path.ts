/* SVG path data -> polylines. Agents describe drawings most reliably as SVG
   paths, while a Scribe drawing is a list of pen polylines, so every curve is
   flattened here. Supports the full path grammar: M L H V C S Q T A Z, both
   absolute and relative, implicit command repetition and packed arc flags. */

export type Point = [number, number];

export class PathError extends Error {}

const COMMAND_ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

type Token = { cmd: string } | { num: number };

function tokenize(d: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  // arc flags may be packed ("a1 1 0 01-1 1"), so the tokenizer tracks the
  // argument index inside the current arc to read 0/1 flags as single digits
  let cmd = "";
  let argIndex = 0;
  while (i < d.length) {
    const ch = d[i]!;
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    if (/[MLHVCSQTAZmlhvcsqtaz]/.test(ch)) {
      tokens.push({ cmd: ch });
      cmd = ch.toUpperCase();
      argIndex = 0;
      i++;
      continue;
    }
    const arity = COMMAND_ARITY[cmd] ?? 0;
    const slot = arity > 0 ? argIndex % arity : 0;
    if (cmd === "A" && (slot === 3 || slot === 4) && (ch === "0" || ch === "1")) {
      tokens.push({ num: ch === "1" ? 1 : 0 });
      argIndex++;
      i++;
      continue;
    }
    const match = NUMBER.exec(d.slice(i));
    if (!match) throw new PathError(`Unexpected "${ch}" at position ${i} in path data.`);
    tokens.push({ num: Number(match[0]) });
    argIndex++;
    i += match[0].length;
  }
  return tokens;
}

/** Number of straight segments for a curve of the given control-polygon length. */
function steps(length: number, tolerance: number): number {
  return Math.min(256, Math.max(4, Math.ceil(length / tolerance)));
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Endpoint-parameterised SVG arc (spec F.6.5) flattened to points after `from`. */
function arcPoints(
  from: Point,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: Point,
  tolerance: number,
): Point[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (from[0] === to[0] && from[1] === to[1])) return [to];
  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (from[0] + to[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (from[1] + to[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = steps(Math.abs(delta) * Math.max(rx, ry), tolerance);
  const out: Point[] = [];
  for (let k = 1; k <= n; k++) {
    const t = theta1 + (delta * k) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  out[out.length - 1] = to;
  return out;
}

/**
 * Parses path data into polylines, one per subpath. `tolerance` is the target
 * length of one flattened curve segment, in the path's own units.
 */
export function pathToPolylines(d: string, tolerance: number): Point[][] {
  const tokens = tokenize(d);
  const lines: Point[][] = [];
  let line: Point[] = [];
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let i = 0;
  let cmd = "";

  const take = (n: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const token = tokens[i++];
      if (!token || !("num" in token)) throw new PathError(`Command "${cmd}" is missing arguments.`);
      out.push(token.num);
    }
    return out;
  };
  const flush = () => {
    if (line.length > 1) lines.push(line);
    line = [];
  };
  const lineTo = (p: Point) => {
    if (line.length === 0) line.push(cur);
    line.push(p);
    cur = p;
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if ("cmd" in token) {
      cmd = token.cmd;
      i++;
    } else if (!cmd) {
      throw new PathError("Path data must start with a command such as M.");
    }
    if (cmd.toUpperCase() === "Z") {
      if (line.length > 0) lineTo(start);
      flush();
      cur = start;
      lastCubic = lastQuad = null;
      continue;
    }
    const arity = COMMAND_ARITY[cmd.toUpperCase()];
    if (arity === undefined) throw new PathError(`Unknown command "${cmd}".`);
    // a command letter followed by no numbers is an error, except Z handled above
    if (i >= tokens.length || "cmd" in tokens[i]!) throw new PathError(`Command "${cmd}" is missing arguments.`);

    do {
      // recomputed per repetition: extra pairs after M continue as L
      const upper = cmd.toUpperCase();
      const rel = cmd !== upper;
      const at = (x: number, y: number): Point => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
      const a = take(arity);
      let nextCubic: Point | null = null;
      let nextQuad: Point | null = null;
      switch (upper) {
        case "M": {
          flush();
          cur = at(a[0]!, a[1]!);
          start = cur;
          // further pairs after M are implicit L
          cmd = rel ? "l" : "L";
          break;
        }
        case "L":
          lineTo(at(a[0]!, a[1]!));
          break;
        case "H":
          lineTo([rel ? cur[0] + a[0]! : a[0]!, cur[1]]);
          break;
        case "V":
          lineTo([cur[0], rel ? cur[1] + a[0]! : a[0]!]);
          break;
        case "C":
        case "S": {
          const p0 = cur;
          const p1: Point =
            upper === "C"
              ? at(a[0]!, a[1]!)
              : lastCubic
                ? [2 * p0[0] - lastCubic[0], 2 * p0[1] - lastCubic[1]]
                : p0;
          const p2 = upper === "C" ? at(a[2]!, a[3]!) : at(a[0]!, a[1]!);
          const p3 = upper === "C" ? at(a[4]!, a[5]!) : at(a[2]!, a[3]!);
          const n = steps(dist(p0, p1) + dist(p1, p2) + dist(p2, p3), tolerance);
          for (let k = 1; k <= n; k++) {
            const t = k / n;
            const u = 1 - t;
            lineTo([
              u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
            ]);
          }
          cur = p3;
          nextCubic = p2;
          break;
        }
        case "Q":
        case "T": {
          const p0 = cur;
          const p1: Point =
            upper === "Q"
              ? at(a[0]!, a[1]!)
              : lastQuad
                ? [2 * p0[0] - lastQuad[0], 2 * p0[1] - lastQuad[1]]
                : p0;
          const p2 = upper === "Q" ? at(a[2]!, a[3]!) : at(a[0]!, a[1]!);
          const n = steps(dist(p0, p1) + dist(p1, p2), tolerance);
          for (let k = 1; k <= n; k++) {
            const t = k / n;
            const u = 1 - t;
            lineTo([
              u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
              u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
            ]);
          }
          cur = p2;
          nextQuad = p1;
          break;
        }
        case "A": {
          const to = at(a[5]!, a[6]!);
          for (const p of arcPoints(cur, a[0]!, a[1]!, a[2]!, a[3] !== 0, a[4] !== 0, to, tolerance)) lineTo(p);
          break;
        }
      }
      lastCubic = nextCubic;
      lastQuad = nextQuad;
    } while (i < tokens.length && !("cmd" in tokens[i]!));
  }
  flush();
  return lines;
}
