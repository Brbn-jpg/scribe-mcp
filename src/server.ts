import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASPECTS,
  BACKGROUNDS,
  BOARD_PATTERNS,
  CAMERA_ROTATIONS,
  CAMERA_TILTS,
  CAMERA_ZOOMS,
  COLOR_MODES,
  FREE_FRAME_RATES,
  FREE_RESOLUTIONS,
  FRAME_RATES,
  FREE_EXPORTS_PER_DAY,
  LANGUAGES,
  LAYOUTS,
  LOCALE_PATH_PREFIXES,
  MAX_INPUT_BYTES,
  MAX_LINES,
  MAX_PLAYBACK_SECONDS,
  MAX_RECIPE_LINK_CHARS,
  MAX_SEGMENTS,
  DRAW_COLOR_KEYS,
  PATTERN_DENSITY,
  PENS,
  PREMIUM_FRAME_RATES,
  PREMIUM_RESOLUTIONS,
  READING_WPS,
  RESOLUTIONS,
  SEGMENT_LIMITS,
  SPEED,
  TIMINGS,
} from "./constants.ts";
import { resolve } from "node:path";
import { buildDrawingLink } from "./drawing.ts";
import { readImage } from "./image.ts";
import { paintToLink } from "./paint.ts";
import { buildRecipeLink, LinkError, type LinkSettings } from "./link.ts";
import { AuthManager } from "./auth.ts";
import { registerBoardTools, type BoardToolsDeps } from "./board-tools.ts";
import { configFromEnv, TodrawnApi } from "./todrawn-api.ts";

export const SERVER_VERSION = "0.5.0";
const MAX_DRAWING_PATHS = 2000;

const EXPORT_RULES =
  `Previewing is free and needs no account. Exporting the MP4 needs a free Todrawn account: ` +
  `the Free plan allows ${FREE_EXPORTS_PER_DAY} exports per UTC day and ends each video with a "Made with Todrawn Scribe" card; ` +
  `Premium has unlimited exports, makes the card optional and also exports 2160p (4K) and 60 fps.`;

const LIMITS_TEXT = [
  "Todrawn Scribe limits:",
  `- Input: up to ${MAX_INPUT_BYTES} bytes (1 MiB) and ${MAX_LINES} lines of text or code.`,
  `- Playback: clips are capped at ${MAX_PLAYBACK_SECONDS} s; longer documents are drawn faster to fit. A readable clip is a few dozen lines.`,
  `- Output: ${FREE_RESOLUTIONS.join(" or ")}, ${FREE_FRAME_RATES.join(" or ")} fps, aspects ${ASPECTS.join(", ")} (feed = 4:5). ${PREMIUM_RESOLUTIONS.join(", ")} and ${PREMIUM_FRAME_RATES.join(", ")} fps need a Premium plan; on other plans the studio exports at 1080p and 30 fps instead.`,
  `- Languages with syntax colours: ${LANGUAGES.filter((l) => l !== "plain").join(", ")}; "plain" draws prose and supports a Markdown subset (headings, **bold**, lists, ==highlight==).`,
  `- Passages: "segments" give a passage of a video its own speed (${SEGMENT_LIMITS.speed.join(" to ")}), glyph size (${SEGMENT_LIMITS.size.join(" to ")}), pen, pause after it (${SEGMENT_LIMITS.pauseAfter.join(" to ")} s) or camera punch-in (${SEGMENT_LIMITS.zoom.join(" to ")}x). Select a passage with "match" (an exact substring, optional "occurrence") or "fromLine"/"toLine" (1-based, inclusive); at most ${MAX_SEGMENTS}. Later passages win where they overlap.`,
  `- Board: pattern ${BOARD_PATTERNS.join(", ")}; density is the spacing of the marks, ${PATTERN_DENSITY.min} to ${PATTERN_DENSITY.max}, even numbers.`,
  `- Camera: cameraZoom frames the 3D pen view at ${CAMERA_ZOOMS.join(", ")} percent (the flat 2D view ignores it); a passage's zoom works in both views.`,
  `- Camera angle: cameraTilt (${CAMERA_TILTS[0]} to ${CAMERA_TILTS.at(-1)} degrees above the board in steps of 5, 40 is standard) and cameraRotation (${CAMERA_ROTATIONS[0]} to ${CAMERA_ROTATIONS.at(-1)} degrees in steps of 5, negative is left) apply to the 3D pen view only.`,
  `- Link size: a project link holds at most ${MAX_RECIPE_LINK_CHARS} encoded characters, about 1 MiB of typical code; photo paintings use a smaller budget and drop their finest strokes to fit.`,
  `- ${EXPORT_RULES}`,
  `- Drawings: SVG path data, drawn as pen lines in path order (fills are ignored); inks ${DRAW_COLOR_KEYS.join(", ")} or #rrggbb.`,
  "- Photos: PNG or JPEG, painted locally into up to ~2800 strokes; the image itself is never uploaded.",
  "- This server only builds links; the video is rendered and exported in the person's browser.",
].join("\n");

