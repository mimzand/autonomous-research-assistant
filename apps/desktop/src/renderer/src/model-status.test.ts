import { type ModelHealth } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { describeModelStatus } from './model-status';

const base = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  checkedAt: '2026-11-04T12:00:00.000Z',
} as const;

const time = () => '12:00';

describe('describeModelStatus', () => {
  it('shows a pending state before the first check', () => {
    expect(describeModelStatus(null)).toMatchObject({
      connection: { label: 'Checking…', tone: 'pending' },
      availability: { tone: 'pending' },
      checkedAt: null,
    });
  });

  it('describes a ready model', () => {
    const health: ModelHealth = {
      ...base,
      status: 'ready',
      serverVersion: '0.40.14',
      capabilities: ['completion', 'tools', 'thinking'],
      contextLength: 40960,
      structuredOutput: true,
    };
    expect(describeModelStatus(health, time)).toEqual({
      connection: { label: 'Connected', tone: 'ok' },
      connectionDetail: null,
      model: 'qwen3:8b',
      availability: { label: 'Installed', tone: 'ok' },
      serverUrl: 'http://127.0.0.1:11434',
      serverVersion: '0.40.14',
      capabilities: ['completion', 'tools', 'thinking'],
      contextLength: '40,960 tokens',
      structuredOutput: 'Supported',
      hint: null,
      checkedAt: '12:00',
    });
  });

  it('warns when a ready model cannot call tools', () => {
    const view = describeModelStatus(
      {
        ...base,
        status: 'ready',
        serverVersion: '0.40.14',
        capabilities: ['completion'],
        contextLength: null,
        structuredOutput: false,
      },
      time,
    );
    expect(view.hint).toContain('tool support');
    expect(view.contextLength).toBeNull();
    expect(view.structuredOutput).toBe('Not supported');
  });

  it('describes a missing model with an install hint', () => {
    const view = describeModelStatus(
      {
        ...base,
        status: 'model-missing',
        serverVersion: '0.40.14',
        installedModels: ['gemma3:latest'],
      },
      time,
    );
    expect(view.connection).toEqual({ label: 'Connected', tone: 'ok' });
    expect(view.availability).toEqual({ label: 'Not installed', tone: 'warn' });
    expect(view.hint).toBe('Install it with: ollama pull qwen3:8b. Installed: gemma3:latest.');
  });

  it('punctuates server errors in the hint', () => {
    const view = describeModelStatus(
      {
        ...base,
        status: 'unreachable',
        reason: 'unavailable',
        error: 'fetch failed (ECONNREFUSED)',
      },
      time,
    );
    expect(view.hint).toBe('fetch failed (ECONNREFUSED). Start Ollama, then check again.');
  });

  it.each([
    ['unavailable', 'not running', 'Start Ollama'],
    ['timeout', 'did not respond', ''],
    ['invalid-response', 'did not answer like Ollama', ''],
    ['http-error', 'returned an error', ''],
  ] as const)('describes unreachable (%s)', (reason, detail, hint) => {
    const view = describeModelStatus(
      { ...base, status: 'unreachable', reason, error: 'boom.' },
      time,
    );
    expect(view.connection).toEqual({ label: 'Not connected', tone: 'error' });
    expect(view.connectionDetail).toContain(detail);
    expect(view.availability.label).toBe('Unknown');
    expect(view.hint).toContain('boom.');
    expect(view.hint).toContain(hint);
  });
});
