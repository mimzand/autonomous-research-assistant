import { type ModelHealth } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction } from './log.js';
import { checkStartup } from './startup.js';

const base = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  checkedAt: '2026-11-05T10:00:00.000Z',
} as const;
const ready: ModelHealth = {
  ...base,
  status: 'ready',
  serverVersion: '0.12.0',
  capabilities: ['completion', 'tools'],
  contextLength: 40960,
  structuredOutput: true,
};

describe('startup check', () => {
  it('is ready when Ollama answers and the model is installed', async () => {
    const result = await checkStartup(async () => ready, true);
    expect(result).toMatchObject({ ready: true, issues: [] });
    expect(result.summary).toMatch(/ready with qwen3:8b/);
  });

  it('reports a missing model with the pull command for the user to run', async () => {
    const result = await checkStartup(
      async () => ({
        ...base,
        status: 'model-missing',
        serverVersion: '0.12.0',
        installedModels: ['llama3.2:3b'],
      }),
      true,
    );
    expect(result.ready).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ id: 'model-missing', command: 'ollama pull qwen3:8b' }),
    ]);
  });

  it('reports Ollama unreachable and missing web search', async () => {
    const result = await checkStartup(
      async () => ({
        ...base,
        status: 'unreachable',
        reason: 'unavailable',
        error: 'ECONNREFUSED',
      }),
      false,
    );
    expect(result.issues.map((i) => i.id)).toEqual(['ollama-unreachable', 'search-not-configured']);
    expect(result.ready).toBe(false);
  });

  it('never throws', async () => {
    const result = await checkStartup(() => Promise.reject(new Error('boom')), true);
    expect(result).toMatchObject({ ready: false, summary: expect.stringMatching(/boom/) });
  });
});

describe('console redaction', () => {
  it('redacts strings and errors passed to console methods', () => {
    const info = vi.fn();
    const error = vi.fn();
    const sink = { log: vi.fn(), info, warn: vi.fn(), error, debug: vi.fn() };
    installConsoleRedaction(sink);
    installConsoleRedaction(sink); // idempotent: not wrapped twice
    sink.info('Loaded C:\\Users\\zandm\\AppData\\x with token=abc', 42);
    sink.error('Failed:', new Error('GET https://a:b@example.com/?api_key=zzz'));
    expect(info).toHaveBeenCalledExactlyOnceWith(
      'Loaded C:\\Users\\[user]\\AppData\\x with token=[redacted]',
      42,
    );
    const logged = error.mock.calls[0]?.[1] as Error;
    expect(logged.message).toBe('GET https://[redacted]@example.com/?api_key=[redacted]');
    expect(logged.stack).not.toContain('zzz');
  });
});
