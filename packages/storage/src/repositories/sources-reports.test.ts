import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../testing.js';

function setup() {
  const storage = memoryStorage();
  const task = storage.tasks.create({ title: 'T', input: {} });
  return { storage, task };
}

describe('sources repository', () => {
  it('adds sources and updates them by URL instead of duplicating', () => {
    const { storage, task } = setup();
    const first = storage.sources.add(task.id, { url: 'https://example.org/a', title: 'A' });
    const again = storage.sources.add(task.id, {
      url: 'https://example.org/a',
      title: 'A (updated)',
      metadata: { lang: 'en' },
    });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ title: 'A (updated)', metadata: { lang: 'en' } });
    expect(again.updatedAt > first.updatedAt).toBe(true);
    expect(storage.sources.listByTask(task.id)).toHaveLength(1);
  });

  it('accepts only http(s) URLs', () => {
    const { storage, task } = setup();
    for (const url of ['file:///C:/secrets.txt', 'javascript:alert(1)', 'not a url']) {
      expect(() => storage.sources.add(task.id, { url })).toThrow(
        expect.objectContaining({ code: 'invalid-input' }),
      );
    }
  });

  it('stores content with hash and size, replacing on update', () => {
    const { storage, task } = setup();
    const source = storage.sources.add(task.id, { url: 'https://example.org/a' });
    const text = 'Heat pumps move heat — سلام';
    const content = storage.sources.setContent(source.id, { contentType: 'text/plain', text });
    expect(content).toMatchObject({
      sourceId: source.id,
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: createHash('sha256').update(text).digest('hex'),
    });

    const replaced = storage.sources.setContent(source.id, {
      contentType: 'text/markdown',
      text: 'v2',
    });
    expect(replaced.id).toBe(content.id);
    expect(storage.sources.getContent(source.id)).toMatchObject({
      text: 'v2',
      contentType: 'text/markdown',
    });
  });

  it('deletes content with its source', () => {
    const { storage, task } = setup();
    const source = storage.sources.add(task.id, { url: 'https://example.org/a' });
    storage.sources.setContent(source.id, { contentType: 'text/plain', text: 'x' });
    expect(storage.sources.delete(source.id)).toBe(true);
    expect(storage.sources.getContent(source.id)).toBeUndefined();
  });
});

describe('reports repository', () => {
  it('stores versioned reports and returns the latest', () => {
    const { storage, task } = setup();
    const source = storage.sources.add(task.id, { url: 'https://example.org/a' });
    const v1 = storage.reports.create(task.id, {
      title: 'Report',
      content: '# Draft',
      citedSourceIds: [source.id, source.id],
    });
    const v2 = storage.reports.create(task.id, { title: 'Report', content: '# Final' });
    expect(v1).toMatchObject({ version: 1, format: 'markdown', citedSourceIds: [source.id] });
    expect(v2.version).toBe(2);
    expect(storage.reports.latest(task.id)?.content).toBe('# Final');
    expect(storage.reports.listByTask(task.id).map((r) => r.version)).toEqual([2, 1]);
  });

  it('refuses citations of sources not recorded for the task', () => {
    const { storage, task } = setup();
    const other = storage.tasks.create({ title: 'Other', input: {} });
    const foreign = storage.sources.add(other.id, { url: 'https://example.org/x' });
    expect(() =>
      storage.reports.create(task.id, {
        title: 'R',
        content: 'x',
        citedSourceIds: ['invented-id'],
      }),
    ).toThrow(/not recorded for this task: invented-id/);
    expect(() =>
      storage.reports.create(task.id, { title: 'R', content: 'x', citedSourceIds: [foreign.id] }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(storage.reports.listByTask(task.id)).toEqual([]);
  });
});
