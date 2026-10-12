import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ASPECTS,
  BACKGROUNDS,
  COLOR_MODES,
  FRAME_RATES,
  FREE_EXPORTS_PER_DAY,
  LANGUAGES,
  LAYOUTS,
  LOCALE_PATH_PREFIXES,
  MAX_INPUT_BYTES,
  MAX_LINES,
  MAX_PLAYBACK_SECONDS,
  PENS,
  READING_WPS,
  RESOLUTIONS,
  SPEED,
  TIMINGS,
} from "./constants.ts";
import { buildRecipeLink, LinkError, type LinkSettings } from "./link.ts";

export const SERVER_VERSION = "0.1.0";

const EXPORT_RULES =
  `Previewing is free and needs no account. Exporting the MP4 needs a free Todrawn account: ` +
  `the Free plan allows ${FREE_EXPORTS_PER_DAY} exports per UTC day and ends each video with a "Made with Todrawn Scribe" card; ` +
  `Premium has unlimited exports and makes the card optional.`;

const LIMITS_TEXT = [
  "Todrawn Scribe limits:",
  `- Input: up to ${MAX_INPUT_BYTES} bytes (1 MiB) and ${MAX_LINES} lines of text or code.`,
  `- Playback: clips are capped at ${MAX_PLAYBACK_SECONDS} s; longer documents are drawn faster to fit. A readable clip is a few dozen lines.`,
  `- Output: ${RESOLUTIONS.join(" or ")}, ${FRAME_RATES.join(" or ")} fps, aspects ${ASPECTS.join(", ")} (feed = 4:5).`,
  `- Languages with syntax colours: ${LANGUAGES.filter((l) => l !== "plain").join(", ")}; "plain" draws prose and supports a Markdown subset (headings, **bold**, lists, ==highlight==).`,
  `- ${EXPORT_RULES}`,
  "- This server only builds links; the video is rendered and exported in the person's browser.",
].join("\n");

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
  resolution: z.enum(RESOLUTIONS).optional(),
  fps: z.union([z.literal(24), z.literal(30)]).optional(),
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
] as const satisfies readonly (keyof LinkSettings)[];

export function createScribeServer(options: { baseUrl?: string } = {}): McpServer {
  const server = new McpServer({ name: "todrawn-scribe", version: SERVER_VERSION });

  server.registerTool(
    "scribe_create_video",
    {
      title: "Create a Todrawn Scribe video",
      description:
        "Turns code or text into a Todrawn Scribe project: a video of a pen writing it out by hand. " +
        "Returns a link that opens the Scribe studio with the project loaded, where the person previews it and exports the MP4. " +
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
                `Language: ${link.language}, ${link.lines} line${link.lines === 1 ? "" : "s"}. The whole project is inside the link after "#", so nothing was uploaded.`,
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
