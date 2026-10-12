import { deflateRawSync } from "node:zlib";
import {
  type Aspect,
  type Language,
  type Locale,
  LANGUAGES,
  LOCALE_PATH_PREFIXES,
  MAX_INPUT_BYTES,
  MAX_LINES,
  MAX_RECIPE_LINK_CHARS,
  RECIPE_LINK_VERSION,
} from "./constants.ts";

export const DEFAULT_BASE_URL = "https://todrawn.com";

/** Names agents tend to use for a language, mapped onto the studio's tokenizers. */
const LANGUAGE_ALIASES: Record<string, Language> = {
  javascript: "js",
  jsx: "js",
  mjs: "js",
  node: "js",
  typescript: "ts",
  tsx: "ts",
  python: "py",
  c: "clike",
  "c++": "clike",
  cpp: "clike",
  "c#": "clike",
  csharp: "clike",
  cs: "clike",
  kotlin: "clike",
  kt: "clike",
  swift: "clike",
  php: "clike",
  dart: "clike",
  scala: "clike",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  xml: "html",
  svg: "html",
  vue: "html",
  scss: "css",
  sass: "css",
  less: "css",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  golang: "go",
  rs: "rust",
  text: "plain",
  txt: "plain",
  markdown: "plain",
  md: "plain",
  prose: "plain",
};

export class LinkError extends Error {}

export function resolveLanguage(value: string | undefined): Language {
  if (value === undefined || value.trim() === "") return "plain";
  const key = value.trim().toLowerCase();
  if ((LANGUAGES as readonly string[]).includes(key)) return key as Language;
  const alias = LANGUAGE_ALIASES[key];
  if (alias) return alias;
  throw new LinkError(
    `Unknown language "${value}". Use one of: ${LANGUAGES.join(", ")} (or a common name such as typescript, python, c++, shell, markdown).`,
  );
}

export interface LinkSettings {
  background?: "dark" | "paper";
  colorMode?: "syntax" | "solid";
  solidColor?: string;
  pen?: "ballpoint" | "marker" | "fineliner" | "pencil";
  timing?: "reading" | "pen";
  readingWps?: number;
  speedMultiplier?: number;
  markdown?: boolean;
  layout?: "auto" | "scroll" | "pages";
  resolution?: "720p" | "1080p";
  fps?: 24 | 30;
}

export interface LinkInput {
  text: string;
  language?: string;
  aspect?: Aspect;
  settings?: LinkSettings;
  locale?: Locale;
  baseUrl?: string;
}

export interface BuiltLink {
  url: string;
  language: Language;
  lines: number;
  bytes: number;
}

/** Builds a /scribe#r= link; throws LinkError with a message meant for the agent. */
export function buildRecipeLink(input: LinkInput): BuiltLink {
  // the studio draws tabs and CRLF as written; normalise line endings only
  const text = input.text.replace(/\r\n?/g, "\n");
  if (text.trim() === "") throw new LinkError("The text is empty. Pass the code or text to draw.");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_INPUT_BYTES) {
    throw new LinkError(`The text is ${bytes} bytes; Scribe accepts at most ${MAX_INPUT_BYTES} bytes (1 MiB).`);
  }
  const lines = text.split("\n").length;
  if (lines > MAX_LINES) throw new LinkError(`The text has ${lines} lines; Scribe draws at most ${MAX_LINES}.`);
  const language = resolveLanguage(input.language);

  const settings = Object.fromEntries(
    Object.entries(input.settings ?? {}).filter(([, value]) => value !== undefined),
  );
  const payload = {
    v: RECIPE_LINK_VERSION,
    text,
    language,
    ...(input.aspect ? { aspect: input.aspect } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 }).toString("base64url");
  if (encoded.length > MAX_RECIPE_LINK_CHARS) {
    throw new LinkError(
      `This text is too large for a link (${encoded.length} encoded characters, limit ${MAX_RECIPE_LINK_CHARS}). Shorten it: a readable clip is a few dozen lines.`,
    );
  }
  const base = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const prefix = LOCALE_PATH_PREFIXES[input.locale ?? "en"];
  return { url: `${base}${prefix}/scribe#r=${encoded}`, language, lines, bytes };
}
