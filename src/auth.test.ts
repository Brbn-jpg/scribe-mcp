import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AuthManager, AuthRequiredError, TokenStore, tokenFilePath } from "./auth.ts";
import { TodrawnApi } from "./todrawn-api.ts";

const config = { apiUrl: "https://api.example.test", appUrl: "https://app.example.test" };
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function tempStore(): TokenStore {
  return new TokenStore(join(mkdtempSync(join(tmpdir(), "todrawn-auth-")), "todrawn", "mcp-token.json"));
}

test("token file path follows XDG on unix and APPDATA on Windows", () => {
  assert.equal(tokenFilePath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u"), "/xdg/todrawn/mcp-token.json");
  assert.equal(tokenFilePath({}, "darwin", "/Users/u"), "/Users/u/.config/todrawn/mcp-token.json");
  assert.match(tokenFilePath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"), /todrawn[\\/]mcp-token\.json$/);
});

test("token file is written with private permissions and round-trips", { skip: process.platform === "win32" }, () => {
  const store = tempStore();
  store.write({ apiUrl: config.apiUrl, accessToken: "tdmcp_a", expiresAt: FUTURE });
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(store.path, "..")).mode & 0o777, 0o700);
  assert.equal(store.read()?.accessToken, "tdmcp_a");
  // an older, looser file is tightened on the next write
  writeFileSync(store.path, "{}", { mode: 0o644 });
  store.write({ apiUrl: config.apiUrl, accessToken: "tdmcp_b", expiresAt: FUTURE });
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(store.path, "..")), ["mcp-token.json"]); // no temp file left behind
  store.delete();
  assert.equal(existsSync(store.path), false);
  assert.equal(store.read(), null);
});

test("stored token is used only for the matching API and before expiry; env overrides", () => {
  const store = tempStore();
  const api = new TodrawnApi(config, async () => new Response("{}"));
  const manager = (env: Record<string, string | undefined> = {}, now = Date.now()) => new AuthManager({ api, store, env, now: () => now });
  assert.equal(manager().token(), null);
  store.write({ apiUrl: config.apiUrl, accessToken: "tdmcp_file", expiresAt: FUTURE });
  assert.equal(manager().token(), "tdmcp_file");
  assert.equal(manager({ TODRAWN_TOKEN: " tdmcp_env " }).token(), "tdmcp_env");
  assert.equal(manager({}, Date.now() + 2 * 86_400_000).token(), null);
  store.write({ apiUrl: "https://other.example.test", accessToken: "tdmcp_other", expiresAt: FUTURE });
  assert.equal(manager().token(), null);
  assert.throws(() => manager().requireToken(), /todrawn_login/);
});

