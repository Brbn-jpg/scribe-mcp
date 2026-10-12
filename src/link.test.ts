import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { MAX_INPUT_BYTES, MAX_LINES } from "./constants.ts";
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
  const noise = randomBytes(150_000).toString("base64").replace(/.{76}/g, "$&\n");
  assert.throws(() => buildRecipeLink({ text: noise }), /too large for a link/);
});
