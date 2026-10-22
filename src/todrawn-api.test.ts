import assert from "node:assert/strict";
import { test } from "node:test";
import { configFromEnv, NOT_SIGNED_IN_MESSAGE, TodrawnApi, TodrawnApiError } from "./todrawn-api.ts";

const config = { apiUrl: "https://api.example.test", appUrl: "https://app.example.test" };

function apiReplying(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const api = new TodrawnApi(config, async (url, init) => {
    calls.push({ url, init });
    const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status, headers });
  });
  return { api, calls };
}

test("config defaults and env overrides", () => {
  assert.deepEqual(configFromEnv({}), { apiUrl: "https://api.todrawn.com", appUrl: "https://todrawn.com" });
  assert.deepEqual(configFromEnv({ TODRAWN_API_URL: "http://localhost:8080/", TODRAWN_APP_URL: "http://localhost:3000" }), {
    apiUrl: "http://localhost:8080",
    appUrl: "http://localhost:3000",
  });
  assert.throws(() => configFromEnv({ TODRAWN_API_URL: "ftp://x" }), /TODRAWN_API_URL/);
  assert.throws(() => configFromEnv({ TODRAWN_APP_URL: "nope" }), /TODRAWN_APP_URL/);
});

test("sends the bearer token and JSON body, parses the reply", async () => {
  const { api, calls } = apiReplying(200, { ok: true });
  const out = await api.request<{ ok: boolean }>("POST", "/api/mcp/boards", { token: "tdmcp_x", body: { title: "t" } });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls[0]!.url, "https://api.example.test/api/mcp/boards");
  const headers = calls[0]!.init!.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tdmcp_x");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(calls[0]!.init!.body, JSON.stringify({ title: "t" }));
  assert.equal(api.boardUrl("abc"), "https://app.example.test/board/abc");
});

test("204 resolves to undefined and tolerated statuses do not throw", async () => {
  assert.equal(await apiReplying(204, undefined).api.request("DELETE", "/x", { token: "t" }), undefined);
  assert.equal(await apiReplying(401, "no").api.request("DELETE", "/x", { token: "t", tolerate: [401] }), undefined);
});

test("401 with a token means sign in again", async () => {
  await assert.rejects(apiReplying(401, { message: "bad" }).api.request("GET", "/x", { token: "t" }), (e: unknown) => {
    assert.ok(e instanceof TodrawnApiError);
    assert.equal(e.status, 401);
    assert.equal(e.message, NOT_SIGNED_IN_MESSAGE);
    assert.match(e.message, /todrawn_login/);
    return true;
  });
});

test("402 and 403 pass the server's message through", async () => {
  await assert.rejects(apiReplying(402, { status: 402, message: "Free plan allows 3 boards" }).api.request("POST", "/x", { token: "t" }), /Free plan allows 3 boards/);
  await assert.rejects(apiReplying(403, { message: "Not a member" }).api.request("GET", "/x", { token: "t" }), /Not a member/);
  await assert.rejects(apiReplying(402, "").api.request("POST", "/x", { token: "t" }), /plan/);
});

test("429 gives a retry hint", async () => {
  await assert.rejects(apiReplying(429, "", { "Retry-After": "12" }).api.request("GET", "/x", { token: "t" }), /Retry in about 12 seconds/);
  await assert.rejects(apiReplying(429, "").api.request("GET", "/x", { token: "t" }), /Wait a moment and retry/);
});

test("other errors keep the status and message; network failures are readable", async () => {
  await assert.rejects(apiReplying(400, { message: "Too many ops" }).api.request("POST", "/x", { token: "t" }), /400: Too many ops/);
  await assert.rejects(apiReplying(404, "").api.request("GET", "/x", { token: "t" }), /Not found/);
  const down = new TodrawnApi(config, async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(down.request("GET", "/x"), /Could not reach Todrawn at https:\/\/api\.example\.test: ECONNREFUSED/);
});

test("a 401 on a public call is not reported as a revoked token", async () => {
  await assert.rejects(apiReplying(401, { message: "nope" }).api.request("POST", "/api/auth/mcp/token", {}), /401: nope/);
});
