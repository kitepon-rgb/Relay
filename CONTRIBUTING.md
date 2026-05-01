# Contributing to Relay

Thanks for considering a contribution. Relay is small on purpose; the bar for new features is "is this load-bearing for the iPhone-Claude-to-Claude-Code bidirectional path, or for self-hosting it safely?"

## Before opening a PR

- Open a Discussion or Issue first if the change is not a one-line bug fix. Architecture changes and new MCP tools should be agreed on before code is written.
- Read the [design principles](README.md#design-principles) — fallbacks are forbidden, the store is append-only, and tokens are hashed.

## Local setup

```bash
git clone https://github.com/kitepon-rgb/Relay.git
cd Relay
cp .env.example .env  # fill in seven variables
npm install
npm run dev
```

The server boots on `RELAY_PORT` and serves both the MCP endpoint and the OAuth subsystem off the same port. See the README for reverse-proxy snippets and how to register a Custom Connector.

## What CI checks

Every push and PR runs `npm run typecheck` and `npm run build` against Node 22. PRs that fail CI will not be reviewed until they pass.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. The first line should fit in 72 characters; the body explains *why* the change is being made — not what changed (the diff already says that).

## Pull request expectations

- One topic per PR. Split unrelated changes into separate PRs.
- Update the README when behavior changes — especially the tools table, environment variables, or error codes.
- Add an entry to `CHANGELOG.md` under `## [Unreleased]`.
- New MCP tools and new error codes must be documented in the README before merge.

## License

By contributing you agree your code will be released under the [MIT License](LICENSE).
