# Todrawn Scribe MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent turn code, text, a line drawing or a photo into a [Todrawn Scribe](https://todrawn.com/scribe) project, a video of a pen writing, drawing or painting it by hand.

The agent gets back a link. Opening it loads the project into the Scribe studio, where you preview it and export the MP4. The whole project travels inside the link after `#`, so the server uploads nothing and needs no account or API key.

## Install

Claude Code:

```bash
claude mcp add todrawn-scribe -- npx -y @todrawn/scribe-mcp
```

OpenAI Codex CLI:

```bash
codex mcp add todrawn-scribe -- npx -y @todrawn/scribe-mcp
```

VS Code (GitHub Copilot):

```bash
code --add-mcp '{"name":"todrawn-scribe","command":"npx","args":["-y","@todrawn/scribe-mcp"]}'
```

Claude Desktop (Settings > Developer > Edit Config), Cursor (`~/.cursor/mcp.json`), Gemini CLI (`~/.gemini/settings.json`) and other clients that read an `mcpServers` block:

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

Any other MCP client runs the same stdio command: `npx -y @todrawn/scribe-mcp`. Needs Node.js 20 or newer.

Then ask, for example: "Make a vertical Scribe video of the function I just wrote." or "Draw a lighthouse with Scribe." or "Paint ~/Pictures/dinner.jpg with Scribe."

## Tools

| Tool | What it does |
|---|---|
| `scribe_create_video` | Takes `text` and optionally `language`, `aspect`, look and pacing settings and `locale`. Returns the studio link. |
| `scribe_create_drawing` | Takes `paths` (SVG path data plus an optional ink colour each) and optionally `viewBox`, `aspect`, look settings and `locale`. Curves and arcs are flattened; the pen draws the paths in order. Returns the studio link. |
| `scribe_paint_image` | Takes `imagePath` (a local PNG or JPEG) and optionally `aspect`, `detail` (low, medium, high), `pen`, `background`, `speedMultiplier` and `locale`. Paints the photo into up to ~2800 coloured strokes (an underpaint, then detail) and returns the studio link. |
| `scribe_limits` | Lists input limits and what the Free and Premium plans allow. |

## Privacy

Photos are painted on your machine. The link holds only the pen strokes, after `#`, which browsers never send to a server, so neither the photo nor the painting is uploaded by this server.

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
```

The constants in `src/constants.ts` mirror the studio. A contract test in the Todrawn app fails if they drift, and checks that every link this server builds opens in the studio.

## Source

This repository is a read-only mirror of the package as it lives in the Todrawn monorepo, synced on every change. Issues are welcome here; pull requests are read and ported by hand.

## License

MIT