const segmentSchema = z.object({
  match: z.string().optional().describe("Select the passage by an exact, case-sensitive piece of the text (line endings are normalised). Use this or fromLine, not both."),
  occurrence: z.number().int().min(1).optional().describe("Which occurrence of match to use, counting from 1. Defaults to 1."),
  fromLine: z.number().int().min(1).optional().describe("Select whole lines instead: the first line, counting from 1."),
  toLine: z.number().int().min(1).optional().describe("The last line, inclusive. Defaults to fromLine."),
  speed: z.number().min(SEGMENT_LIMITS.speed[0]).max(SEGMENT_LIMITS.speed[1]).optional().describe("Writing speed for this passage: 0.5 slower to 2 faster."),
  size: z.number().min(SEGMENT_LIMITS.size[0]).max(SEGMENT_LIMITS.size[1]).optional().describe("Glyph size for this passage: 0.6 smaller to 2 larger."),
  pen: z.enum(PENS).optional().describe("Pen that writes this passage."),
  pauseAfter: z.number().min(SEGMENT_LIMITS.pauseAfter[0]).max(SEGMENT_LIMITS.pauseAfter[1]).optional().describe("Seconds the pen holds after the passage, 0 to 3."),
  zoom: z.number().min(SEGMENT_LIMITS.zoom[0]).max(SEGMENT_LIMITS.zoom[1]).optional().describe("Camera punch-in multiplier while this passage is written: 1 (none) to 2.5. Not the same as the video's cameraZoom."),
});

/** A union of numeric literals: clients see the allowed values as a list. */
function literalUnion<const T extends readonly number[]>(values: T) {
  return z.union(
    values.map((v) => z.literal(v)) as unknown as [z.ZodLiteral<T[number]>, z.ZodLiteral<T[number]>, ...z.ZodLiteral<T[number]>[]],
  );
}

