import { type ChatApi, type ChatEvent, type ChatStartRequest } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { isSubmitKey } from './keyboard';
import { createChatSession } from './session';

const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

/** Fake preload bridge: records requests and lets tests push events. */
function fakeApi(options: { eventBeforeStartResolves?: boolean } = {}) {
  const ids = [...IDS];
  let listener: ((event: ChatEvent) => void) | undefined;
  const requests: ChatStartRequest[] = [];
  const stops: string[] = [];
  const api: ChatApi = {
    start: vi.fn(async (request: ChatStartRequest) => {
      requests.push(request);
      const streamId = ids.shift() ?? 'x';
      if (options.eventBeforeStartResolves)
        listener?.({ type: 'delta', streamId, content: 'early ' });
      return { status: 'started' as const, streamId, model: 'qwen3:8b' };
    }),
    stop: vi.fn(async (streamId: string) => void stops.push(streamId)),
    onEvent: (fn) => {
      listener = fn;
      return () => (listener = undefined);
    },
  };
  const emit = (event: ChatEvent) => listener?.(event);
  return { api, emit, requests, stops, isSubscribed: () => listener !== undefined };
}

const done = (streamId: string) =>
  ({
    type: 'done',
    streamId,
    model: 'qwen3:8b',
    finishReason: 'stop',
    completionTokens: 4,
    totalDurationMs: 900,
  }) as const;

function session(api: ChatApi, onConnectionProblem = vi.fn()) {
  return createChatSession(api, { model: () => 'qwen3:8b', onConnectionProblem });
}

