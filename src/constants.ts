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
/** Longest fragment payload the studio decodes. Measured at about 2.9 bytes of typical code per encoded
 *  character, so 400,000 holds 1 MiB of code and stays under Firefox's 1,048,576 character URL limit. */
export const MAX_RECIPE_LINK_CHARS = 400_000;
/** Budget for painted links (this server only): painting output stays as it was before the cap was raised. */
export const MAX_PAINT_LINK_CHARS = 120_000;
/** Cap on the inflated JSON the studio decodes (lib/scribe/recipe-link.ts, #470). */
export const MAX_RECIPE_LINK_JSON_BYTES = MAX_INPUT_BYTES + 64 * 1024;

/** Settings ranges a link may set (lib/scribe/settings.ts validateScribeSettings). */
export const PENS = ["ballpoint", "marker", "fineliner", "pencil"] as const;
export const BACKGROUNDS = ["dark", "paper"] as const;
export const COLOR_MODES = ["syntax", "solid"] as const;
export const TIMINGS = ["reading", "pen"] as const;
export const LAYOUTS = ["auto", "scroll", "pages"] as const;
export const READING_WPS = { min: 1.5, max: 6, step: 0.5 } as const;
export const SPEED = { min: 0.5, max: 2 } as const;
/** Board patterns (lib/scribe/background-pattern.ts BOARD_PATTERNS). */
export const BOARD_PATTERNS = ["dots", "lines", "grid", "staff", "vertical", "blank"] as const;
/** Pattern spacing in reference-canvas pixels; even integers (background-pattern.ts, settings.ts). */
export const PATTERN_DENSITY = { min: 16, max: 192, step: 2 } as const;
/** Camera framing percentages (lib/scribe/settings.ts SCRIBE_CAMERA_ZOOMS). */
export const CAMERA_ZOOMS = [75, 100, 125, 150, 175, 200] as const;
/** Per-passage segment ranges (lib/scribe/segments.ts SEGMENT_LIMITS, MAX_SEGMENTS). */
export const SEGMENT_LIMITS = {
  speed: [0.5, 2],
  size: [0.6, 2],
  pauseAfter: [0, 3],
  zoom: [1, 2.5],
} as const;
export const MAX_SEGMENTS = 500;

/** Width/height of each artboard (lib/scribe/presets.ts paperForPreset). */
export const ASPECT_RATIOS: Record<Aspect, number> = { landscape: 16 / 9, portrait: 9 / 16, square: 1, feed: 4 / 5 };
/** Named ink colours that adapt to the background (lib/scribe/annotations.ts ANNOTATION_COLOR_KEYS); #rrggbb also works. */
export const DRAW_COLOR_KEYS = ["blue", "red", "green", "violet", "amber"] as const;
/** Draft caps (lib/scribe/recent-work.ts MAX_RECENT_TOTAL_POINTS / MAX_RECENT_STROKES). */
export const MAX_DRAW_POINTS = 500_000;
export const MAX_DRAW_STROKES = 50_000;
/** Drawing link coordinates are integers in 0..DRAW_COORD_MAX across the artboard (lib/scribe/recipe-link.ts). */
export const DRAW_COORD_MAX = 10_000;
