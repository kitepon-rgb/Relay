// SQLite storage for Relay.
// Append-only entries with FTS5 full-text search.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

export interface Entry {
  readonly id: string;
  readonly createdAt: number;
  readonly source: string;
  readonly title: string;
  readonly content: string;
  readonly meta: Record<string, unknown> | null;
}

export interface TopicSummary {
  readonly title: string;
  readonly entryCount: number;
  readonly lastUpdated: number;
  readonly sources: ReadonlyArray<string>;
}

export interface SourceSummary {
  readonly source: string;
  readonly entryCount: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly sourceLabel: string | null;
}

export interface Storage {
  insertEntry(input: { source: string; title: string; content: string; meta?: Record<string, unknown> }): Entry;
  getEntryById(id: string): Entry | null;
  listTopics(opts?: { source?: string; since?: number }): TopicSummary[];
  readTopic(opts: { title: string; limit?: number; beforeId?: string }): Entry[];
  search(opts: { query: string; title?: string; source?: string; limit?: number }): Entry[];
  readRecent(opts?: { limit?: number; source?: string; title?: string }): Entry[];
  listSources(): SourceSummary[];
  registerClient(input: { clientId: string; sourceLabel: string }): void;
  touchClient(clientId: string): void;
  close(): void;
}

interface EntryRow {
  id: string;
  created_at: number;
  source: string;
  title: string;
  content: string;
  meta: string | null;
}

function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source,
    title: row.title,
    content: row.content,
    meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>),
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  meta        TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_title       ON entries(title);
CREATE INDEX IF NOT EXISTS idx_entries_source      ON entries(source);
CREATE INDEX IF NOT EXISTS idx_entries_created_at  ON entries(created_at DESC);

