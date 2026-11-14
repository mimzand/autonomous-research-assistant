/*
 * AdkChatEngine edge cases with a scripted provider (the HTTP paths are
 * covered at the Electron main-process boundary in apps/desktop).
 */
import {
  type GenerateChunk,
  type GenerateRequest,
  type GenerateResult,
  isModelProviderError,
  ModelProviderError,
  type OllamaProvider,
} from '@rka/model-provider';
import { type ChatTurn } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { createAdkChatEngine } from './adk-chat.js';

const result = (content: string, extra: Partial<GenerateResult> = {}): GenerateResult => ({
  model: 'm:1b',
  content,
  finishReason: 'stop',
  usage: { promptTokens: 3, completionTokens: 2, totalDurationMs: 10, loadDurationMs: 1 },
  ...extra,
});

/** A provider whose stream is scripted; records the requests it receives. */
function scripted(
  script: (request: GenerateRequest, signal?: AbortSignal) => AsyncGenerator<GenerateChunk>,
) {
  const requests: GenerateRequest[] = [];
  const provider = {
    defaultModel: 'm:1b',
    currentConfig: { baseUrl: 'http://127.0.0.1:1' },
    snapshot: () => provider,
    generateStream: (request: GenerateRequest, options: { signal?: AbortSignal } = {}) => {
      requests.push(request);
      return script(request, options.signal);
    },
    generate: vi.fn(),
  };
  return { provider: provider as unknown as OllamaProvider, requests };
}

async function collect(
  provider: OllamaProvider,
  turns: ChatTurn[],
  signal?: AbortSignal,
): Promise<{ chunks: GenerateChunk[]; error?: unknown }> {
  const chunks: GenerateChunk[] = [];
  try {
    for await (const c of createAdkChatEngine({ provider }).streamChat(
      turns,
      signal ? { signal } : {},
    )) {
      // Without webSearch the engine yields provider chunks only.
      chunks.push(c as GenerateChunk);
    }
    return { chunks };
  } catch (error) {
    return { chunks, error };
  }
}

const hi: ChatTurn[] = [{ role: 'user', content: 'Hi' }];

describe('AdkChatEngine', () => {
  it('a final-only response (no partial text) is delivered once, as one delta', async () => {
    const { provider } = scripted(async function* () {
      yield { type: 'done', result: result('Whole answer.') };
    });
    const { chunks, error } = await collect(provider, hi);
    expect(error).toBeUndefined();
    expect(chunks).toEqual([
      { type: 'delta', content: 'Whole answer.' },
      { type: 'done', result: result('Whole answer.') },
    ]);
  });

  it('streams partial text and never repeats it from the final response', async () => {
    const { provider } = scripted(async function* () {
      yield { type: 'delta', content: 'Hel' };
      yield { type: 'delta', content: '' };
      yield { type: 'delta', content: 'lo 世界' };
      yield { type: 'done', result: result('Hello 世界') };
    });
    const { chunks } = await collect(provider, hi);
    expect(chunks.filter((c) => c.type === 'delta')).toEqual([
      { type: 'delta', content: 'Hel' },
      { type: 'delta', content: 'lo 世界' },
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'done', result: result('Hello 世界') });
  });

  it('never shows the model’s thinking', async () => {
    const { provider } = scripted(async function* () {
      yield { type: 'delta', content: '', thinking: 'secret reasoning' };
      yield { type: 'delta', content: 'Answer' };
      yield { type: 'done', result: result('Answer', { thinking: 'secret reasoning' }) };
    });
    const { chunks } = await collect(provider, hi);
    expect(JSON.stringify(chunks.filter((c) => c.type === 'delta'))).not.toContain('secret');
  });

  it('refuses to append when the final text disagrees with what was streamed', async () => {
    const { provider } = scripted(async function* () {
      yield { type: 'delta', content: 'abc' };
      yield { type: 'done', result: result('xyz') };
    });
    const { chunks, error } = await collect(provider, hi);
    expect(chunks).toEqual([{ type: 'delta', content: 'abc' }]);
    expect(error).toMatchObject({ code: 'invalid-response' });
  });

  it('an empty reply with usage completes with empty text and its usage', async () => {
    const { provider } = scripted(async function* () {
      yield { type: 'done', result: result('') };
    });
    const { chunks, error } = await collect(provider, hi);
    expect(error).toBeUndefined();
    expect(chunks).toEqual([{ type: 'done', result: result('') }]);
  });

  it('maps provider errors back to the same ModelProviderError code and message', async () => {
    for (const code of [
      'unavailable',
      'model-not-found',
      'timeout',
      'invalid-response',
      'http-error',
    ] as const) {
      const { provider } = scripted(async function* () {
        yield* [];
        throw new ModelProviderError(code, `boom ${code}`);
      });
      const { error } = await collect(provider, hi);
      expect(isModelProviderError(error) && [error.code, error.message]).toEqual([
        code,
        `boom ${code}`,
      ]);
    }
  });

  it('an unexpected adapter error is reported without its internal message', async () => {
    const { provider } = scripted(async function* () {
      yield* [];
      throw new TypeError('internal detail at /home/user/secret.ts:1');
    });
    const { error } = await collect(provider, hi);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('The ADK chat engine failed (OLLAMA_ADAPTER_ERROR).');
  });

  it('a request cancelled before it starts never reaches the provider', async () => {
    const { provider, requests } = scripted(async function* () {
      yield { type: 'done', result: result('x') };
    });
    const controller = new AbortController();
    controller.abort();
    const { chunks, error } = await collect(provider, hi, controller.signal);
    expect(chunks).toEqual([]);
    expect(error).toMatchObject({ code: 'cancelled' });
    expect(requests).toEqual([]);
  });

  it('cancellation after partial text is reported as cancelled, never as done', async () => {
    const controller = new AbortController();
    const { provider } = scripted(async function* (_r, signal) {
      yield { type: 'delta', content: 'part' };
      controller.abort();
      await Promise.resolve();
      if (signal?.aborted) throw new ModelProviderError('cancelled', 'The request was cancelled.');
      yield { type: 'done', result: result('part and more') };
    });
    const { chunks, error } = await collect(provider, hi, controller.signal);
    expect(chunks).toEqual([{ type: 'delta', content: 'part' }]);
    expect(error).toMatchObject({ code: 'cancelled' });
  });

  it('sends history in order, with the current message once, no system prompt and no tools', async () => {
    const { provider, requests } = scripted(async function* () {
      yield { type: 'done', result: result('ok') };
    });
    const turns: ChatTurn[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ];
    await collect(provider, turns);
    expect(requests).toEqual([{ model: 'm:1b', messages: turns, think: false }]);
  });

  it('two requests share nothing', async () => {
    const { provider, requests } = scripted(async function* () {
      yield { type: 'done', result: result('ok') };
    });
    await collect(provider, [{ role: 'user', content: 'first' }]);
    await collect(provider, [{ role: 'user', content: 'second' }]);
    expect(requests.map((r) => r.messages)).toEqual([
      [{ role: 'user', content: 'first' }],
      [{ role: 'user', content: 'second' }],
    ]);
  });
});
