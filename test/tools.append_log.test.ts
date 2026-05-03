import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage.js';
import { appendLogInputObject, buildAppendLogHandler } from '../src/tools.js';
import { createTempStorage } from './_helpers.js';

describe('append_log handler', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createTempStorage();
  });

  afterEach(() => {
    storage.close();
  });

  it('joins turns into natural-text content and preserves structured turns in meta', async () => {
    const handler = buildAppendLogHandler({ storage, resolveSource: () => 'test-source' });
    const result = await handler({
      title: '2026-05-03 sample',
      turns: [
        { role: 'user', text: 'hello there' },
        { role: 'assistant', text: 'general kenobi' },
      ],
    });

    const payload = JSON.parse(result.content[0]!.text) as { ok: boolean; entry: { id: string } };
    expect(payload.ok).toBe(true);

    const id = payload.entry.id;
    expect(storage.getEntryKindForTest(id)).toBe('log');

    const entry = storage.getEntryById(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('user: hello there\n\nassistant: general kenobi');
    expect(entry!.source).toBe('test-source');

    const meta = entry!.meta as { turns: Array<{ role: string; text: string }> };
    expect(meta.turns).toHaveLength(2);
    expect(meta.turns[0]).toEqual({ role: 'user', text: 'hello there' });
    expect(meta.turns[1]).toEqual({ role: 'assistant', text: 'general kenobi' });
  });

  it('merges caller-provided meta with auto-injected turns', async () => {
    const handler = buildAppendLogHandler({ storage, resolveSource: () => 'test-source' });
    const result = await handler({
      title: 't',
      turns: [{ role: 'user', text: 'just one' }],
      meta: { custom: 'value' },
    });

    const payload = JSON.parse(result.content[0]!.text) as { entry: { id: string } };
    const entry = storage.getEntryById(payload.entry.id);
    const meta = entry!.meta as { custom: string; turns: unknown[] };
    expect(meta.custom).toBe('value');
    expect(meta.turns).toHaveLength(1);
  });
});

describe('append_log input schema', () => {
  it('rejects empty turns array', () => {
    const result = appendLogInputObject.safeParse({ title: 't', turns: [] });
    expect(result.success).toBe(false);
  });

  it('rejects empty text', () => {
    const result = appendLogInputObject.safeParse({
      title: 't',
      turns: [{ role: 'user', text: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown role', () => {
    const result = appendLogInputObject.safeParse({
      title: 't',
      turns: [{ role: 'narrator', text: 'hi' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a minimal valid payload', () => {
    const result = appendLogInputObject.safeParse({
      title: 't',
      turns: [{ role: 'user', text: 'hi' }],
    });
    expect(result.success).toBe(true);
  });
});
