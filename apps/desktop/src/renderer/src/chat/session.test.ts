import {
  type ChatApi,
  type ChatConversationItem,
  type ChatEvent,
  type ChatHistory,
  type ChatStartRequest,
} from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { isSubmitKey } from './keyboard';
import { createChatSession } from './session';

const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

const item = (id: string, title = 'New chat'): ChatConversationItem => ({
  id,
  title,
  updatedAt: '2026-11-21T10:00:00.000Z',
});

/**
 * Fake preload bridge: records requests and lets tests push events. By default
 * one stored conversation, `c1`, which the session opens.
 */
function fakeApi(
  options: {
    eventBeforeStartResolves?: boolean;
    history?: (conversationId: string) => Promise<ChatHistory>;
    conversations?: ChatConversationItem[];
  } = {},
) {
  const ids = [...IDS];
  let listener: ((event: ChatEvent) => void) | undefined;
  const requests: ChatStartRequest[] = [];
  const stops: string[] = [];
  let list = [...(options.conversations ?? [item('c1')])];
  let created = 0;
  const api: ChatApi = {
    list: vi.fn(async () => ({ conversations: [...list] })),
    create: vi.fn(async () => {
      const id = `new-${++created}`;
      list = [item(id), ...list];
      return { conversationId: id };
    }),
    start: vi.fn(async (request: ChatStartRequest) => {
      requests.push(request);
      const streamId = ids.shift() ?? 'x';
      if (options.eventBeforeStartResolves)
        listener?.({ type: 'delta', streamId, content: 'early ' });
      return { status: 'started' as const, streamId, model: 'qwen3:8b' };
    }),
    stop: vi.fn(async (streamId: string) => void stops.push(streamId)),
    history: vi.fn(options.history ?? (async () => ({ messages: [] }))),
    clear: vi.fn(async (conversationId: string) => {
      list = list.filter((c) => c.id !== conversationId);
    }),
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

/** A session whose stored transcript has loaded (Send is enabled only then). */
async function session(api: ChatApi, onConnectionProblem = vi.fn()) {
  const chat = createChatSession(api, { model: () => 'qwen3:8b', onConnectionProblem });
  await chat.whenLoaded;
  return chat;
}

describe('chat session: stored transcript', () => {
  it('loads the stored bubbles and keeps Send disabled until the load settles', async () => {
    let resolveHistory!: (history: ChatHistory) => void;
    const { api } = fakeApi({
      history: () => new Promise((resolve) => (resolveHistory = resolve)),
    });
    const chat = createChatSession(api, { model: () => 'qwen3:8b' });
    chat.draft.value = 'Too early';
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledWith('c1'));
    expect(chat.openId.value).toBe('c1');
    expect(chat.loaded.value).toBe(false);
    expect(chat.canSend.value).toBe(false);
    await chat.send();
    expect(api.start).not.toHaveBeenCalled();

    resolveHistory({
      messages: [
        {
          role: 'user',
          content: 'Earlier question',
          status: 'complete',
          model: null,
          promptTokens: null,
          completionTokens: null,
        },
        {
          role: 'assistant',
          content: 'Earlier answer',
          status: 'complete',
          model: 'qwen3:8b',
          promptTokens: 20,
          completionTokens: 6,
        },
        {
          role: 'user',
          content: 'Second',
          status: 'complete',
          model: null,
          promptTokens: null,
          completionTokens: null,
        },
        {
          role: 'assistant',
          content: '',
          status: 'error',
          model: null,
          promptTokens: null,
          completionTokens: null,
        },
      ],
    });
    await chat.whenLoaded;
    expect(chat.loaded.value).toBe(true);
    expect(chat.canSend.value).toBe(true);
    expect(chat.messages.value.map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'Earlier question', 'complete'],
      ['assistant', 'Earlier answer', 'complete'],
      ['user', 'Second', 'complete'],
      ['assistant', '', 'error'],
    ]);
    expect(chat.messages.value[1]?.stats).toEqual({ tokens: 6, durationMs: null });
    expect(chat.messages.value[3]?.error?.title).toBe('This reply failed');
    expect(chat.messages.value.every((m) => m.tools.length === 0)).toBe(true);
  });

  it('enables Send even when the stored transcript cannot be loaded, and says so', async () => {
    const { api } = fakeApi({ history: () => Promise.reject(new Error('agent down')) });
    const chat = await session(api);
    expect(chat.messages.value).toEqual([]);
    expect(chat.startError.value?.detail).toContain('agent down');
    chat.draft.value = 'Hi';
    expect(chat.canSend.value).toBe(true);
  });
});

