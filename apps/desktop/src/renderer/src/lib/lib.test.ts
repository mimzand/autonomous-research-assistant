import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCompactDateTime,
  formatDuration,
  formatRelative,
  hostOf,
  prettyJson,
  shortHash,
} from './format';
import { renderMarkdown } from './markdown';
import { TASK_FILTERS, TASK_STATUS_META } from './status';
import { describeInterruption, interruptionDetail } from './task-recovery';

describe('format helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB');
  });

  it('formats compact date-times without year or seconds', () => {
    expect(formatCompactDateTime(null)).toBe('—');
    expect(formatCompactDateTime('not a date')).toBe('not a date');
    const text = formatCompactDateTime(new Date(2026, 10, 4, 21, 5, 9).toISOString());
    expect(text).toMatch(/21:05|9:05/);
    expect(text).not.toContain('2026');
    expect(text).not.toContain(':09');
  });

  it('formats durations', () => {
    expect(formatDuration(null, '2026-11-04T10:00:00.000Z')).toBe('—');
    expect(formatDuration('2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.250Z')).toBe('250 ms');
    expect(formatDuration('2026-11-04T10:00:00.000Z', '2026-11-04T10:00:01.400Z')).toBe('1.4 s');
    expect(formatDuration('2026-11-04T10:00:00.000Z', '2026-11-04T10:02:05.000Z')).toBe(
      '2 min 5 s',
    );
  });

  it('formats relative times', () => {
    const now = new Date('2026-11-04T12:00:00.000Z');
    expect(formatRelative('2026-11-04T11:59:50.000Z', now)).toBe('just now');
    expect(formatRelative('2026-11-04T11:55:00.000Z', now)).toBe('5 min ago');
    expect(formatRelative('2026-11-04T09:00:00.000Z', now)).toBe('3 h ago');
    expect(formatRelative('2026-11-01T12:00:00.000Z', now)).toBe('3 d ago');
  });

  it('pretty-prints and truncates JSON', () => {
    expect(prettyJson({ a: 1 }).text).toBe('{\n  "a": 1\n}');
    expect(prettyJson('plain')).toEqual({ text: 'plain', truncated: false });
    expect(prettyJson('x'.repeat(50), 10)).toEqual({
      text: `${'x'.repeat(10)}\n…`,
      truncated: true,
    });
  });

  it('shortens hashes and extracts hosts', () => {
    expect(shortHash('a'.repeat(64))).toBe('a'.repeat(12));
    expect(shortHash(null)).toBe('—');
    expect(hostOf('https://example.org/a/b')).toBe('example.org');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('status metadata', () => {
  it('has a label and tone for every task status', () => {
    expect(TASK_STATUS_META.interrupted).toMatchObject({ label: 'Interrupted', tone: 'warn' });
    expect(TASK_STATUS_META.running.tone).toBe('info');
  });

  it('task filters cover every status exactly once', () => {
    const covered = TASK_FILTERS.flatMap((f) => f.statuses);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered.sort()).toEqual(Object.keys(TASK_STATUS_META).sort());
  });
});

describe('renderMarkdown', () => {
  it('renders common Markdown', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** text.\n\n- one\n- two\n\n`code`');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<code>code</code>');
  });

  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps only http(s) links and opens them externally', () => {
    const html = renderMarkdown(
      '[ok](https://example.org) [bad](javascript:alert(1)) [file](file:///C:/x)',
    );
    expect(html).toContain(
      '<a href="https://example.org" target="_blank" rel="noopener noreferrer">ok</a>',
    );
    // Unsafe links stay as inert text: never an anchor.
    expect(html).not.toMatch(/href="(javascript|file):/i);
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('does not load images', () => {
    const html = renderMarkdown('![chart](https://tracker.example/pixel.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('[image: chart]');
  });
});

describe('research tools helpers', () => {
  it('explains error codes and falls back for unknown ones', async () => {
    const { describeError } = await import('./research');
    expect(describeError({ code: 'blocked-url', message: 'x' }).hint).toMatch(/Localhost, private/);
    expect(describeError({ code: 'too-large', message: 'x' }).title).toBe('Too large');
    expect(describeError({ code: 'something-new', message: 'x' })).toEqual({
      title: 'Failed',
      hint: '',
    });
  });

  it('creates unique request ids and formats durations', async () => {
    const { formatMs, newRequestId, resultSummary } = await import('./research');
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
    expect(ids.size).toBe(100);
    expect([...ids].every((id) => id.length <= 100)).toBe(true);
    expect(formatMs(412)).toBe('412 ms');
    expect(formatMs(1534)).toBe('1.53 s');
    expect(formatMs(12_345)).toBe('12.3 s');
    expect(formatMs(null)).toBe('—');
    expect(resultSummary(1, 20)).toBe('1 result · 20 ms');
    expect(resultSummary(3, 20)).toBe('3 results · 20 ms');
  });
});

describe('task recovery text', () => {
  it('describes every interruption kind with an action', () => {
    const kinds = [
      'paused',
      'app-closed',
      'model-unavailable',
      'search-unavailable',
      'offline',
      'other',
    ] as const;
    for (const kind of kinds) {
      const view = describeInterruption({ kind, message: 'x' });
      expect(view.title).not.toBe('');
      expect(view.action).toMatch(/Resume/);
    }
    expect(describeInterruption({ kind: 'model-unavailable', message: '' }).title).toBe(
      'Waiting for Ollama',
    );
    expect(describeInterruption(null).title).toMatch(/Interrupted/);
  });

  it('shows the stored detail without the repeated hint', () => {
    expect(
      interruptionDetail({
        kind: 'model-unavailable',
        message:
          'Waiting for Ollama: connect ECONNREFUSED. Start Ollama (or check OLLAMA_HOST), then click Resume.',
      }),
    ).toBe('Waiting for Ollama: connect ECONNREFUSED.');
    expect(interruptionDetail({ kind: 'paused', message: 'Paused by the user.' })).toBeNull();
  });
});
