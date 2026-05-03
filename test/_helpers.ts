import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Storage } from '../src/storage.js';
import { openStorage } from '../src/storage.js';

export function createTempStorage(): Storage {
  return openStorage(':memory:');
}

export function createTempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'relay-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * Build a legacy-schema SQLite file (no kind column, no FTS, no triggers,
 * no clients table) to feed into openStorage() for migration testing.
 * The reopened DB will pick up the kind ALTER and the rest of SCHEMA_SQL
 * via CREATE * IF NOT EXISTS.
 */
export function createLegacyDb(path: string, fixtureRow: { id: string; createdAt: number; source: string; title: string; content: string }): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE entries (
      id          TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      source      TEXT NOT NULL,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      meta        TEXT
    );
  `);
  db.prepare(
    `INSERT INTO entries (id, created_at, source, title, content, meta) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fixtureRow.id, fixtureRow.createdAt, fixtureRow.source, fixtureRow.title, fixtureRow.content, null);
  db.close();
}
