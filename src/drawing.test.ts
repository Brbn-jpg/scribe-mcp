import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildDrawingLink } from "./drawing.ts";

type Payload = { v: number; mode: string; aspect: string; strokes: { color: string; pts: number[] }[]; settings?: object };
function decode(url: string): Payload {
  return JSON.parse(inflateRawSync(Buffer.from(new URL(url).hash.replace(/^#r=/, ""), "base64url")).toString("utf8"));
}

test("fits a drawing to the closest artboard with a margin", () => {
  const link = buildDrawingLink({ paths: [{ d: "M0 0 H200 V100 H0 Z", color: "red" }] });
  const payload = decode(link.url);
  assert.equal(payload.mode, "draw");
  assert.equal(payload.aspect, "landscape");
  assert.equal(payload.strokes[0]!.color, "red");
  const xs = payload.strokes[0]!.pts.filter((_, i) => i % 2 === 0);
  const ys = payload.strokes[0]!.pts.filter((_, i) => i % 2 === 1);
  // 2:1 content on a 16:9 board is width-bound: 8% margin left and right, centred vertically
  assert.equal(Math.min(...xs), 800);
  assert.equal(Math.max(...xs), 9200);
  assert.equal(Math.min(...ys) + Math.max(...ys), 10000);
});

test("honours an explicit viewBox, aspect, colours and settings", () => {
  const link = buildDrawingLink({
    paths: [{ d: "M0 0 L100 100" }, { d: "M0 100 L100 0", color: "#00AA00" }],
    viewBox: "0 0 100 100",
    aspect: "square",
    settings: { background: "paper", pen: "marker" },
    locale: "pl",
    baseUrl: "http://localhost:3100",
  });
  assert.ok(link.url.startsWith("http://localhost:3100/pl/scribe#r="));
  const payload = decode(link.url);
  assert.deepEqual(payload.strokes[0], { color: "blue", pts: [0, 0, 10000, 10000] });
  assert.equal(payload.strokes[1]!.color, "#00aa00");
  assert.deepEqual(payload.settings, { background: "paper", pen: "marker" });
});

test("rejects bad colours, paths and viewBoxes with the path number", () => {
  assert.throws(() => buildDrawingLink({ paths: [{ d: "M0 0 L1 1", color: "pink" }] }), /Unknown colour/);
  assert.throws(() => buildDrawingLink({ paths: [{ d: "M0 0 L1 1" }, { d: "Q" }] }), /Path 2/);
  assert.throws(() => buildDrawingLink({ paths: [{ d: "M0 0 L1 1" }], viewBox: "0 0 0 10" }), /viewBox/);
  assert.throws(() => buildDrawingLink({ paths: [{ d: "M5 5" }] }), /nothing to draw/);
});

test("never emits non-finite coordinates (#470)", () => {
  assert.throws(() => buildDrawingLink({ paths: [{ d: "M 1e999 0 L 1 1" }] }), /Path 1/);
  // finite inputs whose arithmetic overflows must not become null either
  assert.throws(() => buildDrawingLink({ paths: [{ d: "M 0 0 L 1e308 1e308 L -1e308 -1e308" }] }));
});
