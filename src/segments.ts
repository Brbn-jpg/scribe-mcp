import { MAX_SEGMENTS, PENS, SEGMENT_LIMITS } from "./constants.ts";
import { LinkError } from "./link-error.ts";

/** How an agent selects a passage and what to do with it; exactly one selector, at least one param. */
export interface SegmentInput {
  /** An exact, case-sensitive substring of the text. */
  match?: string;
  /** Which occurrence of `match`, 1-based. Defaults to 1. */
  occurrence?: number;
  /** First line of the passage, 1-based. */
  fromLine?: number;
  /** Last line of the passage, 1-based and inclusive. Defaults to fromLine. */
  toLine?: number;
  speed?: number;
  size?: number;
  pen?: (typeof PENS)[number];
  pauseAfter?: number;
  zoom?: number;
}

/** A segment as it travels in the link: half-open UTF-16 offsets over the normalized text. */
export interface LinkSegment {
  start: number;
  end: number;
  speed?: number;
  size?: number;
  pen?: (typeof PENS)[number];
  pauseAfter?: number;
  zoom?: number;
}

const RANGE_KEYS = ["speed", "size", "pauseAfter", "zoom"] as const;

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

function resolveSpan(text: string, input: SegmentInput, label: string): [number, number] {
  const hasMatch = input.match !== undefined;
  const hasLines = input.fromLine !== undefined || input.toLine !== undefined;
  if (hasMatch === hasLines) {
    throw new LinkError(`${label}: give exactly one selector: "match" (an exact piece of the text) or "fromLine" (with optional "toLine").`);
  }

  if (hasMatch) {
    // the text was normalised to LF, so the match is too
    const needle = String(input.match).replace(/\r\n?/g, "\n");
    if (needle === "") throw new LinkError(`${label}: "match" is empty. Pass an exact, non-empty piece of the text.`);
    const occurrence = input.occurrence ?? 1;
    if (!isInt(occurrence) || occurrence < 1) {
      throw new LinkError(`${label}: "occurrence" must be a whole number from 1, got ${String(input.occurrence)}.`);
    }
    let at = -1;
    let found = 0;
    for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + needle.length)) {
      found++;
      if (found === occurrence) {
        at = from;
        break;
      }
    }
    if (at === -1) {
      const total = countOccurrences(text, needle);
      if (total === 0) {
        throw new LinkError(`${label}: "match" was not found in the text. It must be an exact, case-sensitive substring, including spaces and indentation.`);
      }
      throw new LinkError(`${label}: occurrence ${occurrence} of "match" was requested but the text contains it only ${total} time${total === 1 ? "" : "s"}.`);
    }
    return [at, at + needle.length];
  }

  if (input.occurrence !== undefined) {
    throw new LinkError(`${label}: "occurrence" only applies together with "match".`);
  }
  if (input.fromLine === undefined) throw new LinkError(`${label}: "toLine" needs "fromLine".`);
  const lines = text.split("\n");
  const fromLine = input.fromLine;
  const toLine = input.toLine ?? fromLine;
  if (!isInt(fromLine) || !isInt(toLine) || fromLine < 1 || toLine < 1 || fromLine > lines.length || toLine > lines.length) {
    throw new LinkError(`${label}: line numbers are 1-based whole numbers and the text has ${lines.length} line${lines.length === 1 ? "" : "s"}; got fromLine ${String(fromLine)}, toLine ${String(toLine)}.`);
  }
  if (toLine < fromLine) {
    throw new LinkError(`${label}: "toLine" (${toLine}) is before "fromLine" (${fromLine}). The text has ${lines.length} line${lines.length === 1 ? "" : "s"}.`);
  }
  let start = 0;
  for (let i = 0; i < fromLine - 1; i++) start += lines[i]!.length + 1;
  let end = start;
  for (let i = fromLine - 1; i < toLine; i++) end += lines[i]!.length + (i < toLine - 1 ? 1 : 0);
  if (end <= start) {
    throw new LinkError(`${label}: lines ${fromLine} to ${toLine} are empty, so there is nothing to apply the settings to. Pick lines with text.`);
  }
  return [start, end];
}

/**
 * Turns the agent's passages into the link's segments over the normalised
 * text. Order is kept: the studio lets a later segment win where they overlap.
 */
export function resolveSegments(text: string, inputs: readonly SegmentInput[]): LinkSegment[] {
  if (inputs.length > MAX_SEGMENTS) {
    throw new LinkError(`Too many segments: ${inputs.length}; at most ${MAX_SEGMENTS}. Merge neighbouring passages.`);
  }
  return inputs.map((input, index) => {
    const label = `Segment ${index + 1}`;
    const [start, end] = resolveSpan(text, input, label);
    const out: LinkSegment = { start, end };
    let params = 0;
    for (const key of RANGE_KEYS) {
      const value = input[key];
      if (value === undefined) continue;
      const [min, max] = SEGMENT_LIMITS[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        throw new LinkError(`${label}: "${key}" must be a number from ${min} to ${max}, got ${String(value)}.`);
      }
      params++;
    }
    if (input.pen !== undefined && !(PENS as readonly string[]).includes(input.pen)) {
      throw new LinkError(`${label}: unknown pen "${String(input.pen)}". Use one of: ${PENS.join(", ")}.`);
    }
    if (input.speed !== undefined) out.speed = input.speed;
    if (input.size !== undefined) out.size = input.size;
    if (input.pen !== undefined) out.pen = input.pen;
    if (input.pauseAfter !== undefined) out.pauseAfter = input.pauseAfter;
    if (input.zoom !== undefined) out.zoom = input.zoom;
    if (input.pen !== undefined) params++;
    if (params === 0) {
      throw new LinkError(`${label}: give at least one of speed, size, pen, pauseAfter, zoom, otherwise the passage changes nothing.`);
    }
    return out;
  });
}
