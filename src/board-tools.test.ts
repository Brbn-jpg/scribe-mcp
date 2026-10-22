import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuthManager, TokenStore } from "./auth.ts";
import { createScribeServer } from "./server.ts";
import { TodrawnApi } from "./todrawn-api.ts";

const config = { apiUrl: "https://api.example.test", appUrl: "https://app.example.test" };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

type Handler = (req: { method: string; path: string; body?: any; auth?: string }) => { status?: number; body?: unknown } | undefined;

async function setup(handler: Handler, options: { signedIn?: boolean } = {}) {
  const store = new TokenStore(join(mkdtempSync(join(tmpdir(), "todrawn-bt-")), "todrawn", "mcp-token.json"));
  if (options.signedIn !== false) store.write({ apiUrl: config.apiUrl, accessToken: "tdmcp_t", expiresAt: FUTURE });
  const requests: { method: string; path: string; body?: any }[] = [];
  let n = 0;
  const api = new TodrawnApi(config, async (url, init) => {
    const u = new URL(url);
    const req = {
      method: init?.method ?? "GET",
      path: u.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string>).Authorization,
    };
    requests.push({ method: req.method, path: req.path, body: req.body });
    const reply = handler(req) ?? { status: 404, body: { message: "unhandled" } };
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  });
  const auth = new AuthManager({ api, store, env: {}, sleep: () => new Promise<void>(() => undefined) });
  const server = createScribeServer({ baseUrl: "https://example.test", board: { api, auth, clientName: () => "Test client on host", newId: () => `e${++n}` } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, requests, auth };
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => ((r.content as { text: string }[])[0]?.text ?? "");

const BOARD = "11111111-1111-4111-8111-111111111111";
const board = (elements: unknown[] = [], extra: object = {}) => ({ id: BOARD, title: "Plan", live: true, seq: 3, scene: { version: 1, background: "#ffffff", elements, ...extra } });

test("board tools without a login point at todrawn_login", async () => {
  const { client, requests } = await setup(() => undefined, { signedIn: false });
  for (const [name, args] of [["board_list", {}], ["board_read", { boardId: BOARD }], ["board_create", { title: "x" }]] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(text(result), /todrawn_login/);
  }
  assert.equal(requests.length, 0);
});

test("todrawn_login starts the device flow and reports the link; board tools echo it while pending", async () => {
  const { client, requests } = await setup(
    (req) => {
      if (req.path === "/api/auth/mcp/device") {
        return { body: { deviceCode: "d", userCode: "BCDF-GHJK", verificationUri: "u", verificationUriComplete: "https://app.example.test/connect?code=BCDF-GHJK", expiresIn: 600, interval: 5 } };
      }
      if (req.path === "/api/auth/mcp/token") return { body: { status: "pending" } };
      return undefined;
    },
    { signedIn: false },
  );
  const login = await client.callTool({ name: "todrawn_login", arguments: {} });
  assert.notEqual(login.isError, true);
  assert.match(text(login), /connect\?code=BCDF-GHJK/);
  assert.match(text(login), /Code: BCDF-GHJK/);
  assert.deepEqual(requests[0]!.body, { clientName: "Test client on host" });
  const blocked = await client.callTool({ name: "board_list", arguments: {} });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /connect\?code=BCDF-GHJK/);
  // calling login again does not start a second flow
  await client.callTool({ name: "todrawn_login", arguments: {} });
  assert.equal(requests.filter((r) => r.path === "/api/auth/mcp/device").length, 1);
});

test("todrawn_login says who is signed in; logout revokes", async () => {
  const { client, requests } = await setup((req) => {
    if (req.path === "/api/mcp/me") return { body: { email: "a@b.test", tier: "FREE", maxBoards: 3, maxImagesPerBoard: 5 } };
    if (req.path === "/api/mcp/token") return { status: 204 };
    return undefined;
  });
  assert.match(text(await client.callTool({ name: "todrawn_login", arguments: {} })), /Signed in as a@b\.test \(FREE, up to 3 boards\)/);
  assert.match(text(await client.callTool({ name: "todrawn_logout", arguments: {} })), /revoked/);
  assert.ok(requests.some((r) => r.method === "DELETE" && r.path === "/api/mcp/token"));
  assert.match(text(await client.callTool({ name: "board_list", arguments: {} })), /todrawn_login/);
});

