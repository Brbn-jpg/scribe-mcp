# Todrawn Scribe MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent turn code, text, a line drawing or a photo into a [Todrawn Scribe](https://todrawn.com/scribe) project, a video of a pen writing, drawing or painting it by hand. It can also read and draw on your Todrawn whiteboards once you sign in (see [Boards](#boards)).

For Scribe the agent gets back a link. Opening it loads the project into the Scribe studio, where you preview it and export the MP4. The whole project travels inside the link after `#`, so the Scribe tools upload nothing and need no account or API key.

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
| `todrawn_login` | Signs the agent in to your Todrawn account (device flow, see Boards). If already signed in, says as whom. |
| `todrawn_logout` | Revokes the agent's token and deletes it from this machine. |
| `board_list` | Lists your boards (owned and shared) with id, title, update date and URL. |
| `board_create` | Takes `title`. Creates an empty board and returns its id and URL. |
| `board_read` | Takes `boardId` and `format` (`summary` or `full`). The summary lists each element with id, type, position, size, text, colours and connector ends, plus the content bounds and whether the board is live. |
| `board_add` | Takes `boardId` and `elements`: rect, ellipse, poly, box, sticky, text, line, arrow, table or umlClass specs. Everything not given gets the board's normal defaults. |
| `board_connect` | Takes `boardId` and `connections` between element ids (box, sticky, umlClass) or free points, with optional ports, relation, routing and label. |
| `board_draw` | Takes `boardId`, `paths` (SVG path data) and optionally `x`, `y`, `width`. Draws them as freehand pen strokes. |
| `board_update` | Takes `boardId` and `updates` (`id` plus the fields to change). |
| `board_delete` | Takes `boardId` and `ids`. Attached connectors go with their elements. |

## Boards

The `board_*` tools work on your own Todrawn boards. Everything the agent adds appears live for anyone who has the board open, and the agent can only reach boards you own or are a member of. The Scribe tools above need no account and keep working without signing in.

Sign in once:

1. Ask the agent to run `todrawn_login`. It returns a link such as `https://todrawn.com/connect?code=BCDF-GHJK` and a code.
2. Open the link, sign in to Todrawn if asked, check that the code matches and approve. The server picks the approval up in the background; until then every board tool repeats the link and code.
3. The token is stored in `${XDG_CONFIG_HOME:-~/.config}/todrawn/mcp-token.json` (`%APPDATA%\todrawn\mcp-token.json` on Windows), directory mode 0700, file mode 0600. Tokens last 90 days.

Revoke access any time with `todrawn_logout` or from the connected agents list on your Todrawn profile page. A revoked or expired token makes the board tools tell the agent to run `todrawn_login` again.

Environment variables:

| Variable | Effect |
|---|---|
| `TODRAWN_TOKEN` | Use this token instead of the stored one (CI and headless setups). |
| `TODRAWN_API_URL` | API base URL, default `https://api.todrawn.com` (for example `http://localhost:8080`). |
| `TODRAWN_APP_URL` | App base URL used for the login page and board links, default `https://todrawn.com`. |

Boards use board units: x grows right, y grows down. Elements are built with the same defaults as the board UI (boxes and shapes 180 x 96, sticky notes 180 x 180, 18 px text, a contrasting ink on dark boards) and validated against the board's scene schema before they are sent; numbers must be finite and every rendered size at least 1 unit. Connectors attach only to box, sticky and umlClass elements; a connector label is added as a small text element at its midpoint. The Free plan allows 3 boards and the error says so when the limit is hit.

## Privacy

Photos are painted on your machine. The link holds only the pen strokes, after `#`, which browsers never send to a server, so neither the photo nor the painting is uploaded by this server.

The board tools do send data: they talk to the Todrawn API with your token. Board content the agent reads (`board_read`) is returned to the agent and therefore sent to whichever model provider you run the agent with. Only let an agent read boards you are comfortable sharing with that provider. Board text is written by people, on shared boards by other people, so the tools tell the agent to treat it as content and never as instructions; stay alert to a shared board that tries to steer your agent.

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
