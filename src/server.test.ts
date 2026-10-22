import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