describe('chat session', () => {
  it('sends a message and streams the reply progressively', async () => {
    const { api, emit } = fakeApi();
    const chat = await session(api);
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

  it('sends only the new text; the earlier turns stay on screen (the agent stores them)', async () => {
    const { api, emit, requests } = fakeApi();
    const chat = await session(api);
    chat.draft.value = 'First';
    await chat.send();
    emit({ type: 'delta', streamId: IDS[0] as string, content: 'Answer one' });
    emit(done(IDS[0] as string));

    chat.draft.value = '  Second  ';
    await chat.send();
    expect(requests).toEqual([
      { conversationId: 'c1', text: 'First' },
      { conversationId: 'c1', text: 'Second' },
    ]);
    expect(chat.messages.value.map((m) => m.content)).toEqual([
      'First',
      'Answer one',
      'Second',
      '',
    ]);
  });

  it('does not send empty messages or while generating', async () => {
    const { api } = fakeApi();
    const chat = await session(api);
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
    const chat = await session(api);
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
    const chat = await session(api);
    chat.draft.value = 'Hi';
    const sending = chat.send();
    await chat.stop(); // phase is still "starting"
    await sending;
    expect(stops).toEqual([IDS[0]]);
    expect(chat.phase.value).toBe('stopping');
  });

  it('applies events that arrive before start() resolves', async () => {
    const { api } = fakeApi({ eventBeforeStartResolves: true });
    const chat = await session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    expect(chat.messages.value[1]?.content).toBe('early ');
  });

  it('ignores events for other streams', async () => {
    const { api, emit } = fakeApi();
    const chat = await session(api);
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
    const chat = await session(api, onConnectionProblem);
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

  it('keeps a failed reply on screen and sends only the next text', async () => {
    const { api, emit, requests } = fakeApi();
    const chat = await session(api);
    chat.draft.value = 'One';
    await chat.send();
    emit({ type: 'error', streamId: IDS[0] as string, code: 'unavailable', message: 'down' });
    chat.draft.value = 'Two';
    await chat.send();
    expect(requests).toEqual([
      { conversationId: 'c1', text: 'One' },
      { conversationId: 'c1', text: 'Two' },
    ]);
    expect(chat.messages.value.map((m) => [m.content, m.status])).toEqual([
      ['One', 'complete'],
      ['', 'error'],
      ['Two', 'complete'],
      ['', 'streaming'],
    ]);
  });

  it('a failed start removes its bubbles, restores the text and reports why', async () => {
    const { api } = fakeApi({
      history: async () => ({
        messages: [
          {
            role: 'user',
            content: 'Stored',
            status: 'complete',
            model: null,
            promptTokens: null,
            completionTokens: null,
          },
        ],
      }),
    });
    vi.mocked(api.start).mockResolvedValueOnce({
      status: 'rejected',
      code: 'busy',
      message: 'busy',
    });
    vi.mocked(api.start).mockRejectedValueOnce(new Error('IPC broke'));
    const chat = await session(api);

    chat.draft.value = 'One';
    await chat.send();
    expect(chat.messages.value.map((m) => m.content)).toEqual(['Stored']);
    expect(chat.draft.value).toBe('One');
    expect(chat.startError.value?.code).toBe('busy');

    await chat.send();
    expect(chat.messages.value.map((m) => m.content)).toEqual(['Stored']);
    expect(chat.startError.value).toMatchObject({ code: 'generation-failed', detail: 'IPC broke' });
    expect(chat.phase.value).toBe('idle');
    expect(chat.canSend.value).toBe(true);
  });

  it('Delete chat removes the open conversation through the agent and shows the empty state', async () => {
    const { api, emit } = fakeApi();
    const chat = await session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    emit(done(IDS[0] as string));
    expect(await chat.clear()).toBe(true);
    expect(api.clear).toHaveBeenCalledWith('c1');
    expect(chat.openId.value).toBeNull();
    expect(chat.messages.value).toEqual([]);
    expect(chat.conversations.value).toEqual([]);
    chat.draft.value = 'Nowhere to go';
    expect(chat.canSend.value).toBe(false);
  });

  it('keeps the list when Delete fails', async () => {
    const { api, emit } = fakeApi();
    vi.mocked(api.clear).mockRejectedValueOnce(new Error('agent down'));
    const chat = await session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    emit(done(IDS[0] as string));
    expect(await chat.clear()).toBe(false);
    expect(chat.openId.value).toBe('c1');
    expect(chat.messages.value).toHaveLength(2);
    expect(chat.startError.value?.detail).toContain('agent down');
  });

  it('unsubscribes and stops on dispose', async () => {
    const { api, stops, isSubscribed } = fakeApi();
    const chat = await session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    chat.dispose();
    expect(isSubscribed()).toBe(false);
    expect(stops).toEqual([IDS[0]]);
  });
});

describe('chat session: several conversations', () => {
  const stored = (content: string): ChatHistory => ({
    messages: [
      {
        role: 'user',
        content,
        status: 'complete',
        model: null,
        promptTokens: null,
        completionTokens: null,
      },
    ],
  });

  it('opens the newest-updated conversation; an empty database opens nothing', async () => {
    const two = fakeApi({
      conversations: [item('b', 'Newest'), item('a', 'Older')],
      history: async (id) => stored(`question in ${id}`),
    });
    const chat = await session(two.api);
    expect(chat.openId.value).toBe('b');
    expect(chat.messages.value.map((m) => m.content)).toEqual(['question in b']);

    const empty = fakeApi({ conversations: [] });
    const none = await session(empty.api);
    expect(none.initialized.value).toBe(true);
    expect(none.openId.value).toBeNull();
    expect(empty.api.create).not.toHaveBeenCalled();
    expect(empty.api.history).not.toHaveBeenCalled();
    none.draft.value = 'Hi';
    expect(none.canSend.value).toBe(false);
  });

  it('New creates and opens a conversation; start, history and clear carry the open id', async () => {
    const { api, emit, requests } = fakeApi({ history: async (id) => stored(`in ${id}`) });
    const chat = await session(api);
    expect(await chat.create()).toBe(true);
    expect(chat.openId.value).toBe('new-1');
    expect(api.history).toHaveBeenLastCalledWith('new-1');
    expect(chat.conversations.value.map((c) => c.id)).toEqual(['new-1', 'c1']);

    chat.draft.value = 'In the new one';
    await chat.send();
    emit(done(IDS[0] as string));
    expect(requests.at(-1)).toEqual({ conversationId: 'new-1', text: 'In the new one' });

    expect(await chat.open('c1')).toBe(true);
    expect(api.history).toHaveBeenLastCalledWith('c1');
    expect(chat.messages.value.map((m) => m.content)).toEqual(['in c1']);
    chat.draft.value = 'Back in c1';
    await chat.send();
    expect(requests.at(-1)).toEqual({ conversationId: 'c1', text: 'Back in c1' });
    emit(done(IDS[1] as string));

    await chat.clear();
    expect(api.clear).toHaveBeenLastCalledWith('c1');
    expect(chat.conversations.value.map((c) => c.id)).toEqual(['new-1']);
  });

  it('refuses switching, creating and deleting while a reply is streaming', async () => {
    const { api, emit } = fakeApi({ conversations: [item('c1'), item('c2')] });
    const chat = await session(api);
    chat.draft.value = 'Hi';
    await chat.send();
    expect(chat.busy.value).toBe(true);

    expect(await chat.open('c2')).toBe(false);
    expect(await chat.create()).toBe(false);
    expect(await chat.remove('c2')).toBe(false);
    expect(await chat.clear()).toBe(false);
    expect(api.create).not.toHaveBeenCalled();
    expect(api.clear).not.toHaveBeenCalled();
    expect(api.history).toHaveBeenCalledTimes(1); // only the initial load of c1
    // The reply's bubbles stay on the conversation that started it.
    expect(chat.openId.value).toBe('c1');
    emit({ type: 'delta', streamId: IDS[0] as string, content: 'Answer' });
    emit(done(IDS[0] as string));
    expect(chat.messages.value.map((m) => m.content)).toEqual(['Hi', 'Answer']);

    expect(await chat.open('c2')).toBe(true);
    expect(chat.messages.value).toEqual([]);
  });

  it('deleting another conversation keeps the open one', async () => {
    const { api } = fakeApi({
      conversations: [item('c1'), item('c2')],
      history: async (id) => stored(`in ${id}`),
    });
    const chat = await session(api);
    expect(await chat.remove('c2')).toBe(true);
    expect(api.clear).toHaveBeenCalledWith('c2');
    expect(chat.openId.value).toBe('c1');
    expect(chat.messages.value.map((m) => m.content)).toEqual(['in c1']);
    expect(chat.conversations.value.map((c) => c.id)).toEqual(['c1']);
  });

  it('a slow history load for a conversation the user left is ignored', async () => {
    let resolveFirst!: (history: ChatHistory) => void;
    const { api } = fakeApi({
      conversations: [item('c1'), item('c2')],
      history: (id) =>
        id === 'c1'
          ? new Promise((resolve) => (resolveFirst = resolve))
          : Promise.resolve(stored('in c2')),
    });
    const chat = createChatSession(api, { model: () => 'qwen3:8b' });
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledWith('c1'));
    await chat.open('c2');
    resolveFirst(stored('in c1'));
    await chat.whenLoaded;
    expect(chat.openId.value).toBe('c2');
    expect(chat.messages.value.map((m) => m.content)).toEqual(['in c2']);
    expect(chat.loaded.value).toBe(true);
  });

  it('refreshes the list when a reply ends (its title and order change)', async () => {
    const { api, emit } = fakeApi();
    const chat = await session(api);
    const before = vi.mocked(api.list).mock.calls.length;
    chat.draft.value = 'Hi';
    await chat.send();
    emit(done(IDS[0] as string));
    expect(vi.mocked(api.list).mock.calls.length).toBe(before + 1);
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
