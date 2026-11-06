import { describe, expect, it } from 'vitest';
import { type OllamaConfig } from '../config.js';
import { ModelProviderError } from '../errors.js';
import { chatChunk, jsonResponse, ndjsonResponse, testConfig } from '../testing/fixtures.js';
import { OllamaProvider, type FetchLike } from './provider.js';

/*
 * Runtime configuration: model discovery, reconfiguration without restart,
 * snapshots for task isolation, the access token rule and redirect refusal.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
}

const TAGS = {
  models: [
    {
      name: 'qwen3:8b',
      modified_at: '2026-10-01T10:00:00Z',
      size: 5_225_376_047,
      digest: 'abc123',
      details: {
        format: 'gguf',
        family: 'qwen3',
        families: ['qwen3'],
        parameter_size: '8.2B',
        quantization_level: 'Q4_K_M',
      },
    },
    {
      name: 'llama3.2:3b',
      details: {
        format: 'gguf',
        family: 'llama',
        parameter_size: '3.2B',
        quantization_level: 'Q4_K_M',
      },
    },
  ],
};

const SHOW = {
  details: {
    format: 'gguf',
    family: 'qwen3',
    parameter_size: '8.2B',
    quantization_level: 'Q4_K_M',
  },
  capabilities: ['completion', 'tools', 'thinking'],
  model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 },
  parameters: 'temperature 0.6\ntop_p 0.95',
  license: 'Apache License\nVersion 2.0',
  modified_at: '2026-10-01T10:00:00Z',
};

/** A fake Ollama per base URL: { 'http://a:11434': routes }. */
function servers(byOrigin: Record<string, Record<string, (body: unknown) => Response>>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url: url.href, method: init?.method ?? 'GET', headers, body });
    expect(init?.redirect).toBe('manual');
    const server = Object.entries(byOrigin).find(([base]) => input.startsWith(base));
    if (!server) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const path = input.slice(server[0].length);
    const handler = server[1][path];
    if (!handler) return jsonResponse({ error: 'not found' }, 404);
    return handler(body);
  };
  return { fetch, calls };
}

const ollamaRoutes = (version = '0.12.6') => ({
  '/api/version': () => jsonResponse({ version }),
  '/api/tags': () => jsonResponse(TAGS),
  '/api/show': () => jsonResponse(SHOW),
  '/api/chat': (body: unknown) =>
    (body as { stream: boolean }).stream
      ? ndjsonResponse([chatChunk('Hi'), chatChunk('', true)])
      : jsonResponse(chatChunk('Hello', true)),
});

const config = (patch: Partial<OllamaConfig> = {}): OllamaConfig => ({ ...testConfig, ...patch });

describe('model discovery', () => {
  it('lists installed models with their details, sorted by name', async () => {
    const { fetch } = servers({ 'http://127.0.0.1:11434': ollamaRoutes() });
    const models = await new OllamaProvider(config(), { fetch }).listModels();
    expect(models.map((m) => m.name)).toEqual(['llama3.2:3b', 'qwen3:8b']);
    expect(models[1]).toEqual({
      name: 'qwen3:8b',
      family: 'qwen3',
      families: ['qwen3'],
      parameterSize: '8.2B',
      quantization: 'Q4_K_M',
      format: 'gguf',
      sizeBytes: 5_225_376_047,
      modifiedAt: '2026-10-01T10:00:00Z',
      digest: 'abc123',
    });
    expect(models[0]).toMatchObject({ sizeBytes: null, modifiedAt: null, families: [] });
  });

  it('shows model details and capabilities via POST /api/show', async () => {
    const { fetch, calls } = servers({ 'http://127.0.0.1:11434': ollamaRoutes() });
    const details = await new OllamaProvider(config(), { fetch }).showModel('qwen3:8b');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { model: 'qwen3:8b' } });
    expect(details).toEqual({
      name: 'qwen3:8b',
      capabilities: ['completion', 'tools', 'thinking'],
      family: 'qwen3',
      parameterSize: '8.2B',
      quantization: 'Q4_K_M',
      format: 'gguf',
      contextLength: 40960,
      architecture: 'qwen3',
      parameters: 'temperature 0.6\ntop_p 0.95',
      license: 'Apache License',
      modifiedAt: '2026-10-01T10:00:00Z',
    });
  });

  it('reports an unknown model from /api/show as model-not-found', async () => {
    const { fetch } = servers({
      'http://127.0.0.1:11434': {
        ...ollamaRoutes(),
        '/api/show': () => jsonResponse({ error: "model 'nope' not found" }, 404),
      },
    });
    await expect(new OllamaProvider(config(), { fetch }).showModel('nope')).rejects.toMatchObject({
      code: 'model-not-found',
    });
  });

  it('tests a connection: version and response time', async () => {
    const { fetch } = servers({ 'http://127.0.0.1:11434': ollamaRoutes('0.12.6') });
    const info = await new OllamaProvider(config(), { fetch }).testConnection();
    expect(info.version).toBe('0.12.6');
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('explains when the URL is not an Ollama server', async () => {
    const { fetch } = servers({
      'http://127.0.0.1:8080': { '/api/version': () => jsonResponse({ hello: 'world' }) },
    });
    const ollama = new OllamaProvider(config({ baseUrl: 'http://127.0.0.1:8080' }), { fetch });
    await expect(ollama.testConnection()).rejects.toThrow(
      /Is http:\/\/127.0.0.1:8080 an Ollama server\?/,
    );
  });

  it('supports a reverse-proxy path prefix', async () => {
    const { fetch, calls } = servers({ 'https://example.com/ollama': ollamaRoutes() });
    const ollama = new OllamaProvider(config({ baseUrl: 'https://example.com/ollama' }), { fetch });
    await ollama.listModels();
    expect(calls[0]?.url).toBe('https://example.com/ollama/api/tags');
  });
});

