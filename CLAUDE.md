# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの目的

Relay は、iPhone の Claude アプリで行った会話を、ローカルの Claude Code セッション（プロジェクト側）にそのまま取り込むための **MCP サーバー**を構築するプロジェクト。逆方向（プロジェクト側 → iPhone）も視野に入れた**双方向ブリッジ**として設計する。

「会話をそのまま取り込む」が要求の核。加工・要約・検索といった派生機能は別レイヤーの責務として切り出し、本体に混ぜ込まない。

## アーキテクチャ

**リポジトリ**: https://github.com/kitepon-rgb/Relay （Public）

**構成**:
- 言語: TypeScript + Node.js 22 LTS（ESM）
- MCP SDK: 公式 `@modelcontextprotocol/sdk`、Streamable HTTP transport（個別 handler を `metadataHandler` / `authorizationHandler` / `tokenHandler` / `clientRegistrationHandler` で custom path に mount。`mcpAuthRouter` の root 固定問題を回避）
- 認証: OAuth 2.1 — DCR + PKCE + **refresh token + rotation + reuse detection**（自前 `OAuthServerProvider` 実装、HS256 JWT を `jose` で署名）
- ストレージ: SQLite（`better-sqlite3`） + FTS5 全文検索、append-only。token / code は SHA-256 ハッシュで保存（生値は never on disk）
- 配置: Linux サーバの `~/relay/docker-compose.yml`、リバースプロキシ（caddy 等）経由で公開。**専用サブドメイン推奨**、X-MCP のような既存サービスと同居する場合のみパスベースで分離

**識別子の 3 軸**:
- `source`: OAuth client_id から逆引き（自動付与、書く側 Claude は触れない）
- `title`: 書く側 Claude が会話内容から生成（日付込み推奨）
- `id`: サーバー採番の UUID v7

**MCP ツール（8 つ、3 系統）**:
- 書き込み: `append`（自由文）, `append_log`（構造化ターン配列）
- topic 駆動: `list_topics`, `read_topic`
- 検索駆動: `search`（FTS5）
- 時系列駆動: `read_recent`
- 個別: `read_by_id`
- 管理: `list_sources`

**書き込みツールの使い分け**（書く側 iPhone Claude の運用ガイド。MCP に対話割込みが無いため tool description には書かず、ここにのみ記載）:
- 雑記・要約でよい場合 → `append`（content は自由文 1 本）
- 会話の生流れを忠実に残す場合 → `append_log`（turns: 配列で原文ターンごとに渡す。要約禁止。構造そのものが要約余地を狭める唯一の実効的圧力）
- 受信側は `read_topic` / `search` で取り出した時、`append_log` のエントリは content が `user: ...\n\nassistant: ...` の自然テキスト連結として読める。turn 構造が必要なら `meta.turns` を参照
- ターン数・文字数とも明示的な上限なし。実質天井は HTTP body 10MB（`src/index.ts` の `express.json({ limit: '10mb' })`）。長会話は同 title で複数 `append_log` に分割可

**Token TTL**:
- access token: 4h（HS256 JWT）
- refresh token: 90d（生値は SHA-256 ハッシュで `oauth_refresh_tokens` に保存）
- 24h 強制再認可は仕様上発生しない。リフレッシュ失効まで Connector は無操作

詳細は [メモリ design_decisions.md](C:/Users/kite_/.claude/projects/c--Users-kite--Documents-Program-Relay/memory/design_decisions.md) を参照。

## 開発上の鉄則

### フォールバック禁止

やむを得ない場合を除き、フォールバック処理を書かない。**エラーは素直に投げる**。

- try/except や if/else で「失敗したら別の手段を試す」パターンを提案する前に止まる。本当にやむを得ないか自問する
- 代替動作が欲しい局面では「フォールバック」ではなく**明示的な別機能・別エンドポイント**として切り出す（前セッションでの判断: 検索系は曖昧マッチのフォールバックではなく、独立したキーワード検索機能として実装する）
- デフォルト値の埋め込み・無音 catch・サイレント rescue は禁止
- ライブラリやネットワーク呼び出しが失敗したら、そのまま失敗として伝播させ、再現できる形でログに残す

理由: フォールバックがあるとバグが隠れて原因追跡ができなくなる。

### 双方向同期を前提に設計する

設計判断の出発点は常に「iPhone 側 ↔ プロジェクト側」。一方向専用の最適化に倒さない。スキーマ・エラー戦略・認証は両端で対称になるよう設計する。

### append-only

`entries` は edit/delete を持たない。同期競合は append + UUID で構造的に発生しない。後悔したら `delete_by_id` を後で足す。

### 公開リポジトリでの秘匿情報

- 会話本文・OAuth 鍵・実 token は全て env / Docker volume 経由
- リポジトリには合成データとプレースホルダのみ
- `.env`、`data/`、`*.db` は gitignore

## 開発コマンド

```
# 依存導入
npm install

# 開発実行（ホットリロード）
npm run dev

# 型チェック
npm run typecheck

# テスト
npm test

# ビルド
npm run build

# Docker ビルド + 起動（デプロイ先サーバ上）
docker compose up -d --build
```

## 必須環境変数

- `RELAY_PORT`: 内部リッスンポート
- `RELAY_PUBLIC_MCP_URL`: 公開 MCP URL（リバースプロキシで終端）
- `RELAY_PUBLIC_AUTH_URL`: 公開 OAuth ベース URL（同 origin、別パス）
- `RELAY_OAUTH_SIGNING_KEY`: ≥32 文字、HS256 署名鍵（`openssl rand -base64 64`）
- `RELAY_ADMIN_PASSCODE`: ≥8 文字、同意ページ用 passcode
- `RELAY_DB_PATH`: SQLite ファイルパス（Docker は volume マウント）
- `LOG_LEVEL`: `debug` / `info` / `warn` / `error`

`src/config.ts` で全項目検証、欠落・不正なら起動時即 throw。フォールバック禁止原則。

## デプロイパターン

- **サブドメイン方式**（推奨）: `relay.example.com` → 単一 reverse_proxy ブロック、全パス root に
- **パスベース**: `example.com/relay/*` で他 MCP と共存。`caddy.snippet` 参照、metadata は path-suffix 形式で配信
