// MCP tool definitions for Relay.
// Each tool returns structured JSON content describing the result.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RelayError } from './storage.js';
import type { Entry, Storage, TopicSummary, SourceSummary } from './storage.js';

export const appendLogInputShape = {
  title: z.string().min(1).describe('Human-readable title; include the date when relevant'),
  turns: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    text: z.string().min(1),
  })).min(1).describe('Conversation turns in chronological order; each text must be a verbatim copy of the original utterance'),
  meta: z.record(z.string(), z.unknown()).optional().describe('Optional structured metadata (free-form JSON object); turns are auto-merged into meta.turns'),
};
export const appendLogInputObject = z.object(appendLogInputShape);
type AppendLogInput = z.infer<typeof appendLogInputObject>;

export function buildAppendLogHandler(deps: { storage: Storage; resolveSource: () => string }) {
  return async ({ title, turns, meta }: AppendLogInput) => {
    const content = turns.map(t => `${t.role}: ${t.text}`).join('\n\n');
    const mergedMeta = { ...(meta ?? {}), turns };
    const entry = deps.storage.insertEntry({
      source: deps.resolveSource(),
      title,
      content,
      meta: mergedMeta,
      kind: 'log',
    });
    return asJsonContent({ ok: true, entry: entryToJson(entry) });
  };
}

interface RegisterOptions {
  readonly storage: Storage;
  /** Returns the OAuth client_id (or stub) for the current request. */
  readonly resolveSource: () => string;
}

function entryToJson(e: Entry): Record<string, unknown> {
  return {
    id: e.id,
    created_at: e.createdAt,
    source: e.source,
    title: e.title,
    content: e.content,
    meta: e.meta,
  };
}

function topicToJson(t: TopicSummary): Record<string, unknown> {
  return {
    title: t.title,
    entry_count: t.entryCount,
    last_updated: t.lastUpdated,
    sources: t.sources,
  };
}

function sourceToJson(s: SourceSummary): Record<string, unknown> {
  return {
    source: s.source,
    entry_count: s.entryCount,
    first_seen_at: s.firstSeenAt,
    last_seen_at: s.lastSeenAt,
    source_label: s.sourceLabel,
  };
}

function asJsonContent(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function asErrorContent(code: string, message: string, data?: Record<string, unknown>) {
  const body: Record<string, unknown> = { error: code, message };
  if (data !== undefined) body.data = data;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
    isError: true,
  };
}

function mapRelayError(err: unknown) {
  if (err instanceof RelayError) {
    return asErrorContent(err.code, err.message, err.data);
  }
  throw err;
}

export function registerTools(server: McpServer, opts: RegisterOptions): void {
  const { storage, resolveSource } = opts;

  server.registerTool(
    'append',
    {
      title: 'Append a conversation snippet',
      description:
        '会話の要点メモや雑な記録を保存します。要約・抜粋でよい場合に使う。' +
        '会話の生流れを忠実に残したい場合は、このツールではなく append_log を使うこと。',
      inputSchema: {
        title: z.string().min(1).describe('Human-readable title; include the date when relevant'),
        content: z.string().min(1).describe('Raw conversation text to preserve'),
        meta: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional structured metadata (free-form JSON object)'),
      },
    },
    async ({ title, content, meta }) => {
      const entry = storage.insertEntry({
        source: resolveSource(),
        title,
        content,
        meta,
        kind: 'free',
      });
      return asJsonContent({ ok: true, entry: entryToJson(entry) });
    },
  );

  server.registerTool(
    'append_log',
    {
      title: 'Append a structured conversation log',
      description:
        '会話の生流れをターン単位で記録します。各 turn の text は会話原文。' +
        '要約・抜粋用途は append を使うこと。順序は古い→新しい。',
      inputSchema: appendLogInputShape,
    },
    buildAppendLogHandler({ storage, resolveSource }),
  );

  server.registerTool(
    'list_topics',
    {
      title: 'List topic titles',
      description:
        '保存されているタイトル一覧を、最終更新の新しい順に返します。' +
        'source を指定すれば特定の端末からのものだけ、since（Unix ms）を指定すれば日時で絞り込めます。',
      inputSchema: {
        source: z.string().optional().describe('Filter by source (OAuth client_id)'),
        since: z.number().int().nonnegative().optional().describe('Unix milliseconds; only topics updated at or after this time'),
      },
    },
    async ({ source, since }) => {
      const topics = storage.listTopics({ source, since });
      return asJsonContent({ topics: topics.map(topicToJson) });
    },
  );

  server.registerTool(
    'read_topic',
    {
      title: 'Read entries under a topic title',
      description:
        '特定のタイトルに紐づくエントリを新しい順に返します。' +
        'before_id を渡せば、その ID より古いものを取得できる（ページング）。',
      inputSchema: {
        title: z.string().min(1).describe('Exact title to read'),
        limit: z.number().int().positive().max(200).optional().describe('Max entries to return (default 20)'),
        before_id: z.string().optional().describe('Return entries strictly older than this ID'),
      },
    },
    async ({ title, limit, before_id }) => {
      try {
        const entries = storage.readTopic({ title, limit, beforeId: before_id });
        return asJsonContent({ entries: entries.map(entryToJson) });
      } catch (err) {
        return mapRelayError(err);
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Full-text search',
      description:
        'すべてのエントリの本文＋タイトルを FTS5 で全文検索します。' +
        'query は SQLite FTS5 構文（"cat dog" や "phrase" や col:value）。' +
        'title / source で結果をさらに絞り込み可能。',
      inputSchema: {
        query: z.string().min(1).describe('FTS5 query string'),
        title: z.string().optional().describe('Restrict to a specific topic title'),
        source: z.string().optional().describe('Restrict to a specific source'),
        limit: z.number().int().positive().max(200).optional().describe('Max entries to return (default 20)'),
      },
    },
    async ({ query, title, source, limit }) => {
      try {
        const entries = storage.search({ query, title, source, limit });
        return asJsonContent({ entries: entries.map(entryToJson) });
      } catch (err) {
        return mapRelayError(err);
      }
    },
  );

  server.registerTool(
    'read_recent',
    {
      title: 'Read most recent entries',
      description:
        'タイトルに関わらず、最新のエントリを横断的に返します。' +
        'source や title で絞り込み可能。',
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe('Max entries to return (default 20)'),
        source: z.string().optional().describe('Restrict to a specific source'),
        title: z.string().optional().describe('Restrict to a specific topic title'),
      },
    },
    async ({ limit, source, title }) => {
      const entries = storage.readRecent({ limit, source, title });
      return asJsonContent({ entries: entries.map(entryToJson) });
    },
  );

  server.registerTool(
    'read_by_id',
    {
      title: 'Read a single entry by ID',
      description: '指定 ID のエントリを 1 件取得します。',
      inputSchema: {
        id: z.string().min(1).describe('Entry ID (UUID v7)'),
      },
    },
    async ({ id }) => {
      const entry = storage.getEntryById(id);
      if (entry === null) {
        return asErrorContent('NOT_FOUND', `entry ${id} not found`, { id });
      }
      return asJsonContent({ entry: entryToJson(entry) });
    },
  );

  server.registerTool(
    'list_sources',
    {
      title: 'List known sources (devices / connectors)',
      description:
        '書き込み履歴のあるすべての source とその統計情報を返します。' +
        'OAuth で登録された client_name (source_label) が紐付いていれば併せて返す。',
      inputSchema: {},
    },
    async () => {
      const sources = storage.listSources();
      return asJsonContent({ sources: sources.map(sourceToJson) });
    },
  );
}
