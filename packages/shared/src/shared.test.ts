import { describe, expect, it } from 'vitest';
import {
  IpcChannels,
  ModelHealthSchema,
  ResearchTaskSchema,
  err,
  ok,
  toErrorMessage,
} from './index.js';

describe('Result helpers', () => {
  it('builds ok and err values', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });

  it('normalises unknown errors', () => {
    expect(toErrorMessage(new Error('x'))).toBe('x');
    expect(toErrorMessage('y')).toBe('y');
    expect(toErrorMessage({ a: 1 })).toBe('{"a":1}');
  });
});

describe('ModelHealthSchema', () => {
  const base = {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    checkedAt: '2026-11-04T12:00:00.000Z',
  };

  it('accepts each status variant', () => {
    expect(
      ModelHealthSchema.parse({
        ...base,
        status: 'ready',
        serverVersion: '0.40.14',
        capabilities: ['completion', 'tools'],
        contextLength: 40960,
        structuredOutput: true,
      }),
    ).toBeTruthy();
    expect(
      ModelHealthSchema.parse({
        ...base,
        status: 'model-missing',
        serverVersion: '0.40.14',
        installedModels: [],
      }),
    ).toBeTruthy();
    expect(
      ModelHealthSchema.parse({ ...base, status: 'unreachable', reason: 'timeout', error: 'slow' }),
    ).toBeTruthy();
  });

  it('rejects unknown providers and reasons', () => {
    const unreachable = { ...base, status: 'unreachable', reason: 'timeout', error: 'z' };
    expect(ModelHealthSchema.safeParse({ ...unreachable, provider: 'openai' }).success).toBe(false);
    expect(ModelHealthSchema.safeParse({ ...unreachable, reason: 'cosmic-rays' }).success).toBe(
      false,
    );
  });
});

describe('ResearchTaskSchema', () => {
  it('rejects an empty question', () => {
    const now = new Date().toISOString();
    const result = ResearchTaskSchema.safeParse({
      id: 't1',
      question: '   ',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    expect(result.success).toBe(false);
  });
});

describe('IpcChannels', () => {
  it('has unique channel names', () => {
    const names = Object.values(IpcChannels);
    expect(new Set(names).size).toBe(names.length);
  });
});
