import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openStorage } from '../src/storage.js';
import { createLegacyDb, createTempDir } from './_helpers.js';

describe('storage migration: kind backfill', () => {
  let tmp: { path: string; cleanup: () => void };

  beforeEach(() => {
    tmp = createTempDir();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('backfills kind=free for legacy rows on first open', () => {
    const dbPath = join(tmp.path, 'legacy.db');
    const fixtureId = '00000000-0000-7000-8000-000000000001';
    createLegacyDb(dbPath, {
      id: fixtureId,
      createdAt: 1700000000000,
      source: 'legacy-source',
      title: 'legacy-topic',
      content: 'legacy content',
    });

    const storage = openStorage(dbPath);
    try {
      expect(storage.getEntryKindForTest(fixtureId)).toBe('free');
    } finally {
      storage.close();
    }
  });

  it('is idempotent on re-open (no second ALTER)', () => {
    const dbPath = join(tmp.path, 'legacy-idempotent.db');
    const fixtureId = '00000000-0000-7000-8000-000000000002';
    createLegacyDb(dbPath, {
      id: fixtureId,
      createdAt: 1700000000000,
      source: 'legacy-source',
      title: 'legacy-topic',
      content: 'legacy content',
    });

    const first = openStorage(dbPath);
    first.close();
    const second = openStorage(dbPath);
    try {
      expect(second.getEntryKindForTest(fixtureId)).toBe('free');
      const inserted = second.insertEntry({
        source: 'new',
        title: 'new-topic',
        content: 'new content',
        kind: 'log',
      });
      expect(second.getEntryKindForTest(inserted.id)).toBe('log');
    } finally {
      second.close();
    }
  });
});