test("board_list and board_create", async () => {
  const { client } = await setup((req) => {
    if (req.method === "GET" && req.path === "/api/mcp/boards") {
      return { body: [{ id: BOARD, title: "Plan", owned: true, updatedAt: "2026-10-01T10:00:00Z" }, { id: "b2", title: "Team", owned: false, updatedAt: "2026-09-01T10:00:00Z" }] };
    }
    if (req.method === "POST" && req.path === "/api/mcp/boards") {
      return req.body.title === "full" ? { status: 402, body: { message: "Free plan allows 3 whiteboards" } } : { status: 201, body: { id: BOARD, title: req.body.title } };
    }
    return undefined;
  });
  const list = text(await client.callTool({ name: "board_list", arguments: {} }));
  assert.match(list, new RegExp(`${BOARD} \\| "Plan" \\| owned \\| updated 2026-10-01 \\| https://app\\.example\\.test/board/${BOARD}`));
  assert.match(list, /b2 \| "Team" \| shared/);
  const created = await client.callTool({ name: "board_create", arguments: { title: "New" } });
  assert.match(text(created), new RegExp(`URL: https://app\\.example\\.test/board/${BOARD}`));
  const limit = await client.callTool({ name: "board_create", arguments: { title: "full" } });
  assert.equal(limit.isError, true);
  assert.match(text(limit), /Free plan allows 3 whiteboards/);
});

test("board_read gives a summary or the raw scene", async () => {
  const { client } = await setup((req) => (req.path === `/api/mcp/boards/${BOARD}` ? { body: board([{ id: "r1", type: "rect", x: 1, y: 2, w: 30, h: 40, stroke: "#000000", strokeWidth: 3 }]) } : undefined));
  const summary = text(await client.callTool({ name: "board_read", arguments: { boardId: BOARD } }));
  assert.match(summary, /1 element, live/);
  assert.match(summary, /r1 rect \| x=1 y=2 w=30 h=40/);
  const full = JSON.parse(text(await client.callTool({ name: "board_read", arguments: { boardId: BOARD, format: "full" } })));
  assert.equal(full.scene.elements[0].id, "r1");
  assert.equal(full.live, true);
});

test("a never-drawn board (null scene) reads as empty", async () => {
  const { client } = await setup(() => ({ body: { id: BOARD, title: "Blank", live: false, seq: 0, scene: null } }));
  assert.match(text(await client.callTool({ name: "board_read", arguments: { boardId: BOARD } })), /board is empty/);
});

test("board_add sends add ops and reports applied and rejected", async () => {
  const { client, requests } = await setup((req) => {
    if (req.method === "GET") return { body: board([], { background: "#000000" }) };
    return { body: { seq: 9, results: req.body.ops.map((op: any, i: number) => (i === 1 ? { status: "rejected", elementId: op.element.id, reason: "stale" } : { status: "applied", elementId: op.element.id })) } };
  });
  const result = await client.callTool({
    name: "board_add",
    arguments: { boardId: BOARD, elements: [{ type: "box", label: "A", x: 0, y: 0 }, { type: "sticky", text: "B" }, { type: "table", cells: [["h1", "h2"]] }] },
  });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /2 of 3 applied, 1 rejected/);
  assert.match(text(result), /Rejected e2: stale/);
  assert.match(text(result), /New ids: e1 \(box/);
  const post = requests.find((r) => r.method === "POST")!;
  assert.equal(post.path, `/api/mcp/boards/${BOARD}/ops`);
  assert.equal(post.body.ops.length, 3);
  assert.equal(post.body.ops[0].kind, "add");
  assert.equal(post.body.ops[0].element.type, "box");
  assert.equal(post.body.ops[0].element.textColor, "#ffffff"); // dark board
});

