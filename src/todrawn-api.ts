/* Small fetch client for the Todrawn agent API (/api/mcp/** and the public
   device flow under /api/auth/mcp). Kept free of MCP and zod so it is easy to
   test with a mocked fetch. */

export const DEFAULT_API_URL = "https://api.todrawn.com";
export const DEFAULT_APP_URL = "https://todrawn.com";

export interface TodrawnConfig {
  apiUrl: string;
  appUrl: string;
}

function origin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http(s) URL, got ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL, got ${raw}`);
  }
  return url.origin;
}

/** TODRAWN_API_URL and TODRAWN_APP_URL point the board tools at another deployment (e.g. a local stack). */
export function configFromEnv(env: Record<string, string | undefined> = process.env): TodrawnConfig {
  return {
    apiUrl: origin(env.TODRAWN_API_URL?.trim() || DEFAULT_API_URL, "TODRAWN_API_URL"),
    appUrl: origin(env.TODRAWN_APP_URL?.trim() || DEFAULT_APP_URL, "TODRAWN_APP_URL"),
  };
}

export const NOT_SIGNED_IN_MESSAGE =
  "Not signed in, or the token was revoked or expired. Run todrawn_login to sign in again.";

export class TodrawnApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TodrawnApiError";
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  body?: unknown;
  /** Bearer token to send; omitted for the public device-flow calls. */
  token?: string;
  /** Statuses that should not throw (for example 401 on logout). */
  tolerate?: number[];
}

async function serverMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // not JSON: fall through to the trimmed text
  }
  return raw.trim().slice(0, 300);
}

export class TodrawnApi {
  readonly config: TodrawnConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: TodrawnConfig, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  boardUrl(id: string): string {
    return `${this.config.appUrl}/board/${id}`;
  }

  /** Performs the request and returns the parsed JSON body (undefined for 204). */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiUrl}${path}`, { method, headers, body });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TodrawnApiError(0, `Could not reach Todrawn at ${this.config.apiUrl}: ${reason}`);
    }
    if (options.tolerate?.includes(response.status)) return undefined as T;
    if (response.ok) {
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw await this.errorFor(response, Boolean(options.token));
  }

  private async errorFor(response: Response, authed: boolean): Promise<TodrawnApiError> {
    const status = response.status;
    if (status === 401 && authed) return new TodrawnApiError(status, NOT_SIGNED_IN_MESSAGE);
    const message = await serverMessage(response);
    if (status === 402 || status === 403) {
      return new TodrawnApiError(status, message || "This action is not allowed on the current Todrawn plan.");
    }
    if (status === 429) {
      const retry = Number(response.headers.get("Retry-After"));
      const wait = Number.isFinite(retry) && retry > 0 ? ` Retry in about ${Math.ceil(retry)} seconds.` : " Wait a moment and retry.";
      return new TodrawnApiError(status, `Too many requests to Todrawn.${wait}`);
    }
    if (status === 404) return new TodrawnApiError(status, message || "Not found, or you do not have access to it.");
    return new TodrawnApiError(status, message ? `Todrawn returned ${status}: ${message}` : `Todrawn returned ${status}.`);
  }
}
