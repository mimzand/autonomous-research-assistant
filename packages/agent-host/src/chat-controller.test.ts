import { type AgentRuntime } from '@rka/agent-runtime';
import { ModelProviderError, type GenerateChunk } from '@rka/model-provider';
import { type ChatEvent } from '@rka/shared';
import { openStorage } from '@rka/storage';
import { describe, expect, it, vi } from 'vitest';
import { ChatController, toChatError, type ChatEventSink } from './chat-controller.js';
import { type ChatEngine } from './chat-engine.js';

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
  const storage = openStorage({ path: ':memory:' });
  const controller = new ChatController({
    conversations: storage.conversations,
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
  return { controller, sink, events, calls, storage, destroy: () => (destroyed = true) };
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

    expect(controller.start(sink, { text: 'Hi' })).toEqual({
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

  it('sends the stored user turn to the runtime (no preface for a short conversation)', async () => {
    const { controller, sink, calls } = setup(async function* () {
      yield done;
    });
    controller.start(sink, { text: '  More  ' });
    await controller.whenIdle();
    expect(calls[0]?.[0]).toEqual([user('More')]);
    expect(calls[0]?.[1]).not.toHaveProperty('preface');
  });

  it('allows one generation at a time, then the next', async () => {
    const { controller, sink, events } = setup(endless);
    controller.start(sink, { text: 'first' });
    expect(controller.start(sink, { text: 'second' })).toMatchObject({
      status: 'rejected',
      code: 'busy',
    });

    controller.stop({ streamId: IDS[0] });
    await controller.whenIdle();
    expect(events.at(-1)).toEqual({ type: 'cancelled', streamId: IDS[0] });

    expect(controller.start(sink, { text: 'second' })).toMatchObject({
      status: 'started',
      streamId: IDS[1],
    });
    controller.stop({ streamId: IDS[1] });
    await controller.whenIdle();
  });

  it('cancels via stop and stops emitting deltas', async () => {
    const { controller, sink, events } = setup(endless);
    controller.start(sink, { text: 'go' });
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
    controller.start(sink, { text: 'go' });
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
    controller.start(sink, { text: 'go' });
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
    controller.start(sink, { text: 'go' });
    await controller.whenIdle();
    expect(events.at(-1)).toEqual({
      type: 'error',
      streamId: IDS[0],
      code: chatCode,
      message: `boom: ${providerCode}`,
    });
  });

  it('rejects invalid requests with a reason and stores nothing', () => {
    const { controller, sink, storage } = setup(endless);
    expect(controller.start(sink, { text: '  \n ' })).toEqual({
      status: 'rejected',
      code: 'invalid-request',
      message: 'The message must not be empty.',
    });
    expect(controller.start(sink, { messages: [user('old shape')] })).toMatchObject({
      status: 'rejected',
      code: 'invalid-request',
    });
    expect(storage.conversations.current()).toBeUndefined();
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
    controller.start(sink, { text: 'Hi' });
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
    controller.start(sink, { text: 'Hi' });
    await controller.whenIdle();
    expect(events.at(-1)?.type).toBe('done');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not report usage for cancelled replies', async () => {
    const usages: unknown[] = [];
    const { controller, sink } = setup(endless, (usage) => usages.push(usage));
    controller.start(sink, { text: 'go' });
    controller.stop({ streamId: IDS[0] });
    await controller.whenIdle();
    expect(usages).toEqual([]);
  });
});

describe('ChatController engine selection', () => {
  const sink = (events: ChatEvent[]): ChatEventSink => ({
    id: 1,
    isDestroyed: () => false,
    send: (e) => events.push(e),
  });
  const engine = (
    name: ChatEngine['name'],
    text = name,
  ): ChatEngine & { calls: number; streamChat(): AsyncGenerator<GenerateChunk> } => {
    const e = {
      name,
      calls: 0,
      async *streamChat(): AsyncGenerator<GenerateChunk> {
        e.calls++;
        await Promise.resolve();
        yield { type: 'delta', content: text };
        yield { ...done, result: { ...done.result, content: text } };
      },
    };
    return e;
  };
  const runtime = { model: 'm', streamChat: vi.fn() };
  const conversations = () => openStorage({ path: ':memory:' }).conversations;

  it('without a selector it uses the legacy runtime (unchanged behaviour)', async () => {
    const legacy = engine('legacy');
    const chat = new ChatController({
      runtime: { model: 'm', streamChat: legacy.streamChat },
      conversations: conversations(),
    });
    const events: ChatEvent[] = [];
    chat.start(sink(events), { text: 'Hi' });
    await chat.whenIdle();
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
    expect(legacy.calls).toBe(1);
  });

  it('captures the engine once, when the request starts', async () => {
    const legacy = engine('legacy');
    const adk = engine('adk');
    let current: ChatEngine = adk;
    const selectEngine = vi.fn(() => current);
    const chat = new ChatController({ runtime, selectEngine, conversations: conversations() });
    const events: ChatEvent[] = [];
    chat.start(sink(events), { text: 'Hi' });
    current = legacy; // changed after start: does not affect the running request
    await chat.whenIdle();
    expect(selectEngine).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ type: 'delta', content: 'adk' });

    chat.start(sink(events), { text: 'Hi' });
    await chat.whenIdle();
    expect(events.at(-2)).toMatchObject({ type: 'delta', content: 'legacy' });
  });

  it('rejected requests (busy, invalid) never select an engine', async () => {
    const selectEngine = vi.fn(() => engine('adk'));
    const chat = new ChatController({ runtime, selectEngine, conversations: conversations() });
    expect(chat.start(sink([]), { text: '' })).toMatchObject({ status: 'rejected' });
    chat.start(sink([]), { text: 'Hi' });
    expect(chat.start(sink([]), { text: 'Hi' })).toMatchObject({
      code: 'busy',
    });
    await chat.whenIdle();
    expect(selectEngine).toHaveBeenCalledTimes(1);
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
