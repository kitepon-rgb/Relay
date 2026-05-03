import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage.js';
import { createTempStorage } from './_helpers.js';

describe('storage kind column', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createTempStorage();
  });

  afterEach(() => {
    storage.close();
  });

  it('records kind=free for append-style entries', () => {
    const entry = storage.insertEntry({
      source: 'test',
      title: 't',
      content: 'hello',
      kind: 'free',
    });
    expect(storage.getEntryKindForTest(entry.id)).toBe('free');
  });

  it('records kind=log for append_log-style entries', () => {
    const entry = storage.insertEntry({
      source: 'test',
      title: 't',
      content: 'user: hi\n\nassistant: hello',
      kind: 'log',
    });
    expect(storage.getEntryKindForTest(entry.id)).toBe('log');
  });

  it('keeps existing read APIs free of the kind field (backward-compat)', () => {
    storage.insertEntry({ source: 's', title: 'topic-a', content: 'one', kind: 'free' });
    storage.insertEntry({ source: 's', title: 'topic-a', content: 'two', kind: 'log' });

    const recent = storage.readRecent({ limit: 10 });
    for (const e of recent) {
      expect(e).not.toHaveProperty('kind');
    }

    const topic = storage.readTopic({ title: 'topic-a' });
    for (const e of topic) {
      expect(e).not.toHaveProperty('kind');
    }

    const byId = storage.getEntryById(recent[0]!.id);
    expect(byId).not.toBeNull();
    expect(byId).not.toHaveProperty('kind');
  });

  it('returns null kind for unknown id', () => {
    expect(storage.getEntryKindForTest('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
