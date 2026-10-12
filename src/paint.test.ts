import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { MAX_RECIPE_LINK_CHARS } from "./constants.ts";
import { readImage } from "./image.ts";
import { paintToLink } from "./paint.ts";
import { noiseImage, sampleImage } from "./test-images.ts";

const dir = mkdtempSync(join(tmpdir(), "scribe-paint-"));

function rgba(width: number, height: number, alpha = 255): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([200, 40, 40, alpha], i * 4);
  return data;
}

test("paintToLink returns a draw link carrying paper and pen", () => {
  const link = paintToLink(sampleImage(), { detail: "low", baseUrl: "http://localhost:3100" });
  assert.ok(link.url.startsWith("http://localhost:3100/scribe#r="));
  const payload = JSON.parse(inflateRawSync(Buffer.from(link.url.split("#r=")[1]!, "base64url")).toString("utf8"));
  assert.equal(payload.mode, "draw");
  assert.equal(payload.strokes.length, link.strokes);
  assert.deepEqual(payload.settings, { background: "paper", pen: "fineliner" });
  assert.equal(link.trimmed, 0);
});

test("trims the finest strokes when the link would be too long", () => {
  const cap = 30_000;
  const link = paintToLink(noiseImage(), { detail: "high", maxChars: cap });
  assert.ok(link.trimmed > 0);
  assert.ok(link.url.split("#r=")[1]!.length <= cap);
  // the real cap is honoured by default
  assert.ok(paintToLink(noiseImage(), { detail: "high" }).url.split("#r=")[1]!.length <= MAX_RECIPE_LINK_CHARS);
});

test("reads PNG and JPEG, composites transparency over white", async () => {
  const png = new PNG({ width: 4, height: 3 });
  png.data = rgba(4, 3, 0);
  writeFileSync(join(dir, "clear.png"), PNG.sync.write(png));
  const clear = await readImage(join(dir, "clear.png"));
  assert.deepEqual([clear.width, clear.height, clear.r[0], clear.g[0]], [4, 3, 1, 1]);

  writeFileSync(join(dir, "red.jpg"), jpeg.encode({ width: 8, height: 8, data: rgba(8, 8) }, 95).data);
  const red = await readImage(join(dir, "red.jpg"));
  assert.ok(red.r[0]! > 0.7 && red.g[0]! < 0.3);
});

test("rejects missing and unsupported files with readable errors", async () => {
  await assert.rejects(readImage(join(dir, "nope.png")), /Could not read/);
  writeFileSync(join(dir, "pic.webp"), Buffer.from("RIFF0000WEBPVP8 "));
  await assert.rejects(readImage(join(dir, "pic.webp")), /Only PNG and JPEG/);
});
