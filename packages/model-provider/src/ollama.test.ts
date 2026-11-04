import { describe, expect, it, vi } from 'vitest';
import { loadOllamaConfig } from './config.js';
import {
  createOllamaProvider,
  describeRequestError,
  matchesModel,
  type FetchLike,
} from './ollama.js';

const config = loadOllamaConfig({});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(routes: Record<string, () => Response>): FetchLike {
  return vi.fn((input: string) => {
    const path = new URL(input).pathname;
    const handler = routes[path];
    return handler ? Promise.resolve(handler()) : Promise.reject(new Error(`unexpected ${path}`));
  });
}

describe('createOllamaProvider.checkHealth', () => {
  it('reports ready when the model is installed', async () => {
    const fetch = fakeFetch({
      '/api/version': () => jsonResponse({ version: '0.40.14' }),
      '/api/tags': () => jsonResponse({ models: [{ name: 'qwen3:8b' }] }),
    });
    const health = await createOllamaProvider(config, { fetch }).checkHealth();
    expect(health).toEqual({
      status: 'ready',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      serverVersion: '0.40.14',
    });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/version', expect.anything());
  });

  it('reports model-missing with installed models', async () => {
    const fetch = fakeFetch({
      '/api/version': () => jsonResponse({ version: '0.40.14' }),
      '/api/tags': () => jsonResponse({ models: [{ name: 'gemma3:latest' }] }),
    });
    const health = await createOllamaProvider(config, { fetch }).checkHealth();
    expect(health).toMatchObject({ status: 'model-missing', installedModels: ['gemma3:latest'] });
  });

  it('reports unreachable on network errors', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const health = await createOllamaProvider(config, { fetch }).checkHealth();
    expect(health).toMatchObject({ status: 'unreachable', error: 'connect ECONNREFUSED' });
  });

  it('reports unreachable on HTTP errors', async () => {
    const fetch = fakeFetch({ '/api/version': () => jsonResponse({}, 500) });
    const health = await createOllamaProvider(config, { fetch }).checkHealth();
    expect(health).toMatchObject({ status: 'unreachable' });
    expect(health.status === 'unreachable' && health.error).toContain('HTTP 500');
  });

  it('reports unreachable when the server returns an unexpected shape', async () => {
    const fetch = fakeFetch({ '/api/version': () => jsonResponse({ nope: true }) });
    const health = await createOllamaProvider(config, { fetch }).checkHealth();
    expect(health.status).toBe('unreachable');
  });
});

describe('describeRequestError', () => {
  it('surfaces the underlying network error code', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    });
    expect(describeRequestError(error)).toBe('fetch failed (ECONNREFUSED)');
    expect(describeRequestError(new Error('plain'))).toBe('plain');
  });
});

describe('matchesModel', () => {
  it('matches exact names and implicit :latest', () => {
    expect(matchesModel('qwen3:8b', 'qwen3:8b')).toBe(true);
    expect(matchesModel('gemma3:latest', 'gemma3')).toBe(true);
    expect(matchesModel('qwen3:4b', 'qwen3:8b')).toBe(false);
    expect(matchesModel('qwen3:4b', 'qwen3')).toBe(false);
  });
});
