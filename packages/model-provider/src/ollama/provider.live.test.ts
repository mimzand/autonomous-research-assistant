/**
 * Live tests against a real local Ollama server. Not part of `pnpm test`.
 * Run with `pnpm test:ollama` (uses OLLAMA_HOST / OLLAMA_MODEL, defaults
 * 127.0.0.1:11434 and qwen3:8b). The first call may take ~30 s to load the model.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadOllamaConfig } from '../config.js';
import { generateObject } from '../structured.js';
import { OllamaProvider } from './provider.js';

const config = loadOllamaConfig(process.env);
const ollama = new OllamaProvider(config);
const deterministic = { temperature: 0, seed: 42 } as const;

describe(`live Ollama at ${config.baseUrl} (${config.model})`, () => {
  beforeAll(async () => {
    const health = await ollama.checkHealth();
    if (health.status !== 'ready') {
      throw new Error(
        `Ollama is not ready (${health.status}): ${
          health.status === 'unreachable' ? health.error : `install ${health.model}`
        }`,
      );
    }
  });

  it('reports health and model availability', async () => {
    const health = await ollama.checkHealth();
    expect(health).toMatchObject({ status: 'ready', model: config.model, structuredOutput: true });
    const availability = await ollama.checkModel();
    expect(availability.available).toBe(true);
  });

  it('generates text', async () => {
    const result = await ollama.generate({
      messages: [{ role: 'user', content: 'Reply with exactly the word READY and nothing else.' }],
      options: { ...deterministic, maxTokens: 10 },
    });
    expect(result.content.toUpperCase()).toContain('READY');
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it('streams text', async () => {
    let deltas = 0;
    let final = '';
    for await (const chunk of ollama.generateStream({
      messages: [{ role: 'user', content: 'Count from 1 to 5, separated by spaces.' }],
      options: { ...deterministic, maxTokens: 30 },
    })) {
      if (chunk.type === 'delta') deltas++;
      else final = chunk.result.content;
    }
    expect(deltas).toBeGreaterThan(1);
    expect(final).toMatch(/1.*2.*3/s);
  });

  it('returns schema-valid structured output', async () => {
    const Plan = z.object({ topic: z.string().min(1), subquestions: z.array(z.string()).min(2) });
    const { object } = await generateObject(
      ollama,
      {
        messages: [
          {
            role: 'user',
            content: 'Plan research on home heat pumps: a topic and 3 subquestions.',
          },
        ],
        options: deterministic,
      },
      Plan,
    );
    expect(object.subquestions.length).toBeGreaterThanOrEqual(2);
  });

  it('cancels a running stream', async () => {
    const controller = new AbortController();
    const run = (async () => {
      for await (const chunk of ollama.generateStream(
        {
          messages: [{ role: 'user', content: 'Write a 500-word essay about rivers.' }],
          options: { maxTokens: 800 },
        },
        { signal: controller.signal },
      )) {
        if (chunk.type === 'delta') controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports a missing model', async () => {
    await expect(
      ollama.generate({
        model: 'definitely-not-installed:1b',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'model-not-found' });
    await expect(ollama.checkModel('definitely-not-installed:1b')).resolves.toMatchObject({
      available: false,
    });
  });
});