describe('runtime reconfiguration', () => {
  it('changing the URL, model and options affects subsequent requests only', async () => {
    const { fetch, calls } = servers({
      'http://127.0.0.1:11434': ollamaRoutes(),
      'http://192.168.1.100:11434': ollamaRoutes(),
    });
    const ollama = new OllamaProvider(config(), { fetch });
    await ollama.generate({ messages: [{ role: 'user', content: 'a' }] });
    expect(calls.at(-1)).toMatchObject({
      url: 'http://127.0.0.1:11434/api/chat',
      body: { model: 'qwen3:8b', options: { num_ctx: 4096 } },
    });

    ollama.reconfigure(
      config({
        baseUrl: 'http://192.168.1.100:11434',
        model: 'llama3.2:3b',
        numCtx: 8192,
        generation: { temperature: 0.2, topP: 0.9, topK: 40, numPredict: 256, repeatPenalty: 1.1 },
      }),
    );
    expect(ollama.defaultModel).toBe('llama3.2:3b');
    await ollama.generate({ messages: [{ role: 'user', content: 'b' }] });
    expect(calls.at(-1)).toMatchObject({
      url: 'http://192.168.1.100:11434/api/chat',
      body: {
        model: 'llama3.2:3b',
        options: {
          num_ctx: 8192,
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
          num_predict: 256,
          repeat_penalty: 1.1,
        },
      },
    });
  });

  it('request options win over configured defaults; unset defaults are not sent', async () => {
    const { fetch, calls } = servers({ 'http://127.0.0.1:11434': ollamaRoutes() });
    const ollama = new OllamaProvider(
      config({ generation: { temperature: 0.8, numPredict: 2000 } }),
      { fetch },
    );
    await ollama.generate({
      messages: [{ role: 'user', content: 'a' }],
      options: { temperature: 0, maxTokens: 100 },
    });
    expect(calls.at(-1)?.body?.['options']).toEqual({
      num_ctx: 4096,
      temperature: 0,
      num_predict: 100,
    });
    expect(ollama.effectiveOptions()).toEqual({
      num_ctx: 4096,
      temperature: 0.8,
      num_predict: 2000,
    });
  });

  it('a stream keeps the configuration it started with', async () => {
    const { fetch, calls } = servers({
      'http://127.0.0.1:11434': ollamaRoutes(),
      'http://10.0.0.5:11434': ollamaRoutes(),
    });
    const ollama = new OllamaProvider(config(), { fetch });
    const stream = ollama.generateStream({ messages: [{ role: 'user', content: 'a' }] });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // request sent
    ollama.reconfigure(config({ baseUrl: 'http://10.0.0.5:11434', model: 'llama3.2:3b' }));
    const rest: unknown[] = [];
    for (let r = await iterator.next(); !r.done; r = await iterator.next()) rest.push(r.value);
    expect(rest.at(-1)).toMatchObject({ type: 'done', result: { content: 'Hi' } });
    expect(calls.filter((c) => c.url.endsWith('/api/chat')).map((c) => c.url)).toEqual([
      'http://127.0.0.1:11434/api/chat',
    ]);
  });

  it('a snapshot is unaffected by later changes (task isolation)', async () => {
    const { fetch, calls } = servers({
      'http://127.0.0.1:11434': ollamaRoutes(),
      'http://10.0.0.5:11434': ollamaRoutes(),
    });
    const live = new OllamaProvider(config({ generation: { temperature: 0.3 } }), { fetch });
    const forTask = live.snapshot();
    live.reconfigure(
      config({ baseUrl: 'http://10.0.0.5:11434', model: 'llama3.2:3b', generation: {} }),
    );
    await forTask.generate({ messages: [{ role: 'user', content: 'a' }] });
    expect(calls.at(-1)).toMatchObject({
      url: 'http://127.0.0.1:11434/api/chat',
      body: { model: 'qwen3:8b', options: { temperature: 0.3 } },
    });
    expect(forTask.defaultModel).toBe('qwen3:8b');
    expect(live.defaultModel).toBe('llama3.2:3b');
  });

  it('disconnect blocks requests; testConnection still works', async () => {
    let connected = false;
    const { fetch, calls } = servers({ 'http://127.0.0.1:11434': ollamaRoutes() });
    const ollama = new OllamaProvider(config(), { fetch, isConnected: () => connected });
    expect(await ollama.checkHealth()).toMatchObject({
      status: 'unreachable',
      reason: 'disconnected',
    });
    await expect(
      ollama.generate({ messages: [{ role: 'user', content: 'a' }] }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(/Disconnected/),
    });
    expect(calls).toHaveLength(0);
    await expect(ollama.testConnection()).resolves.toMatchObject({ version: '0.12.6' });
    connected = true;
    expect(await ollama.checkHealth()).toMatchObject({ status: 'ready' });
  });
});

