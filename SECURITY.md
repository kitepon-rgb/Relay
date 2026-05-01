# Security Policy

Relay handles OAuth tokens, refresh tokens, and a consent passcode. Please report vulnerabilities responsibly so a fix can ship before the issue becomes public.

## Reporting a vulnerability

Send a detailed report to **kitepon@gmail.com**. Include:

- A description of the vulnerability and its impact
- Steps to reproduce, ideally with a minimal example
- The Relay version (commit hash or tag) you tested against
- Any suggested mitigation

Expect an acknowledgement within 7 days. Fixes for confirmed issues will be coordinated within 90 days; complex issues may take longer with regular updates to the reporter.

Please do **not** open public issues for security problems before a fix is available.

## In scope

- Authentication and session handling — OAuth handshake, bearer validation, refresh-token rotation, reuse detection
- Storage of secrets and tokens — the `SHA-256(secret)` invariant for authorization codes and refresh tokens
- The MCP transport layer — Streamable HTTP, session id handling, stale-session recovery
- The consent page and operator passcode handling

## Out of scope

- Issues that require an attacker who already has the operator passcode or root on your server
- Vulnerabilities in upstream dependencies that already have public CVEs and unreleased fixes — those should be reported to the upstream project
- Self-DoS by misconfiguring `RELAY_OAUTH_SIGNING_KEY` or `RELAY_DB_PATH`

## Hardening notes for operators

- Treat `RELAY_OAUTH_SIGNING_KEY` and `RELAY_ADMIN_PASSCODE` as secrets. Rotate them if you suspect exposure (see the Operations section of the README).
- Refresh tokens rotate on every use. Presenting a revoked refresh token causes the server to revoke every refresh token for that client (reuse detection).
- Tokens and authorization codes are persisted as `SHA-256(secret)`. The wire-format secret never touches disk.
- Put Relay behind a reverse proxy that terminates TLS (Caddy, nginx, Traefik). Do not expose port `RELAY_PORT` directly.
