# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの目的

Relay は、iPhone の Claude アプリで行った会話を、ローカルの Claude Code セッション（プロジェクト側）にそのまま取り込むための **MCP サーバー**を構築するプロジェクト。逆方向（プロジェクト側 → iPhone）も視野に入れた**双方向ブリッジ**として設計する。

「会話をそのまま取り込む」が要求の核。加工・要約・検索といった派生機能は別レイヤーの責務として切り出し、本体に混ぜ込まない。

## アーキテクチャ（2026-05-01 確定）

**リポジトリ**: https://github.com/kitepon-rgb/Relay （Public）

**構成**:
- 言語: TypeScript + Node.js LTS
- MCP SDK: 公式 `@modelcontextprotocol/sdk`、Streamable HTTP transport
- 認証: OAuth 2.1（DCR + PKCE）、SDK の `requireBearerAuth` / `setupAuthServer` を使用
- ストレージ: SQLite（`better-sqlite3`） + FTS5 全文検索
- 配置: 任意の Linux サーバの `~/relay/docker-compose.yml`、リバースプロキシ（例: caddy）経由で `https://<your-host>/mcp` に公開

**識別子の 3 軸**:
- `source`: OAuth client_id から逆引き（自動付与、書く側 Claude は触れない）
- `title`: 書く側 Claude が会話内容から生成（日付込み推奨）
- `id`: サーバー採番の UUID v7

**MCP ツール（6 つ、3 系統）**:
- 書き込み: `append`
- topic 駆動: `list_topics`, `read_topic`
- 検索駆動: `search`（FTS5）
- 時系列駆動: `read_recent`
- 個別: `read_by_id`
- 管理: `list_sources`

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

実装が進んだら本セクションを実コマンドに合わせて更新する。
