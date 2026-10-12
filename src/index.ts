#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BASE_URL } from "./link.ts";
import { createScribeServer } from "./server.ts";

/** TODRAWN_SCRIBE_URL points links at another deployment, e.g. http://localhost:3000. */
function baseUrlFromEnv(): string {
  const raw = process.env.TODRAWN_SCRIBE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`TODRAWN_SCRIBE_URL must be an http(s) URL, got ${raw}`);
  }
  return url.origin;
}

const server = createScribeServer({ baseUrl: baseUrlFromEnv() });
await server.connect(new StdioServerTransport());