const createVideoShape = {
  text: z.string().min(1).describe("The code or text to draw, exactly as it should appear."),
  language: z
    .string()
    .optional()
    .describe(`Syntax colouring: ${LANGUAGES.join(", ")}. Common names (typescript, python, c++, shell, markdown) are accepted. Defaults to plain.`),
  aspect: z
    .enum(ASPECTS)
    .optional()
    .describe("landscape 16:9 (default), portrait 9:16 for Shorts/Reels/TikTok, square 1:1, feed 4:5."),
  background: z.enum(BACKGROUNDS).optional().describe("dark board or light paper."),
  pen: z.enum(PENS).optional(),
  colorMode: z.enum(COLOR_MODES).optional().describe("syntax colours per token, or one solid ink colour."),
  solidColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Ink colour as #rrggbb when colorMode is solid."),
  timing: z.enum(TIMINGS).optional().describe("reading: paced by words per second (default); pen: paced by pen travel."),
  readingWps: z
    .number()
    .min(READING_WPS.min)
    .max(READING_WPS.max)
    .multipleOf(READING_WPS.step)
    .optional()
    .describe("Words per second when timing is reading."),
  speedMultiplier: z.number().min(SPEED.min).max(SPEED.max).optional(),
  markdown: z.boolean().optional().describe("Interpret Markdown in plain text (default true)."),
  layout: z.enum(LAYOUTS).optional().describe("auto scrolls tall aspects and pages wide ones."),
  resolution: z
    .enum(RESOLUTIONS)
    .optional()
    .describe(`Export resolution: ${RESOLUTIONS.join(", ")}. ${PREMIUM_RESOLUTIONS.join(", ")} needs a Premium plan; on other plans the studio exports at 1080p instead.`),
  fps: literalUnion(FRAME_RATES)
    .optional()
    .describe(`Export frame rate: ${FRAME_RATES.join(", ")}. ${PREMIUM_FRAME_RATES.join(", ")} needs a Premium plan; on other plans the studio exports at 30 fps instead.`),
  segments: z
    .array(segmentSchema)
    .max(MAX_SEGMENTS)
    .optional()
    .describe(
      `Passages with their own speed, size, pen, pause or zoom, for example to slow down the key line. Each one selects text with match or fromLine/toLine and sets at least one of speed, size, pen, pauseAfter, zoom. At most ${MAX_SEGMENTS}; later ones win where they overlap.`,
    ),
  pattern: z.enum(BOARD_PATTERNS).optional().describe("Marks printed on the board behind the writing: dots, lines, grid, staff, vertical lines or blank."),
  density: z
    .number()
    .int()
    .min(PATTERN_DENSITY.min)
    .max(PATTERN_DENSITY.max)
    .multipleOf(PATTERN_DENSITY.step)
    .optional()
    .describe(`Spacing of the board pattern's marks, ${PATTERN_DENSITY.min} to ${PATTERN_DENSITY.max}, even numbers only (default 28). Larger is sparser.`),
  cameraZoom: z
    .union([z.literal(75), z.literal(100), z.literal(125), z.literal(150), z.literal(175), z.literal(200)])
    .optional()
    .describe(`Camera framing of the 3D pen view (its preview and its export) in percent: ${CAMERA_ZOOMS.join(", ")}; 75 shows the most board, 200 follows the pen closest. The flat 2D view ignores it. Not the same as a passage's zoom.`),
  cameraTilt: literalUnion(CAMERA_TILTS)
    .optional()
    .describe(`Camera angle above the board in degrees: ${CAMERA_TILTS.join(", ")}. 40 is the standard view, lower is flatter and shows more depth, 90 looks straight down. Applies to the 3D pen view only (its preview and its export); the flat 2D view ignores it.`),
  cameraRotation: literalUnion(CAMERA_ROTATIONS)
    .optional()
    .describe(`Camera rotation around the board in degrees: ${CAMERA_ROTATIONS.join(", ")}. 0 looks straight on, negative moves the camera to the left of the board, positive to the right. Applies to the 3D pen view only (its preview and its export); the flat 2D view ignores it.`),
  locale: z
    .enum(Object.keys(LOCALE_PATH_PREFIXES) as [keyof typeof LOCALE_PATH_PREFIXES, ...(keyof typeof LOCALE_PATH_PREFIXES)[]])
    .optional()
    .describe("Language of the Scribe interface the link opens. Defaults to en."),
};

const SETTING_KEYS = [
  "background",
  "pen",
  "colorMode",
  "solidColor",
  "timing",
  "readingWps",
  "speedMultiplier",
  "markdown",
  "layout",
  "resolution",
  "fps",
  "pattern",
  "density",
  "cameraZoom",
  "cameraTilt",
  "cameraRotation",
] as const satisfies readonly (keyof LinkSettings)[];

const localeSchema = createVideoShape.locale;

