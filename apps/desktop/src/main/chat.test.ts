import { type AgentRuntime } from '@rka/agent-runtime';
import { ModelProviderError, type GenerateChunk } from '@rka/model-provider';
import { type ChatEvent } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChatController, toChatError, type ChatEventSink } from './chat.js';

const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

const done: GenerateChunk = {
  type: 'done',
  result: {
    model: 'qwen3:8b',
    content: 'Hello',
    finishReason: 'stop',
    usage: { promptTokens: 5, completionTokens: 2, totalDurationMs: 120, loadDurationMs: 0 },
  },
};

type StreamFn = AgentRuntime['streamChat'];

function setup(
  streamChat: StreamFn,
  onUsage?: ConstructorParameters<typeof ChatController>[0]['onUsage'],
) {
  const ids = [...IDS];
  const events: ChatEvent[] = [];
  let destroyed = false;
  const sink: ChatEventSink = {
    id: 1,
    isDestroyed: () => destroyed,
    send: (event) => events.push(event),
  };
  const calls: Parameters<StreamFn>[] = [];
  const controller = new ChatController({
    runtime: {
      model: 'qwen3:8b',
      streamChat: (...args) => {
        calls.push(args);
        return streamChat(...args);
      },
    },
    newId: () => ids.shift() ?? 'unexpected',
    ...(onUsage && { onUsage }),
  });
  return { controller, sink, events, calls, destroy: () => (destroyed = true) };
}

