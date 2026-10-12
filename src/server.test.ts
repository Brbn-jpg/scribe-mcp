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

test("lists both tools", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["scribe_create_video", "scribe_limits"]);
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
