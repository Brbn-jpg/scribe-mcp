import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { MAX_INPUT_BYTES, MAX_LINES, MAX_SEGMENTS } from "./constants.ts";
import { buildRecipeLink, LinkError, resolveLanguage } from "./link.ts";

function decode(url: string): unknown {
  const payload = new URL(url).hash.replace(/^#r=/, "");
  return JSON.parse(inflateRawSync(Buffer.from(payload, "base64url")).toString("utf8"));
}

test("builds a /scribe link carrying the project", () => {
  const link = buildRecipeLink({ text: "const a = 1;\r\nconst b = 2;", language: "typescript", aspect: "portrait", settings: { background: "paper" } });
  assert.match(link.url, /^https:\/\/todrawn\.com\/scribe#r=[A-Za-z0-9_-]+$/);
  assert.equal(link.language, "ts");
  assert.equal(link.lines, 2);
  assert.deepEqual(decode(link.url), {
    v: 1,
    text: "const a = 1;\nconst b = 2;",
    language: "ts",
    aspect: "portrait",
    settings: { background: "paper" },
  });
});

test("omits empty optional fields and honours locale and base URL", () => {
  const link = buildRecipeLink({ text: "hi", locale: "pt-BR", baseUrl: "http://localhost:3000/" });
  assert.ok(link.url.startsWith("http://localhost:3000/pt-br/scribe#r="));
  assert.deepEqual(decode(link.url), { v: 1, text: "hi", language: "plain" });
});

test("maps language aliases and rejects unknown ones", () => {
  assert.equal(resolveLanguage("Python"), "py");
  assert.equal(resolveLanguage("c++"), "clike");
  assert.equal(resolveLanguage(undefined), "plain");
  assert.throws(() => resolveLanguage("cobol"), LinkError);
});

test("rejects empty, oversized and too-long input with readable errors", () => {
  assert.throws(() => buildRecipeLink({ text: "  \n " }), /empty/);
  assert.throws(() => buildRecipeLink({ text: "a".repeat(MAX_INPUT_BYTES + 1) }), /bytes/);
  assert.throws(() => buildRecipeLink({ text: "x\n".repeat(MAX_LINES) }), /lines/);
});

test("rejects text that does not fit in a link", () => {
  // random bytes do not compress, so this overflows the encoded cap long before 1 MiB
  const noise = randomBytes(330_000).toString("base64").replace(/.{200}/g, "$&\n");
  assert.throws(() => buildRecipeLink({ text: noise }), /too large for a link/);
});

test("rejects text whose JSON form exceeds the studio's inflate cap (#470)", () => {
  // every quote is escaped, so the JSON is ~2x the raw bytes: under the 1 MiB
  // text cap but over the decoder's MAX_INPUT_BYTES + 64 KiB
  const text = '"'.repeat(MAX_INPUT_BYTES - 10);
  assert.throws(() => buildRecipeLink({ text }), LinkError);
});

test("carries segments selected by match, with CRLF and an emoji before the passage", () => {
  // the CRLF is normalised to LF and the emoji is two UTF-16 units, so the
  // offsets must be computed on the normalised text, not the agent's input
  const text = "intro \u{1F600}\r\nconst a = 1;\r\nconst b = 2;\r\nconst a = 3;";
  const normalized = text.replace(/\r\n/g, "\n");
  const link = buildRecipeLink({
    text,
    segments: [
      { match: "const a", occurrence: 2, speed: 0.5, pen: "marker" },
      { match: "const b = 2;\r\nconst a", zoom: 1.5, pauseAfter: 1 },
    ],
  });
  assert.equal(link.segments, 2);
  const payload = decode(link.url) as { text: string; segments: { start: number; end: number }[] };
  assert.equal(payload.text, normalized);
  const second = normalized.lastIndexOf("const a");
  assert.deepEqual(payload.segments[0], { start: second, end: second + 7, speed: 0.5, pen: "marker" });
  const first = normalized.indexOf("const b");
  assert.deepEqual(payload.segments[1], { start: first, end: second + 7, pauseAfter: 1, zoom: 1.5 });
  assert.equal(payload.text.slice(first, second + 7), "const b = 2;\nconst a");
});

test("carries segments selected by line", () => {
  const link = buildRecipeLink({
    text: "one\r\ntwo\r\nthree\r\n",
    segments: [{ fromLine: 2, size: 1.5 }, { fromLine: 1, toLine: 3, speed: 2 }],
  });
  const payload = decode(link.url) as { segments: unknown[] };
  assert.deepEqual(payload.segments, [
    { start: 4, end: 7, size: 1.5 },
    { start: 0, end: 13, speed: 2 },
  ]);
});

test("omits segments when none are given or the list is empty", () => {
  assert.deepEqual(decode(buildRecipeLink({ text: "hi", segments: [] }).url), { v: 1, text: "hi", language: "plain" });
});

test("rejects bad segments with the segment number and a hint", () => {
  const text = "alpha\n\nbeta alpha";
  const bad = (segment: object, pattern: RegExp) =>
    assert.throws(() => buildRecipeLink({ text, segments: [{ match: "alpha", speed: 1.5 }, segment] }), (error) => {
      assert.ok(error instanceof LinkError);
      assert.match(error.message, /^Segment 2: /);
      assert.match(error.message, pattern);
      return true;
    });
  bad({ speed: 1.5 }, /exactly one selector/);
  bad({ match: "alpha", fromLine: 1, speed: 1.5 }, /exactly one selector/);
  bad({ match: "", speed: 1.5 }, /empty/);
  bad({ match: "gamma", speed: 1.5 }, /not found/);
  bad({ match: "alpha", occurrence: 3, speed: 1.5 }, /only 2 times/);
  bad({ fromLine: 4, speed: 1.5 }, /3 lines/);
  bad({ fromLine: 0, speed: 1.5 }, /3 lines/);
  bad({ fromLine: 3, toLine: 1, speed: 1.5 }, /before.*3 lines/);
  bad({ fromLine: 2, speed: 1.5 }, /empty/);
  bad({ match: "alpha" }, /at least one/);
  bad({ match: "alpha", speed: 3 }, /"speed".*0\.5 to 2/);
  bad({ match: "alpha", size: 0.1 }, /"size"/);
  bad({ match: "alpha", pauseAfter: 4 }, /"pauseAfter"/);
  bad({ match: "alpha", zoom: 3 }, /"zoom"/);
  bad({ match: "alpha", pen: "brush" }, /unknown pen/);
  assert.throws(
    () => buildRecipeLink({ text, segments: Array.from({ length: MAX_SEGMENTS + 1 }, () => ({ match: "alpha", speed: 1.5 })) }),
    /Too many segments/,
  );
});

test("carries the chalk pen, for the whole video and for one passage", () => {
  const link = buildRecipeLink({
    text: "alpha\nbeta",
    settings: { background: "dark", pen: "chalk" },
    segments: [{ match: "beta", pen: "chalk" }],
  });
  const payload = decode(link.url) as { settings: { pen: string }; segments: { pen: string }[] };
  assert.equal(payload.settings.pen, "chalk");
  assert.equal(payload.segments[0]?.pen, "chalk");
});