describe('chat session', () => {
  it('sends a message and streams the reply progressively', async () => {
    const { api, emit } = fakeApi();
    const chat = session(api);
    chat.draft.value = '  Hello  ';
    await chat.send();

    expect(chat.phase.value).toBe('generating');
    expect(chat.draft.value).toBe('');
    expect(chat.messages.value.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'Hello', 'complete'],
      ['assistant', '', 'streaming'],
    ]);

    emit({ type: 'delta', streamId: IDS[0] as string, content: 'Hi' });
    expect(chat.messages.value[1]?.content).toBe('Hi');
    emit({ type: 'delta', streamId: IDS[0] as string, content: ' there' });
    expect(chat.messages.value[1]?.content).toBe('Hi there');

    emit(done(IDS[0] as string));
    expect(chat.phase.value).toBe('idle');
    expect(chat.messages.value[1]).toMatchObject({
      status: 'complete',
      stats: { tokens: 4, durationMs: 900 },
    });
  });

  it('keeps history and sends it with the next message', async () => {
    const { api, emit, requests } = fakeApi();
    const chat = session(api);
    chat.draft.value = 'First';
    await chat.send();
    emit({ type: 'delta', streamId: IDS[0] as string, content: 'Answer one' });
    emit(done(IDS[0] as string));

    chat.draft.value = 'Second';
    await chat.send();
    expect(requests[1]).toEqual({
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answer one' },
        { role: 'user', content: 'Second' },
      ],
    });
    expect(chat.messages.value).toHaveLength(4);
  });

  it('does not send empty messages or while generating', async () => {
    const { api } = fakeApi();
    const chat = session(api);
    chat.draft.value = '   \n  ';
    expect(chat.canSend.value).toBe(false);
    await chat.send();
    expect(api.start).not.toHaveBeenCalled();

    chat.draft.value = 'Hi';
    await chat.send();
    chat.draft.value = 'Again';
    expect(chat.canSend.value).toBe(false);
    await chat.send();
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it('stops a generation and keeps the partial reply', async () => {
    const { api, emit, stops } = fakeApi();
    const chat = session(api);
    chat.draft.value = 'Long essay';
    await chat.send();
    emit({ type: 'delta', streamId: IDS[0] as string, content: 'Rivers are' });

    await chat.stop();
    expect(chat.phase.value).toBe('stopping');
    expect(stops).toEqual([IDS[0]]);

    emit({ type: 'cancelled', streamId: IDS[0] as string });
    expect(chat.phase.value).toBe('idle');
    expect(chat.messages.value[1]).toMatchObject({ content: 'Rivers are', status: 'cancelled' });
  });

  it('honours Stop pressed before the stream id is known', async () => {
    const { api, stops } = fakeApi();
    const chat = session(api);
    chat.draft.value = 'Hi';
    const sending = chat.send();
    await chat.stop(); // phase is still "starting"
    await sending;
    expect(stops).toEqual([IDS[0]]);
    expect(chat.phase.value).toBe('stopping');
  });

  it('applies events that arrive before start() resolves', async () => {
    const { api } = fakeApi({ eventBeforeStartResolves: true });
    const chat = session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    expect(chat.messages.value[1]?.content).toBe('early ');
  });

  it('ignores events for other streams', async () => {
    const { api, emit } = fakeApi();
    const chat = session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    emit({ type: 'delta', streamId: IDS[1] as string, content: 'not mine' });
    expect(chat.messages.value[1]?.content).toBe('');
  });

  it.each([
    ['unavailable', 'Cannot connect to Ollama', 'Make sure Ollama is running', true],
    ['model-not-found', 'Model qwen3:8b is not installed', 'ollama pull qwen3:8b', true],
    ['timeout', 'took too long', 'still be loading', false],
    ['generation-failed', 'Generation failed', 'Try sending', false],
  ] as const)('shows a clear %s error', async (code, title, hint, refreshesStatus) => {
    const { api, emit } = fakeApi();
    const onConnectionProblem = vi.fn();
    const chat = session(api, onConnectionProblem);
    chat.draft.value = 'Hi';
    await chat.send();
    emit({ type: 'error', streamId: IDS[0] as string, code, message: 'detail from main' });

    const reply = chat.messages.value[1];
    expect(reply?.status).toBe('error');
    expect(reply?.error?.title).toContain(title);
    expect(reply?.error?.hint).toContain(hint);
    expect(reply?.error?.detail).toBe('detail from main');
    expect(chat.phase.value).toBe('idle');
    expect(onConnectionProblem).toHaveBeenCalledTimes(refreshesStatus ? 1 : 0);
  });

  it('does not resend failed replies as history', async () => {
    const { api, emit, requests } = fakeApi();
    const chat = session(api);
    chat.draft.value = 'One';
    await chat.send();
    emit({ type: 'error', streamId: IDS[0] as string, code: 'unavailable', message: 'down' });
    chat.draft.value = 'Two';
    await chat.send();
    expect(requests[1]?.messages).toEqual([
      { role: 'user', content: 'One' },
      { role: 'user', content: 'Two' },
    ]);
  });

  it('reports rejected starts and bridge failures', async () => {
    const { api } = fakeApi();
    vi.mocked(api.start).mockResolvedValueOnce({
      status: 'rejected',
      code: 'busy',
      message: 'busy',
    });
    vi.mocked(api.start).mockRejectedValueOnce(new Error('IPC broke'));
    const chat = session(api);

    chat.draft.value = 'One';
    await chat.send();
    expect(chat.messages.value[1]?.error?.code).toBe('busy');

    chat.draft.value = 'Two';
    await chat.send();
    expect(chat.messages.value[3]?.error).toMatchObject({
      code: 'generation-failed',
      detail: 'IPC broke',
    });
    expect(chat.phase.value).toBe('idle');
  });

  it('clears the conversation, stopping any generation', async () => {
    const { api, emit, stops } = fakeApi();
    const chat = session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    await chat.clear();
    expect(stops).toEqual([IDS[0]]);
    expect(chat.messages.value).toEqual([]);
    expect(chat.phase.value).toBe('idle');

    emit({ type: 'cancelled', streamId: IDS[0] as string }); // Late event is ignored.
    expect(chat.messages.value).toEqual([]);
  });

  it('unsubscribes and stops on dispose', async () => {
    const { api, stops, isSubscribed } = fakeApi();
    const chat = session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    chat.dispose();
    expect(isSubscribed()).toBe(false);
    expect(stops).toEqual([IDS[0]]);
  });
});

describe('isSubmitKey', () => {
  it('submits on Enter only', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(isSubmitKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSubmitKey({ key: 'a', shiftKey: false })).toBe(false);
  });

  it('never submits during IME composition', () => {
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(isSubmitKey({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });
});
