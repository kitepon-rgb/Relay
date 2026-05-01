# Relay

An MCP (Model Context Protocol) server that bridges Claude conversations between your iPhone and your local Claude Code projects.

> Status: **early scaffold**. Not functional yet. Tools are stubbed.

## What it does

Run Relay on a server you control. Register it as a Connector in Claude on both your iPhone and your desktop. Then:

- On the **iPhone**, say "save this conversation to Relay" — Claude transcribes the chat and calls Relay's `append` tool with a title it generates.
- On the **PC** in Claude Code, say "pick up the iPhone conversation about X" — Claude calls Relay's `search` or `read_topic` tool to retrieve it.

Direction reverses the same way.

The server is a thin shared notebook. The intelligence lives in the Claude on either side.

## Architecture

- **Transport**: Streamable HTTP (per the MCP spec)
- **Authentication**: OAuth 2.1 with Dynamic Client Registration and PKCE
- **Storage**: SQLite with FTS5 full-text search, append-only
- **Identity model**: every entry has three independent axes
  - `source` — which device wrote it (derived from OAuth `client_id`)
  - `title` — a human-meaningful label the writing Claude generates
  - `id` — server-issued UUID v7

### MCP tools

| Tool | Purpose |
|---|---|
| `append` | Write a conversation snippet (title + content) |
| `list_topics` | Browse titles by source / since |
| `read_topic` | Fetch entries under a title, newest first |
| `search` | Full-text search across content + title |
| `read_recent` | Time-ordered view across everything |
| `read_by_id` | Fetch one entry |
| `list_sources` | List registered Connectors |

There is intentionally **no** edit or delete tool. Entries are append-only. If you regret writing something, you can remove it from the SQLite file directly.

## Getting started

### Local development

```bash
git clone https://github.com/kitepon-rgb/Relay.git
cd Relay
cp .env.example .env
# fill in .env values
npm install
npm run dev
```

### Deploy with Docker

```bash
docker compose up -d --build
```

The compose file expects to run behind a reverse proxy (e.g. Caddy) that terminates TLS and forwards `/mcp` and `/auth` paths to the container. See `caddy.snippet` for an example.

## Configuration

All configuration lives in environment variables. See [.env.example](.env.example) for the full list. The server fails fast on startup if a required variable is missing — it does **not** fall back to defaults.

## Design principles

- **No fallbacks.** If something fails, the server returns an error. Retries are the caller's responsibility.
- **Append-only storage.** No edits, no deletes, no merge conflicts.
- **Independent read paths.** Browsing by topic, full-text search, and time-ordered reads are separate tools — not one fuzzy-matching read tool that tries to be clever.

## License

MIT — see [LICENSE](LICENSE).