/** A stream that yields deltas until aborted, like a long generation. */
const endless: StreamFn = async function* (_turns, options) {
  for (let i = 0; ; i++) {
    if (options?.signal?.aborted)
      throw new ModelProviderError('cancelled', 'Request was cancelled.');
    yield { type: 'delta', content: `t${i} ` };
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const user = (content: string) => ({ role: 'user' as const, content });

describe('ChatController', () => {
  it('streams deltas then done to the sink', async () => {
    const { controller, sink, events } = setup(async function* () {
      yield { type: 'delta', content: 'Hel' };
      yield { type: 'delta', content: '' }; // Empty deltas are not forwarded.
      yield { type: 'delta', content: 'lo' };
      yield done;
    });

    expect(controller.start(sink, { messages: [user('Hi')] })).toEqual({
      status: 'started',
      streamId: IDS[0],
      model: 'qwen3:8b',
    });
    await controller.whenIdle();

    expect(events).toEqual([
      { type: 'delta', streamId: IDS[0], content: 'Hel' },
      { type: 'delta', streamId: IDS[0], content: 'lo' },
      {
        type: 'done',
        streamId: IDS[0],
        model: 'qwen3:8b',
        finishReason: 'stop',
        completionTokens: 2,
        totalDurationMs: 120,
      },
    ]);
    expect(controller.activeStreamId).toBeUndefined();
  });

  it('passes the whole conversation to the runtime', async () => {
    const { controller, sink, calls } = setup(async function* () {
      yield done;
    });
    const messages = [user('Hi'), { role: 'assistant' as const, content: 'Hello' }, user('More')];
    controller.start(sink, { messages });
    await controller.whenIdle();
    expect(calls[0]?.[0]).toEqual(messages);
  });

  it('allows one generation at a time, then the next', async () => {
    const { controller, sink, events } = setup(endless);
    controller.start(sink, { messages: [user('first')] });
    expect(controller.start(sink, { messages: [user('second')] })).toMatchObject({
      status: 'rejected',
      code: 'busy',
    });

    controller.stop({ streamId: IDS[0] });
    await controller.whenIdle();
    expect(events.at(-1)).toEqual({ type: 'cancelled', streamId: IDS[0] });

    expect(controller.start(sink, { messages: [user('second')] })).toMatchObject({
      status: 'started',
      streamId: IDS[1],
    });
    controller.stop({ streamId: IDS[1] });
    await controller.whenIdle();
  });

  it('cancels via stop and stops emitting deltas', async () => {
    const { controller, sink, events } = setup(endless);
    controller.start(sink, { messages: [user('go')] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.stop({ streamId: IDS[0] });
    await controller.whenIdle();

    const deltasBefore = events.filter((e) => e.type === 'delta').length;
    expect(deltasBefore).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: 'cancelled', streamId: IDS[0] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((e) => e.type === 'delta').length).toBe(deltasBefore);
  });

  it('ignores stop for unknown streams and rejects malformed stop requests', () => {
    const { controller } = setup(endless);
    expect(() => controller.stop({ streamId: IDS[1] })).not.toThrow();
    expect(() => controller.stop({ streamId: 'x' })).toThrow();
    expect(() => controller.stop(undefined)).toThrow();
  });

  it('aborts when the window goes away', async () => {
    const { controller, sink, events, destroy } = setup(endless);
    controller.start(sink, { messages: [user('go')] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    destroy();
    await controller.whenIdle();
    expect(controller.activeStreamId).toBeUndefined();
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.length).toBe(count);
  });

  it('stopForSink only cancels that window', async () => {
    const { controller, sink, events } = setup(endless);
    controller.start(sink, { messages: [user('go')] });
    controller.stopForSink(99);
    expect(controller.activeStreamId).toBe(IDS[0]);
    controller.stopForSink(1);
    await controller.whenIdle();
    expect(events.at(-1)?.type).toBe('cancelled');
  });

  it.each([
    ['unavailable', 'unavailable'],
    ['model-not-found', 'model-not-found'],
    ['timeout', 'timeout'],
    ['invalid-response', 'invalid-response'],
    ['http-error', 'generation-failed'],
  ] as const)('reports provider %s as %s', async (providerCode, chatCode) => {
    const { controller, sink, events } = setup(async function* () {
      yield { type: 'delta', content: 'partial' };
      throw new ModelProviderError(providerCode, `boom: ${providerCode}`);
    });
    controller.start(sink, { messages: [user('go')] });
    await controller.whenIdle();
    expect(events.at(-1)).toEqual({
      type: 'error',
      streamId: IDS[0],
      code: chatCode,
      message: `boom: ${providerCode}`,
    });
  });

  it('rejects invalid requests with a reason', () => {
    const { controller, sink } = setup(endless);
    expect(controller.start(sink, { messages: [{ role: 'assistant', content: 'x' }] })).toEqual({
      status: 'rejected',
      code: 'invalid-request',
      message: 'The last message must be a non-empty user message.',
    });
  });
});

describe('ChatController usage reporting', () => {
  it('reports model and token usage once per completed reply', async () => {
    const usages: unknown[] = [];
    const { controller, sink } = setup(
      async function* () {
        yield { type: 'delta', content: 'Hi' };
        yield done;
      },
      (usage) => usages.push(usage),
    );
    controller.start(sink, { messages: [user('Hi')] });
    await controller.whenIdle();
    expect(usages).toEqual([
      {
        model: 'qwen3:8b',
        promptTokens: 5,
        completionTokens: 2,
        totalDurationMs: 120,
        loadDurationMs: 0,
      },
    ]);
  });

  it('keeps the reply working if recording usage fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { controller, sink, events } = setup(
      async function* () {
        yield done;
      },
      () => {
        throw new Error('disk full');
      },
    );
    controller.start(sink, { messages: [user('Hi')] });
    await controller.whenIdle();
    expect(events.at(-1)?.type).toBe('done');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not report usage for cancelled replies', async () => {
    const usages: unknown[] = [];
    const { controller, sink } = setup(endless, (usage) => usages.push(usage));
    controller.start(sink, { messages: [user('go')] });
    controller.stop({ streamId: IDS[0] });
    await controller.whenIdle();
    expect(usages).toEqual([]);
  });
});

describe('toChatError', () => {
  it('maps unknown errors to generation-failed', () => {
    expect(toChatError(new Error('weird'))).toEqual({
      code: 'generation-failed',
      message: 'weird',
    });
    expect(toChatError('text')).toEqual({ code: 'generation-failed', message: 'text' });
  });
});
