# Todrawn Scribe MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent turn code, text or a line drawing into a [Todrawn Scribe](https://todrawn.com/scribe) project, a video of a pen writing or drawing it by hand.

The agent gets back a link. Opening it loads the project into the Scribe studio, where you preview it and export the MP4. The whole project travels inside the link after `#`, so the server uploads nothing and needs no account or API key.

## Install

Claude Code:

```bash
claude mcp add todrawn-scribe -- npx -y @todrawn/scribe-mcp
```

Claude Desktop, Cursor and other clients that read an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "todrawn-scribe": {
      "command": "npx",
      "args": ["-y", "@todrawn/scribe-mcp"]
    }
  }
}
```

Then ask, for example: "Make a vertical Scribe video of the function I just wrote." or "Draw a lighthouse with Scribe."

## Tools

| Tool | What it does |
|---|---|
| `scribe_create_video` | Takes `text` and optionally `language`, `aspect`, look and pacing settings and `locale`. Returns the studio link. |
| `scribe_create_drawing` | Takes `paths` (SVG path data plus an optional ink colour each) and optionally `viewBox`, `aspect`, look settings and `locale`. Curves and arcs are flattened; the pen draws the paths in order. Returns the studio link. |
| `scribe_limits` | Lists input limits and what the Free and Premium plans allow. |

## Plans

Previewing is free and needs no account. Exporting needs a free Todrawn account:

- **Free:** 5 exports per UTC day; every video ends with a "Made with Todrawn Scribe" card.
- **Premium:** unlimited exports; the card is optional.

Input is capped at 1 MiB and 5000 lines. Clips are capped at 180 s, and longer text is drawn faster to fit.

## Development

```bash
npm install
npm test          # node --test, runs the TypeScript sources directly (Node 22.6+)
npm run build     # emits dist/
TODRAWN_SCRIBE_URL=http://localhost:3000 node dist/index.js   # links point at a local frontend
```

The constants in `src/constants.ts` mirror the studio. `frontend/src/lib/scribe/recipe-link-mcp.test.ts` fails if they drift, and checks that every link this server builds opens in the studio.
