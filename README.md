# Relay

An MCP (Model Context Protocol) server that bridges Claude conversations between your iPhone and your local Claude Code projects.

## What it does

Run Relay on a server you control. Register it as a custom Connector in Claude on both your iPhone and your desktop. Then:

- On the **iPhone**, say "save this conversation to Relay" — Claude transcribes the chat and calls Relay's `append` tool with a title it generates.
- On the **PC** in Claude Code, say "pick up the iPhone conversation about X" — Claude calls Relay's `search` or `read_topic` tool to retrieve it.

Direction reverses the same way.

The server is a thin shared notebook. The intelligence lives in the Claude on either side.

## Architecture

- **Transport**: Streamable HTTP (per the MCP spec)
- **Authentication**: OAuth 2.1 with Dynamic Client Registration, PKCE, and refresh tokens with rotation
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
| `search` | Full-text search across content + title (FTS5) |
| `read_recent` | Time-ordered view across everything |
| `read_by_id` | Fetch one entry |
| `list_sources` | List registered Connectors |

There is intentionally **no** edit or delete tool. Entries are append-only. If you regret writing something, remove it from the SQLite file directly.

### Auth flow

1. Claude calls `POST /mcp` → gets `401 Bearer` with `WWW-Authenticate: ... resource_metadata=...`
2. Claude fetches `/.well-known/oauth-protected-resource{path}` → discovers the authorization server
3. Claude fetches `/.well-known/oauth-authorization-server{path}` → discovers `/register`, `/authorize`, `/token`
4. Claude calls `POST /register` (Dynamic Client Registration) → receives a generated `client_id`
5. Claude opens a browser to `/authorize` → the **consent page** asks for the operator passcode (`RELAY_ADMIN_PASSCODE`)
6. After approval the browser redirects back with `?code=...`
7. Claude exchanges the code at `/token` (with PKCE verifier) → receives an `access_token` (4h TTL) **and** a `refresh_token` (90d TTL)
8. Subsequent `POST /mcp` calls carry the bearer; when the access token expires Claude silently refreshes — **no passcode re-entry until the refresh token expires (~3 months)**

Refresh tokens are rotated on every use; the old token is revoked. If a revoked refresh token is presented again the server treats it as theft and revokes every refresh token for that client.

## Getting started

### Local development

```bash
git clone https://github.com/kitepon-rgb/Relay.git
cd Relay
cp .env.example .env
# Fill in the values — notably:
#   RELAY_PUBLIC_MCP_URL  — full URL where the MCP endpoint will be reachable
#   RELAY_PUBLIC_AUTH_URL — base URL for the OAuth server (must share origin)
#   RELAY_OAUTH_SIGNING_KEY — `openssl rand -base64 64`
#   RELAY_ADMIN_PASSCODE   — the passcode you'll type on the consent page
npm install
npm run dev
```

The server boots on `RELAY_PORT` and serves both the MCP endpoint and the OAuth subsystem off the same port. Paths are derived from the public URLs you set.

### Deploy with Docker

```bash
docker compose up -d --build
```

The container binds to a single internal port. Put it behind a reverse proxy (Caddy, nginx, Traefik) that terminates TLS.

### Reverse-proxy layouts

You have two clean choices:

**1. Dedicated subdomain (recommended)** — every path lives at the root and there is no ambiguity:

```caddy
relay.example.com {
    reverse_proxy 127.0.0.1:18804 {
        flush_interval -1
    }
}
```

Set in `.env`:
```
RELAY_PUBLIC_MCP_URL=https://relay.example.com/mcp
RELAY_PUBLIC_AUTH_URL=https://relay.example.com
```

**2. Shared hostname under a path prefix** — useful when you cannot add DNS records or want to coexist with another service that already occupies the bare `/mcp`, `/authorize`, etc:

See [`caddy.snippet`](caddy.snippet) for the full set of `reverse_proxy` lines. Set in `.env`:
```
RELAY_PUBLIC_MCP_URL=https://example.com/relay/mcp
RELAY_PUBLIC_AUTH_URL=https://example.com/relay/auth
```

The OAuth metadata documents are then served at `/.well-known/oauth-authorization-server/relay/auth` and `/.well-known/oauth-protected-resource/relay/mcp` (path-suffix form per RFC 8414 / RFC 9728).

### Hairpin-NAT note

If your home router does not loop traffic from the LAN back through the public IP, devices on the same LAN cannot reach `https://relay.example.com/...`. Add an entry to your machine's `hosts` file pointing the public hostname to the server's LAN IP:

```
192.168.x.x  relay.example.com
```

The TLS certificate served by Caddy will still validate because SNI matches the public hostname.

### Registering as a Claude Connector

In the Claude app (iPhone or desktop), open **Custom Connector** and enter:

- **Name**: anything (`Relay` works)
- **Remote MCP server URL**: the value of `RELAY_PUBLIC_MCP_URL`
- **OAuth Client ID / Secret**: leave **empty** — Claude will perform Dynamic Client Registration

You will be redirected to the consent page once. Type the passcode you set in `RELAY_ADMIN_PASSCODE`. Done.

## Configuration

All configuration lives in environment variables. See [.env.example](.env.example) for the full list. The server fails fast on startup if a required variable is missing or invalid — it does **not** fall back to defaults.

| Var | Required | Notes |
|---|---|---|
| `RELAY_PORT` | yes | Internal listening port |
| `RELAY_PUBLIC_MCP_URL` | yes | Full public URL of the MCP endpoint |
| `RELAY_PUBLIC_AUTH_URL` | yes | Public base URL of the OAuth server (same origin, different path) |
| `RELAY_OAUTH_SIGNING_KEY` | yes | ≥32 chars; signs JWT access tokens (HS256) |
| `RELAY_ADMIN_PASSCODE` | yes | ≥8 chars; gate on the consent page |
| `RELAY_DB_PATH` | yes | SQLite file path (mount a volume in Docker) |
| `LOG_LEVEL` | yes | `debug` / `info` / `warn` / `error` |

## Operations

- **Backup**: copy the SQLite file at `RELAY_DB_PATH`. It contains the entries, registered OAuth clients, and the refresh-token hash table. The raw refresh tokens are not stored — only `SHA-256(token)` — so a stolen DB does not yield usable tokens.
- **Revoke a connector**: `UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_id = '<client_id>';` then on next refresh the connector is forced through the consent flow again.
- **Rotate the signing key**: change `RELAY_OAUTH_SIGNING_KEY` and restart. All existing access tokens become invalid; refresh tokens still work and produce new access tokens signed with the new key.
- **Change the consent passcode**: change `RELAY_ADMIN_PASSCODE` and restart. Existing refresh tokens are unaffected; only future consent prompts are gated by the new value.

## Design principles

- **No fallbacks.** If something fails, the server returns an error. Retries are the caller's responsibility (Claude already retries).
- **Append-only storage.** No edits, no deletes, no merge conflicts.
- **Independent read paths.** Browsing by topic, full-text search, and time-ordered reads are separate tools — not one fuzzy-matching read tool that tries to be clever.
- **Tokens are hashed, never stored raw.** Both authorization codes and refresh tokens are persisted as SHA-256 hashes; the wire-format secret never touches disk.

## License

MIT — see [LICENSE](LICENSE).
