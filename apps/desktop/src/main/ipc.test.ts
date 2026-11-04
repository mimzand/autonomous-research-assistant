import { type AgentRuntime } from '@rka/agent-runtime';
import { IpcChannels, IpcEvents, type AppInfo } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChatController } from './chat.js';
import { registerIpcHandlers, type InvokeEventLike, type IpcMainLike } from './ipc.js';

type Listener = (event: InvokeEventLike, ...args: unknown[]) => unknown;

const STREAM_ID = '3b241101-e2bb-4255-8caf-4136c566a962';

function setup(overrides: Partial<{ health: unknown; appInfo: unknown }> = {}) {
  const handlers = new Map<string, Listener>();
  const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };

  const runtime: AgentRuntime = {
    model: 'qwen3:8b',
    getModelHealth: async () =>
      (overrides.health ?? {
        status: 'ready',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3:8b',
        checkedAt: '2026-11-04T12:00:00.000Z',
        serverVersion: '0.40.14',
        capabilities: ['completion', 'tools', 'thinking'],
        contextLength: 40960,
        structuredOutput: true,
      }) as Awaited<ReturnType<AgentRuntime['getModelHealth']>>,
    listTools: () => [],
    streamChat: async function* () {
      yield { type: 'delta' as const, content: 'Hi' };
    },
  };

  const appInfo: AppInfo = {
    name: 'rka',
    version: '0.0.0',
    platform: 'win32',
    versions: { electron: '45.2.2', chrome: '1', node: '24' },
  };

  const chat = new ChatController({ runtime, newId: () => STREAM_ID });
  registerIpcHandlers(ipc, {
    runtime,
    chat,
    getAppInfo: () => (overrides.appInfo ?? appInfo) as AppInfo,
    isTrustedSender: (url) => url.startsWith('file://'),
  });

  const destroyedListeners: (() => void)[] = [];
  const sender = {
    id: 7,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn((_event: 'destroyed', listener: () => void) => destroyedListeners.push(listener)),
  };

  const invoke = (channel: string, url: string | null, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ senderFrame: url === null ? null : { url }, sender }, payload);
  };

  return { handlers, invoke, chat, sender, destroyedListeners };
}

const trusted = 'file:///app/index.html';

describe('registerIpcHandlers', () => {
  it('registers exactly the channels in the shared contract', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(IpcChannels).sort());
  });

  it('serves trusted senders', async () => {
    const { invoke } = setup();
    await expect(invoke(IpcChannels.appGetInfo, trusted)).resolves.toMatchObject({ name: 'rka' });
    await expect(invoke(IpcChannels.modelGetHealth, trusted)).resolves.toMatchObject({
      status: 'ready',
    });
  });

  it('rejects untrusted or missing senders on every channel', async () => {
    const { invoke } = setup();
    for (const channel of Object.values(IpcChannels)) {
      await expect(invoke(channel, 'https://evil.example')).rejects.toThrow(/untrusted/);
      await expect(invoke(channel, null)).rejects.toThrow(/untrusted/);
    }
  });

  it('refuses to send responses that break the contract', async () => {
    const { invoke } = setup({ health: { status: 'ready', provider: 'openai' } });
    await expect(invoke(IpcChannels.modelGetHealth, trusted)).rejects.toThrow();
  });
});

describe('chat IPC', () => {
  it('starts a stream and pushes events to the requesting window only', async () => {
    const { invoke, chat, sender } = setup();
    await expect(
      invoke(IpcChannels.chatStart, trusted, { messages: [{ role: 'user', content: 'Hi' }] }),
    ).resolves.toEqual({ status: 'started', streamId: STREAM_ID, model: 'qwen3:8b' });
    await chat.whenIdle();
    expect(sender.send).toHaveBeenCalledWith(IpcEvents.chatEvent, {
      type: 'delta',
      streamId: STREAM_ID,
      content: 'Hi',
    });
  });

  it('rejects invalid chat requests without starting a stream', async () => {
    const { invoke, chat } = setup();
    for (const payload of [
      undefined,
      'hi',
      { messages: [] },
      { messages: [{ role: 'system', content: 'x' }] },
      { messages: [{ role: 'user', content: 'x' }], baseUrl: 'https://api.example' },
    ]) {
      await expect(invoke(IpcChannels.chatStart, trusted, payload)).resolves.toMatchObject({
        status: 'rejected',
        code: 'invalid-request',
      });
    }
    expect(chat.activeStreamId).toBeUndefined();
  });

  it('validates stop requests', async () => {
    const { invoke } = setup();
    await expect(invoke(IpcChannels.chatStop, trusted, { streamId: 'nope' })).rejects.toThrow();
    await expect(invoke(IpcChannels.chatStop, trusted, { streamId: STREAM_ID })).resolves.toBe(
      undefined,
    );
  });

  it('cancels generation when the window is destroyed', async () => {
    const { invoke, chat, destroyedListeners, sender } = setup();
    const stopForSink = vi.spyOn(chat, 'stopForSink');
    await invoke(IpcChannels.chatStart, trusted, { messages: [{ role: 'user', content: 'Hi' }] });
    await invoke(IpcChannels.chatStart, trusted, { messages: [{ role: 'user', content: 'Hi' }] });
    expect(sender.once).toHaveBeenCalledTimes(1); // Watched once per window.
    destroyedListeners.forEach((listener) => listener());
    expect(stopForSink).toHaveBeenCalledWith(7);
  });
});