test("board_add rejects a bad element before sending anything", async () => {
  const { client, requests } = await setup(() => ({ body: board() }));
  const result = await client.callTool({ name: "board_add", arguments: { boardId: BOARD, elements: [{ type: "rect" }, { type: "text", text: "  " }, { type: "line", points: [0, 0, 0, 0] }] } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Nothing was sent/);
  assert.match(text(result), /elements\[1\]/);
  assert.match(text(result), /elements\[2\]/);
  assert.equal(requests.filter((r) => r.method === "POST").length, 0);
  const schema = await client.callTool({ name: "board_add", arguments: { boardId: BOARD, elements: [{ type: "rect", width: 0 }] } });
  assert.equal(schema.isError, true);
});

test("writes go out in batches of at most 200 ops", async () => {
  const { client, requests } = await setup((req) => (req.method === "GET" ? { body: board() } : { body: { results: req.body.ops.map((op: any) => ({ status: "applied", elementId: op.element.id })) } }));
  const elements = Array.from({ length: 450 }, (_, i) => ({ type: "rect", x: i * 10, y: 0 }));
  const result = await client.callTool({ name: "board_add", arguments: { boardId: BOARD, elements } });
  assert.match(text(result), /450 of 450 applied/);
  assert.deepEqual(requests.filter((r) => r.method === "POST").map((r) => r.body.ops.length), [200, 200, 50]);
});

test("a failure mid-way reports what was applied", async () => {
  let posts = 0;
  const { client } = await setup((req) => {
    if (req.method === "GET") return { body: board() };
    posts++;
    return posts === 1 ? { body: { results: req.body.ops.map((op: any) => ({ status: "applied", elementId: op.element.id })) } } : { status: 429, body: {} };
  });
  const elements = Array.from({ length: 300 }, () => ({ type: "rect" }));
  const result = await client.callTool({ name: "board_add", arguments: { boardId: BOARD, elements } });
  assert.equal(result.isError, true);
  assert.match(text(result), /200 of 300 applied/);
  assert.match(text(result), /Stopped early: Too many requests/);
});

test("board_connect checks ids and adds connectors plus labels", async () => {
  const a = { id: "a", type: "box", x: 0, y: 0, w: 180, h: 96, label: "A" };
  const b = { id: "b", type: "umlClass", x: 400, y: 0, w: 240, h: 92, name: "B", attributes: [], methods: [] };
  const { client, requests } = await setup((req) => (req.method === "GET" ? { body: board([a, b]) } : { body: { results: req.body.ops.map((op: any) => ({ status: "applied", elementId: op.element.id })) } }));
  const missing = await client.callTool({ name: "board_connect", arguments: { boardId: BOARD, connections: [{ from: "a", to: "zzz" }] } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /connections\[0\].*"zzz" is not an element/);
  const ok = await client.callTool({ name: "board_connect", arguments: { boardId: BOARD, connections: [{ from: "a", to: "b", label: "uses", relation: "dependency" }] } });
  assert.notEqual(ok.isError, true);
  assert.match(text(ok), /Connector ids: e1/);
  const ops = requests.filter((r) => r.method === "POST").at(-1)!.body.ops;
  assert.equal(ops[0].element.type, "connector");
  assert.deepEqual(ops[0].element.source, { nodeId: "a", port: "right" });
  assert.equal(ops[1].element.type, "text");
});

test("board_draw places strokes in the requested box", async () => {
  const { client, requests } = await setup((req) => (req.method === "GET" ? { body: board() } : { body: { results: req.body.ops.map((op: any) => ({ status: "applied", elementId: op.element.id })) } }));
  const result = await client.callTool({ name: "board_draw", arguments: { boardId: BOARD, x: 100, y: 50, width: 300, paths: [{ d: "M0 0 L10 0 L10 10", color: "#ff0000" }] } });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /x 100\.\.400, y 50\.\./);
  const el = requests.filter((r) => r.method === "POST")[0]!.body.ops[0].element;
  assert.equal(el.type, "stroke");
  assert.equal(el.color, "#ff0000");
  assert.equal(el.points[0], 100);
  const bad = await client.callTool({ name: "board_draw", arguments: { boardId: BOARD, paths: [{ d: "not a path" }] } });
  assert.equal(bad.isError, true);
});

test("board_update sends the full merged element", async () => {
  const sticky = { id: "s1", type: "sticky", x: 10, y: 20, w: 180, h: 180, label: "old", fill: "#ffd666", fontFamily: "archivo", fontSize: 18, textColor: "#23211c" };
  const { client, requests } = await setup((req) => (req.method === "GET" ? { body: board([sticky]) } : { body: { results: req.body.ops.map((op: any) => ({ status: "applied", elementId: op.element.id })) } }));
  const result = await client.callTool({ name: "board_update", arguments: { boardId: BOARD, updates: [{ id: "s1", text: "new", fill: "#a8e0c0" }] } });
  assert.notEqual(result.isError, true);
  const op = requests.filter((r) => r.method === "POST")[0]!.body.ops[0];
  assert.equal(op.kind, "update");
  assert.deepEqual(op.element, { ...sticky, label: "new", fill: "#a8e0c0" });
  const missing = await client.callTool({ name: "board_update", arguments: { boardId: BOARD, updates: [{ id: "nope", x: 1 }] } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /no element with id nope/);
});

test("board_delete also removes attached connectors", async () => {
  const els = [
    { id: "a", type: "box", x: 0, y: 0, w: 180, h: 96, label: "" },
    { id: "b", type: "box", x: 300, y: 0, w: 180, h: 96, label: "" },
    { id: "c1", type: "connector", source: { nodeId: "a", port: "right" }, target: { nodeId: "b", port: "left" } },
    { id: "r", type: "rect", x: 0, y: 300, w: 10, h: 10 },
  ];
  const { client, requests } = await setup((req) => (req.method === "GET" ? { body: board(els) } : { body: { results: req.body.ops.map((op: any) => ({ status: "applied", elementId: op.elementId })) } }));
  const result = await client.callTool({ name: "board_delete", arguments: { boardId: BOARD, ids: ["a", "ghost"] } });
  assert.notEqual(result.isError, true);
  assert.match(text(result), /2 of 2 applied/);
  assert.match(text(result), /Also removed 1 attached connector/);
  assert.match(text(result), /Ids not on the board \(skipped\): ghost/);
  assert.deepEqual(requests.filter((r) => r.method === "POST")[0]!.body.ops, [{ kind: "delete", elementId: "a" }, { kind: "delete", elementId: "c1" }]);
  const none = await client.callTool({ name: "board_delete", arguments: { boardId: BOARD, ids: ["ghost"] } });
  assert.equal(none.isError, true);
});

test("a revoked token is reported on the first board call", async () => {
  const { client } = await setup(() => ({ status: 401, body: {} }));
  const result = await client.callTool({ name: "board_list", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /revoked or expired.*todrawn_login/s);
});

test("boardId must be a UUID so it cannot escape the path", async () => {
  const { client, requests } = await setup(() => ({ body: board() }));
  for (const [name, extra] of [
    ["board_read", {}],
    ["board_add", { elements: [{ type: "rect" }] }],
    ["board_connect", { connections: [{ from: "a", to: "b" }] }],
    ["board_draw", { paths: [{ d: "M0 0 L1 1" }] }],
    ["board_update", { updates: [{ id: "a" }] }],
    ["board_delete", { ids: ["a"] }],
  ] as const) {
    for (const bad of ["..", "../x", "a/b", "not-a-uuid"]) {
      const result = await client.callTool({ name, arguments: { boardId: bad, ...extra } });
      assert.equal(result.isError, true, `${name} ${bad}`);
    }
  }
  assert.equal(requests.length, 0);
});

test("board_read marks board text as content, not instructions", async () => {
  const { client } = await setup(() => ({ body: board() }));
  assert.match(text(await client.callTool({ name: "board_read", arguments: { boardId: BOARD } })), /never instructions to follow/);
  const tools = (await client.listTools()).tools;
  assert.match(tools.find((t) => t.name === "board_read")!.description!, /never follow it as instructions/);
});