describe('remote connection safety', () => {
  const token = () => 'secret-token-123';

  it('sends the access token over HTTPS and to loopback only', async () => {
    const { fetch, calls } = servers({
      'https://ollama.example.com': ollamaRoutes(),
      'http://192.168.1.100:11434': ollamaRoutes(),
      'http://127.0.0.1:11434': ollamaRoutes(),
    });
    for (const baseUrl of [
      'https://ollama.example.com',
      'http://192.168.1.100:11434',
      'http://127.0.0.1:11434',
    ]) {
      await new OllamaProvider(config({ baseUrl }), {
        fetch,
        getAuthToken: token,
      }).testConnection();
    }
    expect(calls.map((c) => [c.url, c.headers['authorization'] ?? null])).toEqual([
      ['https://ollama.example.com/api/version', 'Bearer secret-token-123'],
      ['http://192.168.1.100:11434/api/version', null],
      ['http://127.0.0.1:11434/api/version', 'Bearer secret-token-123'],
    ]);
  });

  it('refuses redirects', async () => {
    const { fetch } = servers({
      'https://ollama.example.com': {
        '/api/version': () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
      },
    });
    const ollama = new OllamaProvider(config({ baseUrl: 'https://ollama.example.com' }), { fetch });
    const error = await ollama.testConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({
      code: 'http-error',
      message: expect.stringMatching(/redirect.*not followed/),
    });
  });

  it('explains authentication failures', async () => {
    const { fetch } = servers({
      'https://ollama.example.com': {
        '/api/version': () => jsonResponse({ error: 'unauthorized' }, 401),
      },
    });
    const ollama = new OllamaProvider(config({ baseUrl: 'https://ollama.example.com' }), { fetch });
    await expect(ollama.testConnection()).rejects.toThrow(
      /refused access \(HTTP 401\).*access token/,
    );
  });

  it('reports an unreachable server as unavailable', async () => {
    const { fetch } = servers({});
    const ollama = new OllamaProvider(config({ baseUrl: 'http://192.168.1.100:11434' }), { fetch });
    await expect(ollama.testConnection()).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(
        /Cannot reach Ollama at http:\/\/192\.168\.1\.100:11434.*ECONNREFUSED/,
      ),
    });
  });
});
