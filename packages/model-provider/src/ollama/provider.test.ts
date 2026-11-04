import { describe, expect, it } from 'vitest';
import { ModelProviderError, describeRequestError } from '../errors.js';
import {
  TAGS_QWEN,
  chatChunk,
  jsonResponse,
  ndjsonResponse,
  routeFetch,
  testConfig,
} from '../testing/fixtures.js';
import { OllamaProvider, matchesModel, supportsStructuredOutput } from './provider.js';

const fixedNow = () => new Date('2026-11-04T12:00:00.000Z');

function provider(routes: Parameters<typeof routeFetch>[0]) {
  const { fetch, calls } = routeFetch(routes);
  return { ollama: new OllamaProvider(testConfig, { fetch, now: fixedNow }), calls };
}

const ok = {
  '/api/version': () => jsonResponse({ version: '0.40.14' }),
  '/api/tags': () => jsonResponse(TAGS_QWEN),
};

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('OllamaProvider.checkHealth', () => {
  it('reports ready with model capabilities', async () => {
    const { ollama } = provider(ok);
    expect(await ollama.checkHealth()).toEqual({
      status: 'ready',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      checkedAt: '2026-11-04T12:00:00.000Z',
      serverVersion: '0.40.14',
      capabilities: ['completion', 'tools', 'thinking'],
      contextLength: 40960,
      structuredOutput: true,
    });
  });

  it('reports model-missing with installed models', async () => {
    const { ollama } = provider({
      ...ok,
      '/api/tags': () => jsonResponse({ models: [{ name: 'gemma3:latest' }] }),
    });
    expect(await ollama.checkHealth()).toMatchObject({
      status: 'model-missing',
      installedModels: ['gemma3:latest'],
    });
  });

  it('reports unreachable when Ollama is down', async () => {
    const { ollama } = provider({});
    expect(await ollama.checkHealth()).toMatchObject({
      status: 'unreachable',
      reason: 'unavailable',
      error: expect.stringContaining('Cannot reach Ollama at http://127.0.0.1:11434'),
    });
  });

  it('reports unreachable on HTTP errors and invalid responses', async () => {
    const http = provider({ '/api/version': () => jsonResponse({ error: 'boom' }, 500) });
    expect(await http.ollama.checkHealth()).toMatchObject({
      status: 'unreachable',
      reason: 'http-error',
      error: expect.stringContaining('HTTP 500'),
    });

    const invalid = provider({ '/api/version': () => jsonResponse({ nope: true }) });
    expect(await invalid.ollama.checkHealth()).toMatchObject({
      status: 'unreachable',
      reason: 'invalid-response',
    });

    const html = provider({ '/api/version': () => new Response('<html>proxy</html>') });
    expect(await html.ollama.checkHealth()).toMatchObject({ reason: 'invalid-response' });
  });

  it('rethrows cancellation instead of reporting it as health', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ollama } = provider(ok);
    await expect(ollama.checkHealth({ signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});

describe('OllamaProvider.checkModel', () => {
  it('returns model info when installed', async () => {
    const { ollama } = provider(ok);
    expect(await ollama.checkModel()).toEqual({
      available: true,
      model: {
        name: 'qwen3:8b',
        capabilities: ['completion', 'tools', 'thinking'],
        contextLength: 40960,
        parameterSize: '8.2B',
        quantization: 'Q4_K_M',
      },
    });
  });

  it('matches implicit :latest and reports missing models', async () => {
    const { ollama } = provider(ok);
    expect(await ollama.checkModel('gemma3')).toMatchObject({
      available: true,
      model: { name: 'gemma3:latest', contextLength: null },
    });
    expect(await ollama.checkModel('llama3:70b')).toEqual({
      available: false,
      requested: 'llama3:70b',
      installedModels: ['qwen3:8b', 'gemma3:latest'],
    });
  });
});

describe('OllamaProvider.generate', () => {
  it('sends a validated chat request and maps the result', async () => {
    const { ollama, calls } = provider({
      '/api/chat': () => jsonResponse(chatChunk('Hello', true)),
    });
    const result = await ollama.generate({
      messages: [{ role: 'user', content: 'Hi' }],
      options: { temperature: 0, maxTokens: 16, seed: 7 },
    });

    expect(result).toEqual({
      model: 'qwen3:8b',
      content: 'Hello',
      finishReason: 'stop',
      usage: { promptTokens: 18, completionTokens: 8, totalDurationMs: 2000, loadDurationMs: 500 },
    });
    expect(calls[0]).toEqual({
      path: '/api/chat',
      method: 'POST',
      body: {
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        think: false,
        options: { num_ctx: 4096, temperature: 0, num_predict: 16, seed: 7 },
      },
    });
  });

  it('rejects invalid requests before calling the server', async () => {
    const { ollama, calls } = provider({});
    await expect(ollama.generate({ messages: [] })).rejects.toMatchObject({
      code: 'invalid-request',
    });
    await expect(
      ollama.generate({
        messages: [{ role: 'user', content: 'x' }],
        options: { temperature: 5 },
      }),
    ).rejects.toMatchObject({
      code: 'invalid-request',
      message: expect.stringContaining('temperature'),
    });
    await expect(
      ollama.generate({ messages: [{ role: 'user', content: 'x' }], apiKey: 'sk-...' } as never),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(calls).toHaveLength(0);
  });

  it('maps 404 to model-not-found', async () => {
    const { ollama } = provider({
      '/api/chat': () => jsonResponse({ error: "model 'nope:1b' not found" }, 404),
    });
    const error = await ollama
      .generate({ model: 'nope:1b', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ code: 'model-not-found', status: 404 });
  });

  it('maps "does not support" to unsupported and other 400s to invalid-request', async () => {
    const unsupported = provider({
      '/api/chat': () => jsonResponse({ error: '"gemma3:latest" does not support thinking' }, 400),
    });
    await expect(
      unsupported.ollama.generate({ messages: [{ role: 'user', content: 'x' }], think: true }),
    ).rejects.toMatchObject({ code: 'unsupported', status: 400 });

    const bad = provider({
      '/api/chat': () => jsonResponse({ error: 'json: cannot unmarshal' }, 400),
    });
    await expect(
      bad.ollama.generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
  });

  it('rejects invalid and incomplete responses', async () => {
    const wrongShape = provider({ '/api/chat': () => jsonResponse({ message: 'hi' }) });
    await expect(
      wrongShape.ollama.generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    const notDone = provider({ '/api/chat': () => jsonResponse(chatChunk('partial', false)) });
    await expect(
      notDone.ollama.generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('returns thinking only when requested', async () => {
    const withThinking = chatChunk('Answer', true, {
      message: { role: 'assistant', content: 'Answer', thinking: 'Reasoning' },
    });
    const { ollama, calls } = provider({ '/api/chat': () => jsonResponse(withThinking) });
    const result = await ollama.generate({
      messages: [{ role: 'user', content: 'x' }],
      think: true,
    });
    expect(result.thinking).toBe('Reasoning');
    expect(calls[0]?.body).toMatchObject({ think: true });
  });

  it('sends JSON formats', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const { ollama, calls } = provider({
      ...ok,
      '/api/chat': () => jsonResponse(chatChunk('{"ok":true}', true)),
    });
    await ollama.generate({
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: { type: 'json_schema', schema },
    });
    await ollama.generate({
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: { type: 'json' },
    });
    const chats = calls.filter((c) => c.path === '/api/chat');
    expect(chats[0]?.body).toMatchObject({ format: schema });
    expect(chats[1]?.body).toMatchObject({ format: 'json' });
  });

  it('refuses JSON schema output on servers that cannot constrain it', async () => {
    const { ollama, calls } = provider({
      '/api/version': () => jsonResponse({ version: '0.4.7' }),
    });
    await expect(
      ollama.generate({
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: { type: 'json_schema', schema: {} },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls.some((c) => c.path === '/api/chat')).toBe(false);
  });

  it('reports a pre-cancelled request without calling the server', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ollama, calls } = provider({});
    await expect(
      ollama.generate(
        { messages: [{ role: 'user', content: 'x' }] },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toHaveLength(0);
  });
});

describe('OllamaProvider.generateStream', () => {
  it('yields deltas then one done chunk with the full content', async () => {
    const { ollama, calls } = provider({
      '/api/chat': () =>
        ndjsonResponse([chatChunk('Hel'), chatChunk('lo'), chatChunk(''), chatChunk('', true)]),
    });
    const chunks = await drain(
      ollama.generateStream({ messages: [{ role: 'user', content: 'x' }] }),
    );
    expect(chunks).toEqual([
      { type: 'delta', content: 'Hel' },
      { type: 'delta', content: 'lo' },
      {
        type: 'done',
        result: expect.objectContaining({ content: 'Hello', finishReason: 'stop' }),
      },
    ]);
    expect(calls[0]?.body).toMatchObject({ stream: true });
  });

  it('surfaces in-stream server errors', async () => {
    const { ollama } = provider({
      '/api/chat': () => ndjsonResponse([chatChunk('a'), { error: 'CUDA out of memory' }]),
    });
    await expect(
      drain(ollama.generateStream({ messages: [{ role: 'user', content: 'x' }] })),
    ).rejects.toMatchObject({ code: 'http-error', message: expect.stringContaining('CUDA') });
  });

  it('rejects streams that end without a done chunk', async () => {
    const { ollama } = provider({ '/api/chat': () => ndjsonResponse([chatChunk('a')]) });
    await expect(
      drain(ollama.generateStream({ messages: [{ role: 'user', content: 'x' }] })),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('rejects malformed stream lines', async () => {
    const { ollama } = provider({ '/api/chat': () => ndjsonResponse([chatChunk('a'), 'garbage']) });
    await expect(
      drain(ollama.generateStream({ messages: [{ role: 'user', content: 'x' }] })),
    ).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('maps a missing model', async () => {
    const { ollama } = provider({
      '/api/chat': () => jsonResponse({ error: "model 'x' not found" }, 404),
    });
    await expect(
      drain(ollama.generateStream({ model: 'x', messages: [{ role: 'user', content: 'x' }] })),
    ).rejects.toMatchObject({ code: 'model-not-found' });
  });
});

describe('helpers', () => {
  it('matchesModel handles implicit :latest', () => {
    expect(matchesModel('qwen3:8b', 'qwen3:8b')).toBe(true);
    expect(matchesModel('gemma3:latest', 'gemma3')).toBe(true);
    expect(matchesModel('qwen3:4b', 'qwen3:8b')).toBe(false);
    expect(matchesModel('qwen3:4b', 'qwen3')).toBe(false);
  });

  it.each([
    ['0.40.14', true],
    ['0.5.0', true],
    ['0.4.9', false],
    ['1.0.0', true],
    ['0.0.0', true],
    ['dev-build', true],
  ])('supportsStructuredOutput(%s) = %s', (version, expected) => {
    expect(supportsStructuredOutput(version)).toBe(expected);
  });

  it('describeRequestError surfaces the network error code', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    });
    expect(describeRequestError(error)).toBe('fetch failed (ECONNREFUSED)');
    expect(describeRequestError(new Error('plain'))).toBe('plain');
  });
});
