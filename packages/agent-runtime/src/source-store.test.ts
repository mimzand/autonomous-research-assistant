import { openStorage } from '@rka/storage';
import {
  createFetchSourceTool,
  createToolRegistry,
  type FetchedDocument,
  type WebFetcher,
} from '@rka/tools';
import { describe, expect, it } from 'vitest';
import { createSourceStore } from './source-store.js';

const page = (url: string, text: string): FetchedDocument => ({
  requestedUrl: url,
  finalUrl: url,
  canonicalUrl: url,
  redirects: [],
  status: 200,
  kind: 'html',
  contentType: 'text/html',
  byteLength: text.length,
  sha256: 'a'.repeat(64),
  retrievedAt: '2026-11-05T10:00:00.000Z',
  title: `Title of ${url}`,
  text,
  truncated: false,
  metadata: { lang: 'en', description: 'About heat pumps' },
  timings: { downloadMs: 1, extractMs: 1 },
});

function setup() {
  const storage = openStorage({ path: ':memory:' });
  const task = storage.tasks.create({ title: 'Research', input: { question: 'q' } });
  const fetched: string[] = [];
  const fetcher: WebFetcher = {
    async fetch(url) {
      fetched.push(url);
      return page(url, url.includes('mirror') ? 'Shared text.' : `Text of ${url}`);
    },
  };
  const registry = createToolRegistry([
    createFetchSourceTool({ fetcher, store: createSourceStore(storage) }),
  ]);
  const run = (url: string) =>
    registry.execute(
      'fetch_source',
      { url },
      { signal: new AbortController().signal, taskId: task.id },
    );
  return { storage, task, run, fetched };
}

describe('SQLite source store (fetch_source end to end)', () => {
  it('stores the source, its metadata and its text in SQLite', async () => {
    const { storage, task, run } = setup();
    const result = await run('https://example.org/heat');
    expect(result).toMatchObject({ ok: true, value: { status: 'saved' } });

    const [source] = storage.sources.listByTask(task.id);
    expect(source).toMatchObject({
      url: 'https://example.org/heat',
      title: 'Title of https://example.org/heat',
      retrievedAt: '2026-11-05T10:00:00.000Z',
      metadata: {
        requestedUrl: 'https://example.org/heat',
        httpStatus: 200,
        kind: 'html',
        rawSha256: 'a'.repeat(64),
        lang: 'en',
        description: 'About heat pumps',
      },
    });
    expect(storage.sources.getContent(source?.id ?? '')).toMatchObject({
      contentType: 'text/plain',
      text: 'Text of https://example.org/heat',
    });
    // Visible in the Knowledge Base.
    expect(storage.inspect.listSources({ taskId: task.id }).items[0]).toMatchObject({
      hasContent: true,
    });
  });

  it('detects duplicate URLs and duplicate content using the database', async () => {
    const { storage, task, run, fetched } = setup();
    await run('https://example.org/heat');
    expect(await run('https://example.org/heat?utm_source=feed#top')).toMatchObject({
      ok: true,
      value: { status: 'duplicate', reason: 'same-url', fetched: false },
    });
    await run('https://mirror-a.example/doc');
    expect(await run('https://mirror-b.example/doc')).toMatchObject({
      ok: true,
      value: { status: 'duplicate', reason: 'same-content' },
    });
    expect(storage.sources.listByTask(task.id)).toHaveLength(2);
    expect(fetched).toEqual([
      'https://example.org/heat',
      'https://mirror-a.example/doc',
      'https://mirror-b.example/doc',
    ]);
  });
});