CREATE TABLE IF NOT EXISTS clients (
  client_id      TEXT PRIMARY KEY,
  source_label   TEXT NOT NULL,
  registered_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
  USING fts5(content, title, content='entries', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, content, title)
  VALUES (new.rowid, new.content, new.title);
END;
`;

export function openStorage(dbPath: string): Storage {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  const insertStmt = db.prepare<[string, number, string, string, string, string | null]>(
    `INSERT INTO entries (id, created_at, source, title, content, meta)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const getByIdStmt = db.prepare<[string], EntryRow>(
    `SELECT id, created_at, source, title, content, meta FROM entries WHERE id = ?`,
  );

  const listTopicsStmt = db.prepare<[number], { title: string; entry_count: number; last_updated: number; sources: string }>(
    `SELECT title,
            COUNT(*) AS entry_count,
            MAX(created_at) AS last_updated,
            GROUP_CONCAT(DISTINCT source) AS sources
       FROM entries
      WHERE created_at >= ?
      GROUP BY title
      ORDER BY last_updated DESC`,
  );

  const listTopicsBySourceStmt = db.prepare<[string, number], { title: string; entry_count: number; last_updated: number; sources: string }>(
    `SELECT title,
            COUNT(*) AS entry_count,
            MAX(created_at) AS last_updated,
            GROUP_CONCAT(DISTINCT source) AS sources
       FROM entries
      WHERE source = ? AND created_at >= ?
      GROUP BY title
      ORDER BY last_updated DESC`,
  );

  const readTopicStmt = db.prepare<[string, number], EntryRow>(
    `SELECT id, created_at, source, title, content, meta
       FROM entries
      WHERE title = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  );

  const readTopicBeforeStmt = db.prepare<
    [string, number, number, string, number],
    EntryRow
  >(
    `SELECT id, created_at, source, title, content, meta
       FROM entries
      WHERE title = ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  );

  const readRecentStmt = db.prepare<[number], EntryRow>(
    `SELECT id, created_at, source, title, content, meta
       FROM entries
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  );

  const readRecentBySourceStmt = db.prepare<[string, number], EntryRow>(
    `SELECT id, created_at, source, title, content, meta
       FROM entries
      WHERE source = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  );

  const readRecentByTitleStmt = db.prepare<[string, number], EntryRow>(
    `SELECT id, created_at, source, title, content, meta
       FROM entries
      WHERE title = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  );

  const listSourcesStmt = db.prepare<[], { source: string; entry_count: number; first_seen_at: number; last_seen_at: number; source_label: string | null }>(
    `SELECT e.source AS source,
            COUNT(*) AS entry_count,
            MIN(e.created_at) AS first_seen_at,
            MAX(e.created_at) AS last_seen_at,
            c.source_label   AS source_label
       FROM entries e
       LEFT JOIN clients c ON c.client_id = e.source
      GROUP BY e.source
      ORDER BY last_seen_at DESC`,
  );

  const registerClientStmt = db.prepare<[string, string, number, number]>(
    `INSERT INTO clients (client_id, source_label, registered_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET source_label = excluded.source_label`,
  );

  const touchClientStmt = db.prepare<[number, string]>(
    `UPDATE clients SET last_seen_at = ? WHERE client_id = ?`,
  );

  return {
    insertEntry(input) {
      const id = uuidv7();
      const createdAt = Date.now();
      const meta = input.meta === undefined ? null : JSON.stringify(input.meta);
      insertStmt.run(id, createdAt, input.source, input.title, input.content, meta);
      return {
        id,
        createdAt,
        source: input.source,
        title: input.title,
        content: input.content,
        meta: input.meta ?? null,
      };
    },

    getEntryById(id) {
      const row = getByIdStmt.get(id);
      return row ? rowToEntry(row) : null;
    },

    listTopics(opts) {
      const since = opts?.since ?? 0;
      const rows = opts?.source !== undefined
        ? listTopicsBySourceStmt.all(opts.source, since)
        : listTopicsStmt.all(since);
      return rows.map(r => ({
        title: r.title,
        entryCount: r.entry_count,
        lastUpdated: r.last_updated,
        sources: r.sources.split(','),
      }));
    },

    readTopic(opts) {
      const limit = opts.limit ?? 20;
      if (opts.beforeId !== undefined) {
        const anchor = getByIdStmt.get(opts.beforeId);
        if (anchor === undefined) {
          throw new Error(`readTopic: beforeId ${opts.beforeId} not found`);
        }
        const rows = readTopicBeforeStmt.all(opts.title, anchor.created_at, anchor.created_at, opts.beforeId, limit);
        return rows.map(rowToEntry);
      }
      const rows = readTopicStmt.all(opts.title, limit);
      return rows.map(rowToEntry);
    },

    search(opts) {
      const limit = opts.limit ?? 20;
      const filters: string[] = [];
      const params: Array<string | number> = [opts.query];
      if (opts.title !== undefined) {
        filters.push('e.title = ?');
        params.push(opts.title);
      }
      if (opts.source !== undefined) {
        filters.push('e.source = ?');
        params.push(opts.source);
      }
      params.push(limit);
      const where = filters.length === 0 ? '' : ' AND ' + filters.join(' AND ');
      const sql = `
        SELECT e.id, e.created_at, e.source, e.title, e.content, e.meta
          FROM entries_fts f
          JOIN entries e ON e.rowid = f.rowid
         WHERE entries_fts MATCH ?${where}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`;
      const rows = db.prepare<typeof params, EntryRow>(sql).all(...params);
      return rows.map(rowToEntry);
    },

    readRecent(opts) {
      const limit = opts?.limit ?? 20;
      if (opts?.title !== undefined) {
        return readRecentByTitleStmt.all(opts.title, limit).map(rowToEntry);
      }
      if (opts?.source !== undefined) {
        return readRecentBySourceStmt.all(opts.source, limit).map(rowToEntry);
      }
      return readRecentStmt.all(limit).map(rowToEntry);
    },

    listSources() {
      return listSourcesStmt.all().map(r => ({
        source: r.source,
        entryCount: r.entry_count,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        sourceLabel: r.source_label,
      }));
    },

    registerClient(input) {
      const now = Date.now();
      registerClientStmt.run(input.clientId, input.sourceLabel, now, now);
    },

    touchClient(clientId) {
      touchClientStmt.run(Date.now(), clientId);
    },

    close() {
      db.close();
    },
  };
}
