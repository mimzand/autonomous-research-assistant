import { AgentClientError } from '@rka/agent-client';
import { type ParsedEvent } from '@rka/agent-protocol';
import { IpcEvents, type ChatEvent } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { type SenderLike } from './ipc.js';
import {
  AGENT_DISCONNECTED_MESSAGE,
  createServiceChat,
  SERVICE_CHAT_REQUEST_TIMEOUT_MS,
} from './service-chat.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const hi = { conversationId: 'c1', text: 'Hi' };

type RequestFn = (method: string, params: unknown, options?: unknown) => Promise<unknown>;

function fakeSender(id: number) {
  let destroyed = false;
  let onDestroyed: (() => void) | undefined;
  const received: ChatEvent[] = [];
  const sender: SenderLike = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      expect(channel).toBe(IpcEvents.chatEvent);
      received.push(payload as ChatEvent);
    },
    once: (_event, listener) => (onDestroyed = listener),
  };
  return {
    sender,
    received,
    destroy() {
      destroyed = true;
      onDestroyed?.();
    },
    markDestroyed: () => (destroyed = true),
  };
}

function setup(request = vi.fn<RequestFn>()) {
  let emit: ((event: ParsedEvent) => void) | undefined;
  let close: ((error: AgentClientError) => void) | undefined;
  const log = { warn: vi.fn() };
  const chat = createServiceChat({
    client: {
      request: request as never,
      onEvent: (listener) => {
        emit = listener;
        return () => undefined;
      },
      onClose: (listener) => void (close = listener),
    },
    log,
  });
  const push = (payload: ChatEvent) => emit?.({ id: 'e', method: 'chat.event', payload });
  const disconnect = () =>
    close?.(new AgentClientError('connection_closed', 'The agent closed the connection.'));
  return { chat, request, push, disconnect, log };
}

const startedAs = (streamId: string) =>
  vi.fn<RequestFn>((method) =>
    Promise.resolve(method === 'chat.start' ? { status: 'started', streamId, model: 'm' } : null),
  );

describe('createServiceChat (AGENT_TRANSPORT=service)', () => {
  it('starts in the agent and routes chat.event to the starting window', async () => {
    const { chat, request, push } = setup(startedAs(S1));
    const a = fakeSender(1);
    await expect(chat.start(a.sender, hi)).resolves.toEqual({
      status: 'started',
      streamId: S1,
      model: 'm',
    });
    expect(request).toHaveBeenCalledWith('chat.start', hi, {
      timeoutMs: SERVICE_CHAT_REQUEST_TIMEOUT_MS,
    });
    push({ type: 'delta', streamId: S1, content: 'Hel' });
    push({ type: 'delta', streamId: S2, content: 'not ours' });
    push({ type: 'cancelled', streamId: S1 });
    push({ type: 'delta', streamId: S1, content: 'after the end' });
    expect(a.received).toEqual([
      { type: 'delta', streamId: S1, content: 'Hel' },
      { type: 'cancelled', streamId: S1 },
    ]);
  });

  it('keeps events that arrive before the start reply, in order', async () => {
    const { chat, push } = setup(
      vi.fn<RequestFn>(async () => {
        // The agent's first events are decoded before the start reply is handled.
        push({ type: 'delta', streamId: S1, content: 'A' });
        push({ type: 'delta', streamId: S1, content: 'B' });
        return { status: 'started', streamId: S1, model: 'm' };
      }),
    );
    const a = fakeSender(1);
    await chat.start(a.sender, hi);
    push({ type: 'delta', streamId: S1, content: 'C' });
    expect(a.received.map((e) => (e.type === 'delta' ? e.content : e.type))).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('rejects an invalid request locally, exactly like the in-process controller', async () => {
    const { chat, request } = setup();
    await expect(
      chat.start(fakeSender(1).sender, { conversationId: 'c1', text: '' }),
    ).resolves.toMatchObject({
      status: 'rejected',
      code: 'invalid-request',
      message: expect.any(String),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('passes busy through and validates the agent result', async () => {
    const busy = { status: 'rejected', code: 'busy', message: 'A response is already…' };
    const { chat } = setup(vi.fn<RequestFn>(() => Promise.resolve(busy)));
    await expect(chat.start(fakeSender(1).sender, hi)).resolves.toEqual(busy);

    const bad = setup(vi.fn<RequestFn>(() => Promise.resolve({ status: 'started' })));
    await expect(bad.chat.start(fakeSender(1).sender, hi)).rejects.toThrow();
  });

  it('stops by streamId and throws on a malformed stop', async () => {
    const { chat, request } = setup(startedAs(S1));
    await chat.stop({ streamId: S1 });
    expect(request).toHaveBeenCalledWith(
      'chat.stop',
      { streamId: S1 },
      { timeoutMs: SERVICE_CHAT_REQUEST_TIMEOUT_MS },
    );
    await expect(chat.stop({ streamId: 'nope' })).rejects.toThrow();
    await expect(chat.stop(undefined)).rejects.toThrow();
  });

  it('stops the stream when its window closes', async () => {
    const { chat, request } = setup(startedAs(S1));
    const a = fakeSender(1);
    await chat.start(a.sender, hi);
    a.destroy();
    expect(request).toHaveBeenLastCalledWith('chat.stop', { streamId: S1 }, expect.any(Object));
  });

  it('stops the stream when an event finds its window already destroyed', async () => {
    const { chat, request, push } = setup(startedAs(S1));
    const a = fakeSender(1);
    await chat.start(a.sender, hi);
    a.markDestroyed();
    push({ type: 'delta', streamId: S1, content: 'x' });
    expect(a.received).toEqual([]);
    expect(request).toHaveBeenLastCalledWith('chat.stop', { streamId: S1 }, expect.any(Object));
  });

  it('ends open streams with an unavailable error when the agent disconnects', async () => {
    const { chat, request, push, disconnect } = setup(startedAs(S1));
    const a = fakeSender(1);
    await chat.start(a.sender, hi);
    disconnect();
    expect(a.received).toEqual([
      { type: 'error', streamId: S1, code: 'unavailable', message: AGENT_DISCONNECTED_MESSAGE },
    ]);
    request.mockClear();
    a.destroy();
    push({ type: 'delta', streamId: S1, content: 'late' });
    expect(request).not.toHaveBeenCalled();
    expect(a.received).toHaveLength(1);
  });

  it('logs a failed background stop instead of throwing', async () => {
    const request = vi.fn<RequestFn>((method) =>
      method === 'chat.start'
        ? Promise.resolve({ status: 'started', streamId: S1, model: 'm' })
        : Promise.reject(new Error('timed out')),
    );
    const { chat, log } = setup(request);
    const a = fakeSender(1);
    await chat.start(a.sender, hi);
    a.destroy();
    await vi.waitFor(() =>
      expect(log.warn).toHaveBeenCalledWith(`Could not stop chat stream ${S1}: timed out`),
    );
  });
});
