/*
 * AdkResearchModel with a scripted provider: request fidelity, refusals,
 * error mapping. The full workflow over HTTP is tested in apps/desktop
 * (research-engine.integration.test.ts).
 */
import {
  generateObject,
  type GenerateRequest,
  type GenerateResult,
  isModelProviderError,
  ModelProviderError,
  type OllamaProvider,
} from '@rka/model-provider';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AdkResearchError, AdkResearchModel } from './adk-research-model.js';

const result = (content: string, extra: Partial<GenerateResult> = {}): GenerateResult => ({
  model: 'm:1b',
  content,
  finishReason: 'stop',
  usage: { promptTokens: 30, completionTokens: 20, totalDurationMs: 100, loadDurationMs: 2 },
  ...extra,
});

function scripted(answer: (request: GenerateRequest) => Promise<GenerateResult> | GenerateResult) {
  const requests: GenerateRequest[] = [];
  const provider = {
    id: 'ollama',
    defaultModel: 'm:1b',
    currentConfig: { baseUrl: 'http://127.0.0.1:1' },
    snapshot: () => provider,
    checkHealth: vi.fn(() => Promise.resolve({ status: 'ready' })),
    checkModel: vi.fn(),
    generate: vi.fn((request: GenerateRequest) => {
      requests.push(request);
      return Promise.resolve(answer(request));
    }),
    generateStream: vi.fn(),
  };
  return { model: new AdkResearchModel(provider as unknown as OllamaProvider), provider, requests };
}

const Schema = z.object({ title: z.string().min(3), items: z.array(z.string()).min(1) });
const SYSTEM = 'You are a careful research assistant. Answer ONLY with JSON {like this}.';
const prompt = (user: string) => [
  { role: 'system' as const, content: SYSTEM },
  { role: 'user' as const, content: user },
];

describe('AdkResearchModel', () => {
  it('sends the legacy request unchanged: system prompt, messages, options, schema, think', async () => {
    const { model, requests } = scripted(() => result('{"title":"Wärme","items":["a"]}'));
    const request: GenerateRequest = {
      messages: [
        ...prompt('Task: create-plan\nGoal: پمپ حرارتی 🔥 {not a template}'),
        { role: 'user', content: 'Your previous answer was rejected: ...' },
      ],
      options: { temperature: 0, maxTokens: 900 },
      think: false,
      responseFormat: { type: 'json_schema', schema: { type: 'object', properties: {} } },
    };
    const out = await model.generate(request);
    expect(requests).toEqual([{ model: 'm:1b', ...request }]);
    expect(out).toEqual(result('{"title":"Wärme","items":["a"]}'));
  });

  it('works through generateObject: Zod validation stays with the caller', async () => {
    const ok = scripted(() => result('```json\n{"title":"Plan","items":["x"]}\n```'));
    await expect(
      generateObject(ok.model, { messages: prompt('Task: t') }, Schema),
    ).resolves.toMatchObject({
      object: { title: 'Plan', items: ['x'] },
    });
    // Valid JSON that breaks the schema: rejected by generateObject, nothing invented.
    const bad = scripted(() => result('{"title":"Plan"}'));
    await expect(
      generateObject(bad.model, { messages: prompt('Task: t') }, Schema),
    ).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringMatching(/^Model output does not match the schema: items/),
    });
  });

  it('invalid JSON fails with exactly the legacy message (so retry feedback is identical)', async () => {
    const content = 'Sure! {title: "oops" '.padEnd(260, 'x');
    const legacy = await generateObject(
      { generate: () => Promise.resolve(result(content)) } as never,
      { messages: prompt('Task: t') },
      Schema,
    ).catch((e: unknown) => e);
    const { model } = scripted(() => result(content));
    const adk = await generateObject(model, { messages: prompt('Task: t') }, Schema).catch(
      (e: unknown) => e,
    );
    expect(isModelProviderError(adk) && adk.code).toBe('invalid-response');
    expect((adk as Error).message).toBe((legacy as Error).message);
  });

  it('an empty answer is invalid JSON, as with legacy', async () => {
    const { model } = scripted(() => result(''));
    await expect(generateObject(model, { messages: prompt('Task: t') }, Schema)).rejects.toThrow(
      'Model did not return valid JSON (got: "").',
    );
  });

  it('maps provider errors to the same codes and messages', async () => {
    for (const code of [
      'unavailable',
      'model-not-found',
      'timeout',
      'http-error',
      'invalid-response',
    ] as const) {
      const { model } = scripted(() => {
        throw new ModelProviderError(code, `boom ${code}`);
      });
      const error = await model.generate({ messages: prompt('Task: t') }).catch((e: unknown) => e);
      expect(isModelProviderError(error) && [error.code, error.message]).toEqual([
        code,
        `boom ${code}`,
      ]);
    }
  });

  it('an unexpected adapter error is reported without internal details', async () => {
    const { model } = scripted(() => {
      throw new TypeError('secret detail at C:\\Users\\x\\file.ts');
    });
    const error = await model.generate({ messages: prompt('Task: t') }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdkResearchError);
    expect((error as Error).message).toBe('The ADK research engine failed (OLLAMA_ADAPTER_ERROR).');
  });

  it('cancelled before it starts: nothing is sent', async () => {
    const { model, requests } = scripted(() => result('{}'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      model.generate({ messages: prompt('Task: t') }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests).toEqual([]);
  });

  it('aborted during the request: cancelled, never a result', async () => {
    const controller = new AbortController();
    const { model } = scripted(() => {
      controller.abort();
      return result('{"title":"Plan","items":["x"]}');
    });
    await expect(
      model.generate({ messages: prompt('Task: t') }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses what it cannot send faithfully instead of changing it', async () => {
    const { model, requests } = scripted(() => result('{}'));
    const refused: GenerateRequest[] = [
      {
        messages: prompt('x'),
        tools: [{ name: 'calc', description: 'd', parameters: { type: 'object' } }],
      },
      { messages: prompt('x'), options: { repeatPenalty: 1.1 } },
      {
        messages: [
          ...prompt('x'),
          { role: 'system', content: 'again' },
          { role: 'user', content: 'y' },
        ],
      },
      {
        messages: [
          { role: 'system', content: 's' },
          { role: 'assistant', content: 'a' },
        ],
      },
      {
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: '' },
          { role: 'user', content: 'b' },
        ],
      },
      { messages: prompt('x'), model: 'other:7b' },
    ];
    for (const request of refused) {
      await expect(model.generate(request)).rejects.toMatchObject({ code: 'unsupported' });
    }
    expect(requests).toEqual([]);
  });

  it('never streams and delegates health checks to the task provider', async () => {
    const { model, provider } = scripted(() => result('{}'));
    await expect(model.generateStream().next()).rejects.toMatchObject({ code: 'unsupported' });
    await model.checkHealth();
    expect(provider.checkHealth).toHaveBeenCalledTimes(1);
    expect(model.defaultModel).toBe('m:1b');
    expect(model.id).toBe('ollama');
  });
});