const createDrawingShape = {
  paths: z
    .array(
      z.object({
        d: z.string().min(1).describe("SVG path data. Curves (C, Q, A) are fine; fills are ignored, every path is drawn as a pen line."),
        color: z
          .string()
          .optional()
          .describe(`Ink: ${DRAW_COLOR_KEYS.join(", ")} (adapt to the background) or #rrggbb. Defaults to blue.`),
      }),
    )
    .min(1)
    .max(MAX_DRAWING_PATHS)
    .describe("Paths in the order a person would draw them; the pen follows that order. y grows downward, as in SVG."),
  viewBox: z
    .string()
    .optional()
    .describe('"minX minY width height" framing the drawing, as on an <svg>. Defaults to the paths\' bounding box with a margin.'),
  aspect: z
    .enum(ASPECTS)
    .optional()
    .describe("Artboard: landscape 16:9, portrait 9:16, square 1:1, feed 4:5. Defaults to the one closest to the drawing's shape."),
  background: createVideoShape.background,
  pen: createVideoShape.pen,
  speedMultiplier: createVideoShape.speedMultiplier,
  resolution: createVideoShape.resolution,
  fps: createVideoShape.fps,
  pattern: createVideoShape.pattern,
  density: createVideoShape.density,
  cameraZoom: createVideoShape.cameraZoom,
  cameraTilt: createVideoShape.cameraTilt,
  cameraRotation: createVideoShape.cameraRotation,
  locale: localeSchema,
};

const paintImageShape = {
  imagePath: z.string().min(1).describe("Path to a local PNG or JPEG file. Relative paths resolve against the server's working directory."),
  aspect: z
    .enum(ASPECTS)
    .optional()
    .describe("Artboard: landscape 16:9, portrait 9:16, square 1:1, feed 4:5. Defaults to the one closest to the image's shape."),
  detail: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("Stroke budget: low ~1200 strokes, medium ~2000 (default), high ~2800. More detail is more faithful and plays longer."),
  pen: createVideoShape.pen.describe("Pen width shapes the painting: fineliner (default) is the finest, marker the boldest."),
  background: createVideoShape.background,
  speedMultiplier: createVideoShape.speedMultiplier,
  pattern: createVideoShape.pattern,
  density: createVideoShape.density,
  cameraZoom: createVideoShape.cameraZoom,
  cameraTilt: createVideoShape.cameraTilt,
  cameraRotation: createVideoShape.cameraRotation,
  locale: localeSchema,
};

function defaultBoardDeps(): BoardToolsDeps {
  const api = new TodrawnApi(configFromEnv());
  return { api, auth: new AuthManager({ api }) };
}