/** A scripted device-flow server plus a fake clock whose sleep advances time. */
function flow(pollReplies: unknown[], expiresIn = 600, interval = 5) {
  const store = tempStore();
  const calls: { path: string; body?: unknown }[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const replies = [...pollReplies];
  const api = new TodrawnApi(config, async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/api/auth/mcp/device") {
      return Response.json({
        deviceCode: "dev-secret",
        userCode: "BCDF-GHJK",
        verificationUri: "https://app.example.test/connect",
        verificationUriComplete: "https://app.example.test/connect?code=BCDF-GHJK",
        expiresIn,
        interval,
      });
    }
    if (path === "/api/auth/mcp/token") {
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return Response.json(next ?? { status: "pending" });
    }
    return new Response("", { status: 204 });
  });
  const auth = new AuthManager({
    api,
    store,
    env: {},
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { auth, store, calls, sleeps };
}

test("device flow: pending, then approved saves the token", async () => {
  const { auth, store, calls, sleeps } = flow([{ status: "pending" }, { status: "approved", accessToken: "tdmcp_new", expiresAt: FUTURE }]);
  const pending = await auth.startLogin("Claude Code on my-mac");
  assert.equal(pending.userCode, "BCDF-GHJK");
  assert.equal(calls[0]!.path, "/api/auth/mcp/device");
  assert.deepEqual(calls[0]!.body, { clientName: "Claude Code on my-mac" });
  // while pending, board calls answer with the link and code
  assert.throws(() => auth.requireToken(), (e: unknown) => e instanceof AuthRequiredError && /connect\?code=BCDF-GHJK/.test(e.message) && /BCDF-GHJK/.test(e.message));
  await auth.loginSettled;
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.deepEqual(calls[1]!.body, { deviceCode: "dev-secret" });
  assert.equal(store.read()?.accessToken, "tdmcp_new");
  assert.equal(store.read()?.apiUrl, config.apiUrl);
  assert.equal(auth.token(), "tdmcp_new");
  assert.equal(auth.pending, null);
});

test("device flow: slow_down widens the interval", async () => {
  const { auth, sleeps } = flow([{ status: "slow_down" }, { status: "slow_down" }, { status: "denied" }], 600, 5);
  await auth.startLogin("x");
  await auth.loginSettled;
  assert.deepEqual(sleeps, [5000, 10000, 15000]);
});

test("device flow: denied and expired explain themselves", async () => {
  const denied = flow([{ status: "denied" }]);
  await denied.auth.startLogin("x");
  await denied.auth.loginSettled;
  assert.equal(denied.auth.token(), null);
  assert.throws(() => denied.auth.requireToken(), /denied.*todrawn_login/s);

  const expired = flow([{ status: "expired" }]);
  await expired.auth.startLogin("x");
  await expired.auth.loginSettled;
  assert.throws(() => expired.auth.requireToken(), /expired.*todrawn_login/s);
});

test("device flow: takeFailure reports a denied or expired previous attempt once", async () => {
  const denied = flow([{ status: "denied" }]);
  await denied.auth.startLogin("x");
  await denied.auth.loginSettled;
  assert.equal(denied.auth.takeFailure(), "The previous sign-in request was denied.");
  assert.equal(denied.auth.takeFailure(), null);

  const expired = flow([{ status: "expired" }]);
  await expired.auth.startLogin("x");
  await expired.auth.loginSettled;
  assert.equal(expired.auth.takeFailure(), "The previous sign-in request expired before it was approved.");

  assert.equal(flow([]).auth.takeFailure(), null);
});

test("device flow: stops at expiresIn, tolerates network blips", async () => {
  const { auth, calls } = flow([new Error("offline"), { status: "pending" }], 12, 5);
  await auth.startLogin("x");
  await auth.loginSettled;
  assert.equal(auth.pending, null);
  assert.throws(() => auth.requireToken(), /expired/);
  assert.equal(calls.filter((c) => c.path === "/api/auth/mcp/token").length, 2);
});

test("client name is capped at 100 characters", async () => {
  const { auth, calls } = flow([{ status: "denied" }]);
  await auth.startLogin("n".repeat(300));
  await auth.loginSettled;
  assert.equal((calls[0]!.body as { clientName: string }).clientName.length, 100);
});

test("logout revokes the token, ignores 401 and deletes the file", async () => {
  const store = tempStore();
  store.write({ apiUrl: config.apiUrl, accessToken: "tdmcp_a", expiresAt: FUTURE });
  const seen: string[] = [];
  let status = 204;
  const api = new TodrawnApi(config, async (url, init) => {
    seen.push(`${init?.method} ${new URL(url).pathname} ${(init?.headers as Record<string, string>).Authorization}`);
    return new Response(null, { status });
  });
  const auth = new AuthManager({ api, store, env: {} });
  assert.deepEqual(await auth.logout(), { revoked: true, usedEnvToken: false });
  assert.deepEqual(seen, ["DELETE /api/mcp/token Bearer tdmcp_a"]);
  assert.equal(store.read(), null);

  store.write({ apiUrl: config.apiUrl, accessToken: "tdmcp_b", expiresAt: FUTURE });
  status = 401;
  assert.equal((await auth.logout()).revoked, true);
  assert.equal(store.read(), null);
  assert.equal((await auth.logout()).revoked, false);
});

test("a 401 from the API forgets the stored token", async () => {
  const store = tempStore();
  store.write({ apiUrl: config.apiUrl, accessToken: "tdmcp_dead", expiresAt: FUTURE });
  const api = new TodrawnApi(config, async () => new Response("", { status: 401 }));
  const auth = new AuthManager({ api, store, env: {} });
  await assert.rejects(auth.call("GET", "/api/mcp/boards"), /revoked or expired/);
  assert.equal(store.read(), null);
});
