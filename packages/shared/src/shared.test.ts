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
  it('accepts each status variant', () => {
    const base = { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' };
    expect(
      ModelHealthSchema.parse({ ...base, status: 'ready', serverVersion: '0.40.14' }),
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
      ModelHealthSchema.parse({ ...base, status: 'unreachable', error: 'timeout' }),
    ).toBeTruthy();
  });

  it('rejects unknown providers', () => {
    const result = ModelHealthSchema.safeParse({
      status: 'unreachable',
      provider: 'openai',
      baseUrl: 'x',
      model: 'y',
      error: 'z',
    });
    expect(result.success).toBe(false);
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
