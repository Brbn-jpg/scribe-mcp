import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { inflateRawSync } from "node:zlib";
import { createScribeServer } from "./server.ts";

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createScribeServer({ baseUrl: "https://example.test" });
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

test("lists the tools", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "board_add",
    "board_connect",
    "board_create",
    "board_delete",
    "board_draw",
    "board_list",
    "board_read",
    "board_update",
    "scribe_create_drawing",
    "scribe_create_video",
    "scribe_limits",
    "scribe_paint_image",
    "todrawn_login",
    "todrawn_logout",
  ]);
});

test("scribe_create_video returns a studio link and the export rules", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "scribe_create_video",
    arguments: { text: "print('hi')", language: "python", aspect: "square", fps: 24 },
  });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /https:\/\/example\.test\/scribe#r=/);
  assert.match(text(result), /5 exports per UTC day/);
});

test("scribe_create_video reports bad input as a tool error", async () => {
  const client = await connect();
  const result = await client.callTool({ name: "scribe_create_video", arguments: { text: "x", language: "cobol" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown language/);
});

test("scribe_limits describes the plans", async () => {
  const client = await connect();
  assert.match(text(await client.callTool({ name: "scribe_limits", arguments: {} })), /Premium/);
});

test("scribe_create_drawing returns a studio link", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "scribe_create_drawing",
    arguments: { paths: [{ d: "M0 0 C 10 20 30 20 40 0", color: "violet" }], background: "paper" },
  });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /https:\/\/example\.test\/scribe#r=/);
  assert.match(text(result), /Artboard: landscape, 1 stroke/);
});

test("scribe_paint_image paints a local file and reports missing ones", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { PNG } = await import("pngjs");
  const png = new PNG({ width: 40, height: 30 });
  for (let i = 0; i < 40 * 30; i++) png.data.set([i % 40 < 20 ? 220 : 30, 90, 60, 255], i * 4);
  const file = join(mkdtempSync(join(tmpdir(), "scribe-srv-")), "two-tone.png");
  writeFileSync(file, PNG.sync.write(png));
  const client = await connect();
  const ok = await client.callTool({ name: "scribe_paint_image", arguments: { imagePath: file, detail: "low" } });
  assert.notEqual(ok.isError, true);
  assert.match(text(ok), /https:\/\/example\.test\/scribe#r=/);
  assert.match(text(ok), /nothing was uploaded/);
  const missing = await client.callTool({ name: "scribe_paint_image", arguments: { imagePath: "/no/such/file.png" } });
  assert.equal(missing.isError, true);
});

function decodeLink(reply: string): { text: string; settings?: Record<string, unknown>; segments?: { start: number; end: number }[] } {
  const url = reply.match(/https:\/\/example\.test\/scribe#r=[A-Za-z0-9_-]+/)![0];
  return JSON.parse(inflateRawSync(Buffer.from(new URL(url).hash.replace(/^#r=/, ""), "base64url")).toString("utf8"));
}

test("scribe_create_video carries segments and the board and camera settings", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "scribe_create_video",
    arguments: {
      text: "const a = 1;\nconst b = 2;",
      language: "ts",
      pattern: "grid",
      density: 48,
      cameraZoom: 150,
      segments: [{ match: "const b", speed: 0.5 }, { fromLine: 1, zoom: 2 }],
    },
  });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /2 passages with their own settings/);
  const payload = decodeLink(text(result));
  assert.deepEqual(payload.settings, { pattern: "grid", density: 48, cameraZoom: 150 });
  assert.deepEqual(payload.segments, [
    { start: 13, end: 20, speed: 0.5 },
    { start: 0, end: 12, zoom: 2 },
  ]);
});

test("scribe_create_video carries the camera tilt and rotation", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "scribe_create_video",
    arguments: { text: "abc", cameraTilt: 65, cameraRotation: -20 },
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(decodeLink(text(result)).settings, { cameraTilt: 65, cameraRotation: -20 });
  const plain = await client.callTool({ name: "scribe_create_video", arguments: { text: "abc" } });
  assert.equal(decodeLink(text(plain)).settings, undefined);
});

test("camera tilt and rotation are validated against the allowed lists", async () => {
  const client = await connect();
  for (const args of [{ cameraTilt: 42 }, { cameraTilt: 95 }, { cameraRotation: 50 }, { cameraRotation: 7 }]) {
    let failed = false;
    try {
      const result = await client.callTool({ name: "scribe_create_video", arguments: { text: "abc", ...args } });
      failed = result.isError === true;
    } catch {
      failed = true;
    }
    assert.equal(failed, true, JSON.stringify(args));
  }
});

test("scribe_create_video reports an invalid segment as a tool error", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "scribe_create_video",
    arguments: { text: "abc", segments: [{ match: "zzz", speed: 1.5 }] },
  });
  assert.equal(result.isError, true);
  assert.match(text(result), /Segment 1: .*not found/);
});

test("scribe_create_drawing passes the board and camera settings through", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "scribe_create_drawing",
    arguments: { paths: [{ d: "M0 0 L40 20" }], pattern: "dots", density: 20, cameraZoom: 75, cameraTilt: 20, cameraRotation: 45 },
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual((decodeLink(text(result)) as { settings?: unknown }).settings, {
    pattern: "dots",
    density: 20,
    cameraZoom: 75,
    cameraTilt: 20,
    cameraRotation: 45,
  });
});

test("scribe_limits mentions segments, patterns, camera and the link size", async () => {
  const client = await connect();
  const limits = text(await client.callTool({ name: "scribe_limits", arguments: {} }));
  assert.match(limits, /Passages:/);
  assert.match(limits, /Board: pattern dots/);
  assert.match(limits, /cameraZoom/);
  assert.match(limits, /cameraTilt/);
  assert.match(limits, /cameraRotation/);
  assert.match(limits, /400000 encoded characters/);
});

test("scribe_create_video carries 2160p and 60 fps in the link and says they need Premium", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "scribe_create_video",
    arguments: { text: "hi", resolution: "2160p", fps: 60 },
  });
  assert.notEqual(result.isError, true);
  const url = text(result).match(/https:\/\/example\.test\/scribe#r=[A-Za-z0-9_-]+/)?.[0] ?? "";
  const payload = JSON.parse(inflateRawSync(Buffer.from(new URL(url).hash.replace(/^#r=/, ""), "base64url")).toString("utf8"));
  assert.equal(payload.settings.resolution, "2160p");
  assert.equal(payload.settings.fps, 60);
  assert.match(text(result), /Premium/);
  assert.match(text(result), /2160p \(4K\) and 60 fps/);
});

test("scribe_create_video rejects a resolution or frame rate the studio does not have", async () => {
  const client = await connect();
  for (const bad of [{ resolution: "4k" }, { fps: 50 }]) {
    const result = await client.callTool({ name: "scribe_create_video", arguments: { text: "x", ...bad } });
    assert.equal(result.isError, true);
  }
});

test("scribe_limits and the tool schema state which output needs Premium", async () => {
  const client = await connect();
  const limits = text(await client.callTool({ name: "scribe_limits", arguments: {} }));
  assert.match(limits, /720p or 1080p, 24 or 30 fps/);
  assert.match(limits, /2160p and 60 fps need a Premium plan; on other plans the studio exports at 1080p and 30 fps instead/);
  const { tools } = await client.listTools();
  const schema = JSON.stringify(tools.find((t) => t.name === "scribe_create_video")?.inputSchema);
  assert.match(schema, /2160p/);
  assert.match(schema, /needs a Premium plan/);
});
