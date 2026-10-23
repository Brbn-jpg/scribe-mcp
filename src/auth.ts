/* Sign-in for the board tools: token storage and the device flow. The token
   lives in the user's config dir (mode 0600) and TODRAWN_TOKEN overrides it. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NOT_SIGNED_IN_MESSAGE, TodrawnApi, TodrawnApiError } from "./todrawn-api.ts";

export interface StoredToken {
  apiUrl: string;
  accessToken: string;
  expiresAt: string;
}

/** ${XDG_CONFIG_HOME:-~/.config}/todrawn/mcp-token.json, or %APPDATA%\todrawn\mcp-token.json on Windows. */
export function tokenFilePath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "todrawn", "mcp-token.json");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "todrawn", "mcp-token.json");
}

export class TokenStore {
  readonly path: string;
  constructor(path: string = tokenFilePath()) {
    this.path = path;
  }

  read(): StoredToken | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredToken>;
      if (typeof parsed.apiUrl === "string" && typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "string") {
        return { apiUrl: parsed.apiUrl, accessToken: parsed.accessToken, expiresAt: parsed.expiresAt };
      }
    } catch {
      // missing or unreadable file means signed out
    }
    return null;
  }

  write(token: StoredToken): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
    // a fresh 0600 file in the same directory, then an atomic rename: the token
    // is never written into a file with looser permissions
    const tmp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  delete(): void {
    if (existsSync(this.path)) rmSync(this.path, { force: true });
  }
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

type PollResponse =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | { status: "approved"; accessToken: string; expiresAt: string };

export interface PendingLogin {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Epoch ms after which the code no longer works. */
  expiresAtMs: number;
}

export class AuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export function loginInstructions(pending: PendingLogin): string {
  return [
    "Sign-in is waiting for approval. Ask the person to open this link and approve the connection:",
    pending.verificationUriComplete,
    `Code: ${pending.userCode} (if the page asks for it). Then retry; the tools work as soon as they approve.`,
  ].join("\n");
}

export interface AuthOptions {
  api: TodrawnApi;
  store?: TokenStore;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class AuthManager {
  private readonly api: TodrawnApi;
  private readonly store: TokenStore;
  private readonly env: Record<string, string | undefined>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private pendingLogin: PendingLogin | null = null;
  private failure: string | null = null;
  private failureKind: "denied" | "expired" | null = null;
  private cancelled = false;
  /** Resolves when the background poll ends; exposed so tests can await it. */
  loginSettled: Promise<void> = Promise.resolve();

  constructor(options: AuthOptions) {
    this.api = options.api;
    this.store = options.store ?? new TokenStore();
    this.env = options.env ?? process.env;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  get pending(): PendingLogin | null {
    if (this.pendingLogin && this.now() >= this.pendingLogin.expiresAtMs) this.pendingLogin = null;
    return this.pendingLogin;
  }

  /** The bearer token to use, or null when signed out. */
  token(): string | null {
    const fromEnv = this.env.TODRAWN_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const stored = this.store.read();
    if (!stored || stored.apiUrl !== this.api.config.apiUrl) return null;
    const expires = Date.parse(stored.expiresAt);
    if (Number.isFinite(expires) && expires <= this.now()) return null;
    return stored.accessToken;
  }

  /** The token for a board tool, or an AuthRequiredError that tells the agent exactly what to do. */
  requireToken(): string {
    const token = this.token();
    if (token) return token;
    const pending = this.pending;
    if (pending) throw new AuthRequiredError(loginInstructions(pending));
    if (this.failure) throw new AuthRequiredError(`${this.failure} Run todrawn_login to start again.`);
    throw new AuthRequiredError("Not signed in to Todrawn. Run todrawn_login first.");
  }

  /** Calls the API with the stored token; a 401 also forgets a stored token that no longer works. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.requireToken();
    try {
      return await this.api.request<T>(method, path, { token, body });
    } catch (error) {
      if (error instanceof TodrawnApiError && error.status === 401 && !this.env.TODRAWN_TOKEN?.trim()) {
        this.store.delete();
      }
      throw error;
    }
  }

  /** The previous sign-in attempt's outcome as a sentence (only when it was denied or expired), cleared once read. */
  takeFailure(): string | null {
    const kind = this.failureKind;
    this.failureKind = null;
    if (kind === "denied") return "The previous sign-in request was denied.";
    if (kind === "expired") return "The previous sign-in request expired before it was approved.";
    return null;
  }

  /** Starts the device flow and polls in the background; returns what the person must open. */
  async startLogin(clientName: string): Promise<PendingLogin> {
    const device = await this.api.request<DeviceCodeResponse>("POST", "/api/auth/mcp/device", {
      body: { clientName: clientName.slice(0, 100) },
    });
    const pending: PendingLogin = {
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresAtMs: this.now() + device.expiresIn * 1000,
    };
    this.pendingLogin = pending;
    this.failure = null;
    this.failureKind = null;
    this.cancelled = false;
    this.loginSettled = this.poll(device, pending).catch(() => undefined);
    return pending;
  }

  private async poll(device: DeviceCodeResponse, pending: PendingLogin): Promise<void> {
    let intervalMs = Math.max(1, device.interval) * 1000;
    while (!this.cancelled && this.pendingLogin === pending) {
      await this.sleep(intervalMs);
      if (this.cancelled || this.pendingLogin !== pending) return;
      if (this.now() >= pending.expiresAtMs) {
        this.finish(pending, "The sign-in code expired before it was approved.", "expired");
        return;
      }
      let result: PollResponse;
      try {
        result = await this.api.request<PollResponse>("POST", "/api/auth/mcp/token", { body: { deviceCode: device.deviceCode } });
      } catch {
        continue; // a network blip must not end the login; the deadline above does
      }
      switch (result.status) {
        case "pending":
          break;
        case "slow_down":
          intervalMs += 5000;
          break;
        case "denied":
          this.finish(pending, "The sign-in request was denied.", "denied");
          return;
        case "expired":
          this.finish(pending, "The sign-in code expired before it was approved.", "expired");
          return;
        case "approved":
          this.store.write({ apiUrl: this.api.config.apiUrl, accessToken: result.accessToken, expiresAt: result.expiresAt });
          this.finish(pending, null);
          return;
      }
    }
  }

  private finish(pending: PendingLogin, failure: string | null, kind: "denied" | "expired" | null = null): void {
    if (this.pendingLogin === pending) this.pendingLogin = null;
    this.failure = failure;
    this.failureKind = kind;
  }

  /** Revokes the token on the server (a 401 means it is already gone) and forgets it locally. */
  async logout(): Promise<{ revoked: boolean; usedEnvToken: boolean }> {
    this.cancelled = true;
    this.pendingLogin = null;
    this.failure = null;
    this.failureKind = null;
    const token = this.token();
    const usedEnvToken = Boolean(this.env.TODRAWN_TOKEN?.trim());
    let revoked = false;
    if (token) {
      try {
        await this.api.request("DELETE", "/api/mcp/token", { token, tolerate: [401] });
        revoked = true;
      } finally {
        this.store.delete();
      }
    } else {
      this.store.delete();
    }
    return { revoked, usedEnvToken };
  }
}

export { NOT_SIGNED_IN_MESSAGE };
