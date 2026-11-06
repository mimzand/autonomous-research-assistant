/**
 * Live checks of the runtime settings features against a real Ollama server.
 * Not part of `pnpm test`; run with `pnpm test:ollama`.
 *
 * Uses OLLAMA_HOST / OLLAMA_MODEL (defaults 127.0.0.1:11434 and qwen3:8b).
 * Set OLLAMA_REMOTE_HOST (e.g. http://192.168.1.100:11434 or an https URL) to
 * also check switching to a second server at run time, and OLLAMA_TOKEN when
 * that server sits behind an authenticating HTTPS reverse proxy.
 *
 * Model-agnostic: no assertions on the wording of answers, so any installed
 * model works.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOllamaConfig, type OllamaConfig } from '../config.js';
import { matchesModel, OllamaProvider } from './provider.js';

const base = loadOllamaConfig(process.env);
const remote = process.env['OLLAMA_REMOTE_HOST']?.trim();
const token = process.env['OLLAMA_TOKEN']?.trim();
const provider = new OllamaProvider(base, { getAuthToken: () => token || undefined });

describe(`runtime settings against live Ollama at ${base.baseUrl} (${base.model})`, () => {
  beforeAll(async () => {
    const health = await provider.checkHealth();
    if (health.status !== 'ready') {
      throw new Error(`Ollama is not ready (${health.status}) at ${base.baseUrl}.`);
    }
  });

  it('tests the connection: version and response time', async () => {
    const info = await provider.testConnection();
    expect(info.version).toMatch(/^\d+\.\d+/);
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('discovers installed models with their details', async () => {
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    const active = models.find((m) => matchesModel(m.name, base.model));
    expect(active).toBeDefined();
    expect(active?.format).toBe('gguf');
    expect(active?.family).toBeTruthy();
    expect(active?.parameterSize).toBeTruthy();
    expect(active?.sizeBytes).toBeGreaterThan(0);
    expect(active?.modifiedAt).toBeTruthy();
  });

  it('shows model details and capabilities', async () => {
    const details = await provider.showModel(base.model);
    expect(details.capabilities).toContain('completion');
    expect(details.architecture).toBeTruthy();
    expect(details.contextLength).toBeGreaterThan(0);
  });

  it('applies generation options to subsequent requests without a restart', async () => {
    provider.reconfigure({ ...base, generation: { numPredict: 4, temperature: 0, topK: 1 } });
    const limited = await provider.generate({
      messages: [{ role: 'user', content: 'Tell a long story.' }],
    });
    expect(limited.usage.completionTokens).toBeLessThanOrEqual(4);
    expect(limited.finishReason).toBe('length');

    provider.reconfigure({ ...base, generation: { numPredict: 12 } });
    const longer = await provider.generate({
      messages: [{ role: 'user', content: 'Tell a long story.' }],
    });
    expect(longer.usage.completionTokens).toBeGreaterThan(4);
  });

  it('streams and cancels with the runtime configuration', async () => {
    provider.reconfigure({ ...base, generation: { numPredict: 200 } });
    const controller = new AbortController();
    const run = (async () => {
      for await (const chunk of provider.generateStream(
        { messages: [{ role: 'user', content: 'Write about rivers.' }] },
        { signal: controller.signal },
      )) {
        if (chunk.type === 'delta') controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a snapshot keeps its configuration after the live provider changes', async () => {
    provider.reconfigure({ ...base, generation: { numPredict: 3 } });
    const snapshot = provider.snapshot();
    provider.reconfigure({ ...base, baseUrl: 'http://127.0.0.1:9', generation: {} });
    const result = await snapshot.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.usage.completionTokens).toBeLessThanOrEqual(3);
    await expect(provider.testConnection()).rejects.toMatchObject({ code: 'unavailable' });
    provider.reconfigure(base);
  });

  it.runIf(Boolean(remote))('switches to a second (remote) server at run time', async () => {
    const config: OllamaConfig = { ...base, baseUrl: remote ?? '' };
    provider.reconfigure(config);
    const info = await provider.testConnection();
    expect(info.version).toMatch(/^\d+\.\d+/);
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    const reply = await provider.generate({
      model: models[0]?.name,
      messages: [{ role: 'user', content: 'hi' }],
      options: { maxTokens: 3 },
    });
    expect(reply.usage.completionTokens).toBeGreaterThan(0);
    provider.reconfigure(base);
  });
});
