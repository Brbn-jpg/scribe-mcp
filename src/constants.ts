/* Product facts the server validates against. Each one mirrors a constant in
   frontend/src/lib/scribe; frontend/src/lib/scribe/recipe-link-mcp.test.ts
   fails when they drift. Kept dependency-free so that test can import it. */

/** Studio tokenizer languages (lib/scribe/tokenize.ts Language). */
export const LANGUAGES = ["js", "ts", "py", "java", "clike", "sql", "html", "css", "bash", "go", "rust", "plain"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Output aspects (lib/scribe/presets.ts ASPECTS); "feed" is 4:5. */
export const ASPECTS = ["landscape", "portrait", "square", "feed"] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Site locales and their path prefixes (src/i18n/routing.ts LOCALE_PATH_PREFIXES). */
export const LOCALE_PATH_PREFIXES = { en: "", pl: "/pl", de: "/de", fr: "/fr", es: "/es", "pt-BR": "/pt-br" } as const;
export type Locale = keyof typeof LOCALE_PATH_PREFIXES;

/** Input caps (lib/scribe/limits.ts). */
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_LINES = 5000;
export const MAX_PLAYBACK_SECONDS = 180;
export const FREE_EXPORTS_PER_DAY = 5;
export const RESOLUTIONS = ["720p", "1080p"] as const;
export const FRAME_RATES = [24, 30] as const;

/** Link format (lib/scribe/recipe-link.ts). */
export const RECIPE_LINK_VERSION = 1;
export const MAX_RECIPE_LINK_CHARS = 120_000;

/** Settings ranges a link may set (lib/scribe/settings.ts validateScribeSettings). */
export const PENS = ["ballpoint", "marker", "fineliner", "pencil"] as const;
export const BACKGROUNDS = ["dark", "paper"] as const;
export const COLOR_MODES = ["syntax", "solid"] as const;
export const TIMINGS = ["reading", "pen"] as const;
export const LAYOUTS = ["auto", "scroll", "pages"] as const;
export const READING_WPS = { min: 1.5, max: 6, step: 0.5 } as const;
export const SPEED = { min: 0.5, max: 2 } as const;