export function createScribeServer(options: { baseUrl?: string; board?: BoardToolsDeps } = {}): McpServer {
  const server = new McpServer({ name: "todrawn-scribe", version: SERVER_VERSION });
  registerBoardTools(server, options.board ?? defaultBoardDeps());

  server.registerTool(
    "scribe_create_video",
    {
      title: "Create a Todrawn Scribe video",
      description:
        "Turns code or text into a Todrawn Scribe project: a video of a pen writing it out by hand. " +
        "Returns a link that opens the Scribe studio with the project loaded, where the person previews it and exports the MP4. " +
        "Optional segments give chosen passages their own speed, size, pen, pause or zoom; pattern and density set the board; cameraZoom, cameraTilt and cameraRotation set the 3D camera. " +
        "Give the link to the person; do not try to download a video from it. " +
        EXPORT_RULES,
      inputSchema: createVideoShape,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (args) => {
      const settings: LinkSettings = {};
      for (const key of SETTING_KEYS) {
        if (args[key] !== undefined) (settings as Record<string, unknown>)[key] = args[key];
      }
      try {
        const link = buildRecipeLink({
          text: args.text,
          language: args.language,
          aspect: args.aspect,
          settings,
          segments: args.segments,
          locale: args.locale,
          baseUrl: options.baseUrl,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Open this link to preview and export the video in Todrawn Scribe:`,
                link.url,
                "",
                `Language: ${link.language}, ${link.lines} line${link.lines === 1 ? "" : "s"}${link.segments > 0 ? `, ${link.segments} passage${link.segments === 1 ? "" : "s"} with their own settings` : ""}. The whole project is inside the link after "#", so nothing was uploaded.`,
                `Clips are capped at ${MAX_PLAYBACK_SECONDS} s; longer text is drawn faster to fit.`,
                EXPORT_RULES,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        if (error instanceof LinkError) {
          return { isError: true, content: [{ type: "text" as const, text: error.message }] };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "scribe_create_drawing",
    {
      title: "Create a Todrawn Scribe drawing video",
      description:
        "Turns a line drawing, given as SVG paths, into a Todrawn Scribe Draw project: a video of a pen drawing it stroke by stroke. " +
        "Describe the subject as outlines and details, not filled shapes. Board pattern, density and the 3D camera (cameraZoom, cameraTilt, cameraRotation) are optional. " +
        "Returns a link that opens the Scribe studio with the drawing loaded, where the person previews it and exports the MP4. " +
        EXPORT_RULES,
      inputSchema: createDrawingShape,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const link = buildDrawingLink({
          paths: args.paths,
          viewBox: args.viewBox,
          aspect: args.aspect,
          settings: {
            background: args.background,
            pen: args.pen,
            speedMultiplier: args.speedMultiplier,
            resolution: args.resolution,
            fps: args.fps,
            pattern: args.pattern,
            density: args.density,
            cameraZoom: args.cameraZoom,
            cameraTilt: args.cameraTilt,
            cameraRotation: args.cameraRotation,
          },
          locale: args.locale,
          baseUrl: options.baseUrl,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Open this link to preview and export the drawing in Todrawn Scribe:",
                link.url,
                "",
                `Artboard: ${link.aspect}, ${link.strokes} stroke${link.strokes === 1 ? "" : "s"}, ${link.points} points. The whole drawing is inside the link after "#", so nothing was uploaded.`,
                EXPORT_RULES,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        if (error instanceof LinkError) {
          return { isError: true, content: [{ type: "text" as const, text: error.message }] };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "scribe_paint_image",
    {
      title: "Paint a photo with Todrawn Scribe",
      description:
        "Paints a local photo or picture (PNG or JPEG) as a Todrawn Scribe drawing: an underpaint first, then thousands of coloured pen strokes, " +
        "replayed by the pen as a video. The image is processed on this machine and never uploaded; the returned link carries only the strokes. " +
        `Long paintings are capped at ${MAX_PLAYBACK_SECONDS} s of playback. ` +
        EXPORT_RULES,
      inputSchema: paintImageShape,
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const image = await readImage(resolve(args.imagePath));
        const link = paintToLink(image, {
          aspect: args.aspect,
          detail: args.detail,
          pen: args.pen,
          background: args.background,
          speedMultiplier: args.speedMultiplier,
          pattern: args.pattern,
          density: args.density,
          cameraZoom: args.cameraZoom,
          cameraTilt: args.cameraTilt,
          cameraRotation: args.cameraRotation,
          locale: args.locale,
          baseUrl: options.baseUrl,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Open this link to watch the painting and export it in Todrawn Scribe:",
                link.url,
                "",
                `Artboard: ${link.aspect}, ${link.strokes} strokes${link.trimmed ? ` (${link.trimmed} finest strokes left out to fit the link)` : ""}. ` +
                  "The photo was painted locally; only the strokes are in the link, after \"#\", so nothing was uploaded.",
                EXPORT_RULES,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        if (error instanceof LinkError) {
          return { isError: true, content: [{ type: "text" as const, text: error.message }] };
        }
        throw error;
      }
    },
  );

  server.registerTool(
    "scribe_limits",
    {
      title: "Todrawn Scribe limits",
      description: "Lists what Todrawn Scribe accepts and what the Free and Premium plans allow, before building a video.",
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async () => ({ content: [{ type: "text" as const, text: LIMITS_TEXT }] }),
  );

  return server;
}
