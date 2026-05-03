# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New tool `append_log` for storing conversations as a structured array of turns. Each turn is `{ role: 'user' | 'assistant' | 'system' | 'tool', text: string }`; the structure is what closes the summarization loophole that a single `content` string left open. The handler joins turns into a natural-text `content` (so existing read tools display logs cleanly with no JSON noise) and preserves the structured turns under `meta.turns` for callers that need them.
- `entries` table gained a `kind` column (`free` | `log`). Existing rows are backfilled with `'free'` once on first startup; the column has no DB-level CHECK or NOT NULL because SQLite cannot add those after the fact, so the zod enum on `insertEntry` is the sole guarantor going forward. `kind` is internal-only — no existing tool's response shape changes.
- `Storage.getEntryKindForTest(id)` is exposed on the interface for test verification of the new column. Production code does not call it.

### Changed

- `append`'s description now points users at `append_log` for verbatim conversation transcripts. The schema and response shape are unchanged.
- `append_log`'s handler is exported as a factory (`buildAppendLogHandler`) and its input schema as `appendLogInputShape` / `appendLogInputObject`, so unit tests can call it without standing up a full MCP server. The other tools remain inline; this asymmetry is a deliberate test-ergonomics tradeoff.

## [0.1.1] - 2026-05-01

### Added

- FTS5 search now uses the `trigram` tokenizer so Japanese, English, and mixed-language queries match cleanly. Existing databases are migrated in place at startup.
- Retraction pattern documented in the README: append a new entry whose `meta.retracts` references the wrong entry's id; reading Claudes are expected to honor retractions when they encounter them.
- Tool error responses now carry a structured payload `{ error, message, data }` with machine-readable codes:
  - `NOT_FOUND` — `read_by_id` with an unknown id
  - `BEFORE_ID_NOT_FOUND` — `read_topic` paginating past a missing anchor
  - `FTS_INVALID_QUERY` — `search` with a malformed FTS5 query

### Changed

- `read_by_id`'s previous lowercase `not_found` error code is now `NOT_FOUND` for consistency with the new uppercase code style.

### Fixed

- Stale MCP session ids (caused by a server restart wiping the in-memory transports map) now return HTTP 404 with `mcp_session_terminated`. The client SDK auto-reinitializes on the next request instead of looping on a generic HTTP 400 / JSON-RPC `-32600`.
- FTS query syntax errors that do not include the literal substring "fts5" (e.g. `unterminated string`) are now correctly classified as `FTS_INVALID_QUERY` via SQLite's `SQLITE_ERROR` code instead of leaking as raw exceptions.
- Hero / OG banner images regenerated with explicit top safe-zone so the title is no longer clipped at the top edge of the social preview.

## [0.1.0] - 2026-05-01

Initial public release.

### Added

- MCP Streamable HTTP server with seven tools: `append`, `list_topics`, `read_topic`, `search`, `read_recent`, `read_by_id`, `list_sources`.
- OAuth 2.1 with Dynamic Client Registration, PKCE, 4-hour HS256 access tokens, and 90-day refresh tokens with rotation and reuse detection.
- Append-only SQLite storage with FTS5 full-text search; tokens and authorization codes are persisted as `SHA-256(secret)` so the wire-format secret never touches disk.
- Three-axis identity model — `source` (which device wrote it), `title` (a human label), `id` (server-issued UUID v7).
- Docker Compose deployment; subdomain or path-prefix reverse-proxy layouts both supported.

[Unreleased]: https://github.com/kitepon-rgb/Relay/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kitepon-rgb/Relay/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kitepon-rgb/Relay/releases/tag/v0.1.0
