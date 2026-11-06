import { createAgentRuntime } from '@rka/agent-runtime';
import { OllamaProvider, type FetchLike } from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import { createReconfigurableWebServices, createToolRegistry, createWebTools } from '@rka/tools';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createRuntimeConfig } from './runtime-config.js';
import {
  createOllamaSettingsService,
  ollamaApplier,
  taskModelsFor,
  testSearxng,
  toOllamaConfig,
  toWebConfig,
  webApplier,
} from './services.js';

/*
 * Settings ↔ running services, with mocked Ollama servers: connection tests,
 * model discovery and selection, runtime URL and option changes.
 */

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`).reverse(),
  decryptString: (data: Buffer) => Buffer.from(data).reverse().toString().slice(4),
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TAGS = (names: string[]) => ({
  models: names.map((name) => ({
    name,
    size: 1000,
    modified_at: '2026-10-01T10:00:00Z',
    details: {
      family: name.split(':')[0],
      format: 'gguf',
      parameter_size: '1B',
      quantization_level: 'Q4_K_M',
    },
  })),
});

interface Call {
  url: string;
  auth: string | null;
  body: Record<string, unknown> | undefined;
}

/** Fake Ollama servers keyed by base URL. */
function fakeOllama(servers: Record<string, { version?: string; models: string[] }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url: input, auth: headers['authorization'] ?? null, body });
    const entry = Object.entries(servers).find(([b]) => input.startsWith(b));
    if (!entry) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const [base, server] = entry;
    const path = input.slice(base.length);
    if (path === '/api/version') return json({ version: server.version ?? '0.12.6' });
    if (path === '/api/tags') return json(TAGS(server.models));
    if (path === '/api/show') {
      const name = String(body?.['model']);
      return server.models.includes(name)
        ? json({
            capabilities: ['completion'],
            details: { family: 'qwen3' },
            parameters: 'temperature 0.6',
          })
        : json({ error: `model '${name}' not found` }, 404);
    }
    if (path === '/api/chat') {
      return json({
        model: body?.['model'],
        message: { role: 'assistant', content: `Hello from ${base}` },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 5,
        eval_count: 3,
      });
    }
    return json({ error: 'not found' }, 404);
  };
  return { fetch, calls };
}

function setup(servers: Parameters<typeof fakeOllama>[0], env: NodeJS.ProcessEnv = {}) {
  const storage = openStorage({ path: ':memory:', cipher });
  const config = createRuntimeConfig({
    storage,
    env,
    encryptionAvailable: () => true,
    warn: () => undefined,
  });
  const { fetch, calls } = fakeOllama(servers);
  let connected = true;
  const provider = new OllamaProvider(toOllamaConfig(config.getSettings()), {
    fetch,
    getAuthToken: () => config.getSecret('ollama.authToken'),
    isConnected: () => connected,
  });
  config.register(ollamaApplier(provider));
  const ollama = createOllamaSettingsService({
    config,
    provider,
    connection: { get: () => connected, set: (c) => void (connected = c) },
    now: () => new Date('2026-11-06T10:00:00.000Z'),
  });
  return { storage, config, provider, ollama, calls };
}

const LOCAL = 'http://127.0.0.1:11434';
const LAN = 'http://192.168.1.100:11434';
const REMOTE = 'https://ollama.example.com';

describe('Ollama connection', () => {
  it('tests the saved server: version and response time', async () => {
    const { ollama } = setup({ [LOCAL]: { version: '0.12.6', models: ['qwen3:8b'] } });
    expect(await ollama.testConnection()).toMatchObject({
      ok: true,
      url: LOCAL,
      version: '0.12.6',
      latencyMs: expect.any(Number),
      warnings: [],
    });
  });

  it('tests a candidate URL without saving it, with a security warning for plain HTTP', async () => {
    const { ollama, config } = setup({ [LAN]: { models: ['llama3.2:3b'] } });
    expect(await ollama.testConnection('192.168.1.100')).toMatchObject({
      ok: true,
      url: LAN,
      warnings: [expect.stringMatching(/Plain HTTP to another computer/)],
    });
    expect(config.getSetting('ollama.baseUrl')).toBe(LOCAL);
  });

  it('explains failures with a hint', async () => {
    const { ollama } = setup({});
    expect(await ollama.testConnection(LAN)).toMatchObject({
      ok: false,
      code: 'unavailable',
      error: expect.stringMatching(/Cannot reach Ollama at http:\/\/192\.168\.1\.100:11434/),
      hint: expect.stringMatching(/OLLAMA_HOST=0\.0\.0\.0/),
    });
    expect(await ollama.testConnection('ftp://x')).toMatchObject({
      ok: false,
      code: 'invalid-url',
    });
    expect(await ollama.testConnection('https://u:p@x.example')).toMatchObject({
      ok: false,
      code: 'invalid-url',
    });
  });

  it('respects "Require HTTPS for remote servers" when testing', async () => {
    const { ollama, config } = setup({ [LAN]: { models: [] } });
    config.updateSettings({ 'security.requireHttpsForRemote': true });
    expect(await ollama.testConnection(LAN)).toMatchObject({ ok: false, code: 'policy' });
  });

  it('changing the URL at run time moves subsequent requests to the new server', async () => {
    const { config, provider, ollama, calls } = setup({
      [LOCAL]: { models: ['qwen3:8b'] },
      [REMOTE]: { models: ['qwen3:8b', 'llama3.2:3b'] },
    });
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(config.updateSettings({ 'ollama.baseUrl': REMOTE }).status).toBe('saved');
    const reply = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(reply.content).toBe(`Hello from ${REMOTE}`);
    expect(calls.filter((c) => c.url.endsWith('/api/chat')).map((c) => c.url)).toEqual([
      `${LOCAL}/api/chat`,
      `${REMOTE}/api/chat`,
    ]);
    expect(ollama.connectionState()).toMatchObject({ url: REMOTE, connected: true, warnings: [] });
  });

  it('sends the encrypted access token only over HTTPS and never returns it', async () => {
    const { config, ollama, calls } = setup({ [REMOTE]: { models: [] }, [LAN]: { models: [] } });
    config.setSecret('ollama.authToken', 'proxy-token-1');
    config.updateSettings({ 'ollama.baseUrl': REMOTE });
    await ollama.testConnection();
    expect(calls.at(-1)?.auth).toBe('Bearer proxy-token-1');
    const lan = await ollama.testConnection(LAN);
    expect(calls.at(-1)?.auth).toBeNull();
    expect(lan.warnings.join(' ')).toMatch(/access token is not sent over plain HTTP/);
    expect(ollama.connectionState()).toMatchObject({ tokenConfigured: true, tokenSent: true });
    expect(JSON.stringify(ollama.connectionState())).not.toContain('proxy-token-1');
  });

  it('disconnect blocks requests until connect', async () => {
    const { ollama, provider } = setup({ [LOCAL]: { models: ['qwen3:8b'] } });
    expect(ollama.disconnect()).toMatchObject({ connected: false });
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect((await ollama.listModels()).status).toBe('error');
    expect(ollama.connect()).toMatchObject({ connected: true });
    expect((await ollama.listModels()).status).toBe('ok');
  });
});

describe('model discovery and selection', () => {
  it('lists models from the configured server and detects a missing active model', async () => {
    const { ollama, config } = setup({
      [LOCAL]: { models: ['qwen3:8b', 'llama3.2:3b'] },
      [LAN]: { models: ['mistral:7b'] },
    });
    expect(await ollama.listModels()).toMatchObject({
      status: 'ok',
      url: LOCAL,
      activeModel: 'qwen3:8b',
      activeModelAvailable: true,
      models: [
        {
          name: 'llama3.2:3b',
          family: 'llama3.2',
          parameterSize: '1B',
          quantization: 'Q4_K_M',
          format: 'gguf',
          sizeBytes: 1000,
        },
        { name: 'qwen3:8b' },
      ],
    });
    // Another server without the selected model.
    config.updateSettings({ 'ollama.baseUrl': LAN });
    expect(await ollama.listModels()).toMatchObject({
      status: 'ok',
      models: [{ name: 'mistral:7b' }],
      activeModelAvailable: false,
    });
  });

  it('selecting a model changes subsequent requests and chat model', async () => {
    const { config, provider, calls } = setup({ [LOCAL]: { models: ['qwen3:8b', 'llama3.2:3b'] } });
    const runtime = createAgentRuntime({
      modelProvider: provider,
      tools: createToolRegistry([]),
      storage: openStorage({ path: ':memory:' }),
    });
    expect(runtime.model).toBe('qwen3:8b');
    config.updateSettings({ 'model.name': 'llama3.2:3b' });
    expect(runtime.model).toBe('llama3.2:3b');
    await provider.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(calls.at(-1)?.body).toMatchObject({ model: 'llama3.2:3b' });
  });

  it('shows model details, tests a model, and reports unknown models', async () => {
    const { ollama } = setup({ [LOCAL]: { models: ['qwen3:8b'] } });
    expect(await ollama.showModel('qwen3:8b')).toMatchObject({
      status: 'ok',
      capabilities: ['completion'],
      parameters: 'temperature 0.6',
    });
    expect(await ollama.showModel('nope:1b')).toMatchObject({
      status: 'error',
      code: 'model-not-found',
    });
    expect(await ollama.testModel('qwen3:8b', 'Say hello')).toMatchObject({
      status: 'ok',
      model: 'qwen3:8b',
      reply: `Hello from ${LOCAL}`,
      completionTokens: 3,
      options: { num_ctx: 4096, num_predict: 256 },
    });
  });
});

describe('generation parameters', () => {
  it('apply to subsequent requests and show in the effective configuration', async () => {
    const { config, provider, ollama, calls } = setup({ [LOCAL]: { models: ['qwen3:8b'] } });
    config.updateSettings({
      'model.temperature': 0.7,
      'model.topP': 0.9,
      'model.topK': 40,
      'model.numCtx': 8192,
      'model.numPredict': 512,
      'model.repeatPenalty': 1.1,
      'model.generateTimeoutMs': 60_000,
    });
    await provider.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(calls.at(-1)?.body?.['options']).toEqual({
      num_ctx: 8192,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      num_predict: 512,
      repeat_penalty: 1.1,
    });
    await ollama.showModel('qwen3:8b');
    expect(ollama.effectiveConfig()).toMatchObject({
      model: 'qwen3:8b',
      options: {
        num_ctx: 8192,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        num_predict: 512,
        repeat_penalty: 1.1,
      },
      generateTimeoutMs: 60_000,
      researchOverrides: { temperature: 0 },
      modelDefaults: 'temperature 0.6',
    });
    // Back to the model's own defaults: nothing is sent.
    config.resetSettings([
      'model.temperature',
      'model.topP',
      'model.topK',
      'model.numPredict',
      'model.repeatPenalty',
    ]);
    expect(ollama.effectiveConfig().options).toEqual({ num_ctx: 8192 });
  });

  it('a task snapshot keeps its options when settings change (task isolation)', async () => {
    const { config, provider, calls } = setup({
      [LOCAL]: { models: ['qwen3:8b'] },
      [REMOTE]: { models: ['x:1b'] },
    });
    config.updateSettings({ 'model.temperature': 0.2 });
    const models = taskModelsFor(provider);
    const captured = models.capture();
    expect(captured).toMatchObject({ provider: 'ollama', name: 'qwen3:8b', url: LOCAL });
    config.updateSettings({
      'ollama.baseUrl': REMOTE,
      'model.name': 'x:1b',
      'model.temperature': 1,
    });
    await models.providerFor(captured).generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(calls.at(-1)).toMatchObject({
      url: `${LOCAL}/api/chat`,
      body: { model: 'qwen3:8b', options: { temperature: 0.2 } },
    });
  });
});

describe('SearXNG', () => {
  function searxng(status = 200) {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [] }));
    });
    return new Promise<{ url: string; close: () => void }>((resolve) =>
      server.listen(0, '127.0.0.1', () =>
        resolve({
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => server.close(),
        }),
      ),
    );
  }

  it('tests a candidate URL, applies a saved one at run time, and explains failures', async () => {
    const ok = await searxng();
    const refused = await searxng(403);
    try {
      const { config } = setup({});
      const web = createReconfigurableWebServices(toWebConfig(config.getSettings()));
      config.register(webApplier(web));
      createToolRegistry(createWebTools({ ...web, store: {} as never }));

      expect(await testSearxng(config, undefined)).toMatchObject({
        ok: false,
        code: 'not-configured',
      });
      expect(await testSearxng(config, ok.url)).toMatchObject({
        ok: true,
        url: ok.url,
        version: null,
      });
      expect(web.isSearchConfigured()).toBe(false); // testing does not save

      expect(config.updateSettings({ 'searxng.url': ok.url }).status).toBe('saved');
      expect(web.isSearchConfigured()).toBe(true);
      expect(web.config().searxngUrl).toBe(ok.url);
      expect(await testSearxng(config, undefined)).toMatchObject({ ok: true });

      expect(await testSearxng(config, refused.url)).toMatchObject({
        ok: false,
        hint: expect.stringMatching(/formats: \[html, json\]/),
      });
      expect(await testSearxng(config, 'http://127.0.0.1:1')).toMatchObject({
        ok: false,
        code: 'network-error',
      });
    } finally {
      ok.close();
      refused.close();
    }
  });
});
