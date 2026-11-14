import { describe, expect, it } from 'vitest';
import { OLLAMA_DEFAULT_BASE_URL, loadOllamaConfig, resolveOllamaBaseUrl } from './config.js';

describe('resolveOllamaBaseUrl', () => {
  it.each([
    [undefined, OLLAMA_DEFAULT_BASE_URL],
    ['', OLLAMA_DEFAULT_BASE_URL],
    ['   ', OLLAMA_DEFAULT_BASE_URL],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['127.0.0.1', 'http://127.0.0.1:11434'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['0.0.0.0', 'http://127.0.0.1:11434'],
    ['0.0.0.0:8080', 'http://127.0.0.1:8080'],
    ['http://gpu-box:9000', 'http://gpu-box:9000'],
    ['http://gpu-box:80', 'http://gpu-box:80'],
    // Phase 7.3: https:// without a port is a reverse proxy or tunnel on 443 (as the Ollama CLI treats it).
    ['https://ollama.internal', 'https://ollama.internal'],
    ['https://ollama.internal/', 'https://ollama.internal'],
    ['https://ollama.internal:443', 'https://ollama.internal:443'],
    ['https://ollama.internal:11434', 'https://ollama.internal:11434'],
    ['https://example-tunnel.ngrok-free.dev', 'https://example-tunnel.ngrok-free.dev'],
    // A path prefix behind a reverse proxy is kept.
    ['https://proxy.example.com/ollama/', 'https://proxy.example.com/ollama'],
    ['http://gpu-box:9000/ollama', 'http://gpu-box:9000/ollama'],
    // Unchanged: plain host or http:// without a port means Ollama's 11434.
    ['gpu-box', 'http://gpu-box:11434'],
    ['http://gpu-box', 'http://gpu-box:11434'],
    ['ftp://bad', OLLAMA_DEFAULT_BASE_URL],
  ])('resolves %j to %s', (input, expected) => {
    expect(resolveOllamaBaseUrl(input)).toBe(expected);
  });

  it('never defaults to "localhost"', () => {
    expect(OLLAMA_DEFAULT_BASE_URL).not.toContain('localhost');
  });
});

describe('loadOllamaConfig', () => {
  it('applies defaults', () => {
    expect(loadOllamaConfig({})).toEqual({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      numCtx: 4096,
      requestTimeoutMs: 5000,
      generateTimeoutMs: 300_000,
      streamIdleTimeoutMs: 120_000,
      generation: {},
    });
  });

  it('reads overrides', () => {
    const config = loadOllamaConfig({
      OLLAMA_HOST: '127.0.0.1:12000',
      OLLAMA_MODEL: 'qwen3:4b',
      OLLAMA_NUM_CTX: '8192',
      OLLAMA_REQUEST_TIMEOUT_MS: '1000',
      OLLAMA_GENERATE_TIMEOUT_MS: '60000',
      OLLAMA_STREAM_IDLE_TIMEOUT_MS: '30000',
    });
    expect(config).toMatchObject({
      baseUrl: 'http://127.0.0.1:12000',
      model: 'qwen3:4b',
      numCtx: 8192,
      requestTimeoutMs: 1000,
      generateTimeoutMs: 60_000,
      streamIdleTimeoutMs: 30_000,
    });
  });

  it('rejects invalid numbers', () => {
    expect(() => loadOllamaConfig({ OLLAMA_NUM_CTX: 'lots' })).toThrow();
    expect(() => loadOllamaConfig({ OLLAMA_NUM_CTX: '10' })).toThrow();
  });
});
