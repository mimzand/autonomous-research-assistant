import { readFileSync } from 'node:fs';
import { AgentClientError } from '@rka/agent-client';
import { type ParsedEvent } from '@rka/agent-protocol';
import { IpcChannels, IpcEvents, type AppInfo } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { type InvokeEventLike, type IpcMainLike } from './ipc.js';
import { SERVICE_REQUEST_TIMEOUT_MS, SERVICE_ROUTES } from './service-ipc.js';
import { startServiceShell } from './service-shell.js';

const openStorage = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Electron must not open SQLite in service mode.');
  }),
);
vi.mock('@rka/storage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openStorage,
}));

type Listener = (event: InvokeEventLike, ...args: unknown[]) => unknown;

const APP_URL = 'app://renderer/index.html';
const appInfo: AppInfo = {
  name: 'rka',
  version: '0.1.0',
  platform: 'win32',
  versions: { electron: '1', chrome: '1', node: '1' },
};

const event = (url = APP_URL): InvokeEventLike => ({
  senderFrame: { url, parent: null },
  sender: { id: 1, isDestroyed: () => false, send: () => undefined, once: () => undefined },
});

type RequestFn = (method: string) => Promise<unknown>;

async function setup(request = vi.fn<RequestFn>((method) => Promise.resolve({ from: method }))) {
  const handlers = new Map<string, Listener>();
  const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
  const quitListeners: (() => void)[] = [];
  const closeListeners: ((error: AgentClientError) => void)[] = [];
  const eventListeners: ((event: ParsedEvent) => void)[] = [];
  const client = {
    ack: { agent: { pid: 4321, version: '0.1.0' }, version: 1 } as never,
    request,
    onEvent: (listener: (event: ParsedEvent) => void) => {
      eventListeners.push(listener);
      return () => undefined;
    },
    onClose: (listener: (error: AgentClientError) => void) => {
      closeListeners.push(listener);
    },
    close: vi.fn(),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const broadcast = vi.fn();
  await startServiceShell({
    ipc,
    stateFile: 'agent-state.json',
    appVersion: '0.1.0',
    getAppInfo: () => appInfo,
    isTrustedSender: (url) => url === APP_URL,
    broadcast,
    onQuit: (listener) => quitListeners.push(listener),
    connect: () => Promise.resolve({ client: client as never, state: {} as never }),
    log,
  });
  // The startup ping is not part of what the renderer triggers.
  request.mockClear();
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(handler(event(), ...args));
  };
  const close = (error: AgentClientError) => {
    for (const listener of closeListeners) listener(error);
  };
  const push = (event: ParsedEvent) => {
    for (const listener of eventListeners) listener(event);
  };
  return { handlers, invoke, request, client, log, quitListeners, close, broadcast, push };
}

describe('startServiceShell (AGENT_TRANSPORT=service)', () => {
  it('registers every renderer channel without opening SQLite', async () => {
    const { handlers, invoke } = await setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(IpcChannels).sort());
    for (const channel of Object.values(IpcChannels)) {
      await invoke(channel).catch(() => undefined);
    }
    expect(openStorage).not.toHaveBeenCalled();
  });

  it('proxies the Phase 3 channels to the agent with validated params', async () => {
    const { invoke, request } = await setup();
    await expect(invoke(IpcChannels.tasksCounts)).resolves.toEqual({ from: 'tasks.counts' });
    await expect(invoke(IpcChannels.tasksGet, { id: 'task-1' })).resolves.toEqual({
      from: 'tasks.get',
    });
    await invoke(IpcChannels.tasksList);
    expect(request.mock.calls).toEqual([
      ['tasks.counts', {}, { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS }],
      ['tasks.get', { id: 'task-1' }, { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS }],
      ['tasks.list', expect.any(Object), { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS }],
    ]);
    expect(Object.keys(SERVICE_ROUTES)).toHaveLength(17);
  });

  it('proxies the research task lifecycle with validated params', async () => {
    const { invoke, request } = await setup(
      vi.fn<RequestFn>(() => Promise.resolve({ status: 'ok', taskId: 'task-1' })),
    );
    const goal = 'Why is the sky blue at noon?';
    await expect(invoke(IpcChannels.tasksStartResearch, { goal, maxSources: 3 })).resolves.toEqual({
      status: 'ok',
      taskId: 'task-1',
    });
    for (const channel of [
      IpcChannels.tasksPause,
      IpcChannels.tasksResume,
      IpcChannels.tasksCancel,
      IpcChannels.tasksRetry,
    ]) {
      await invoke(channel, { id: 'task-1' });
    }
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'tasks.startResearch',
      'tasks.pause',
      'tasks.resume',
      'tasks.cancel',
      'tasks.retry',
    ]);
    request.mockClear();
    await expect(invoke(IpcChannels.tasksStartResearch, { goal: 'short' })).rejects.toThrow(
      /Invalid params for tasks\.startResearch/,
    );
    await expect(invoke(IpcChannels.tasksPause, { id: '' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('fans ui.researchProgress out to every window and ignores other events', async () => {
    const { push, broadcast } = await setup();
    const progress = {
      type: 'step-completed' as const,
      taskId: 'task-1',
      taskStatus: 'running' as const,
      progress: { completed: 1, total: 4, current: null, estimated: true },
    };
    push({ id: 'e1', method: 'ui.researchProgress', payload: progress });
    push({
      id: 'e2',
      method: 'chat.event',
      payload: { type: 'cancelled', streamId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(broadcast.mock.calls).toEqual([[IpcEvents.researchProgress, progress]]);
  });

  it('proxies model health and Chat to the agent', async () => {
    const { invoke, request } = await setup(
      vi.fn<RequestFn>((method) =>
        Promise.resolve(
          method === 'chat.start'
            ? { status: 'rejected', code: 'busy', message: 'busy' }
            : { from: method },
        ),
      ),
    );
    await expect(invoke(IpcChannels.modelGetHealth)).resolves.toEqual({ from: 'model.health' });
    await expect(
      invoke(IpcChannels.chatStart, { messages: [{ role: 'user', content: 'Hi' }] }),
    ).resolves.toEqual({ status: 'rejected', code: 'busy', message: 'busy' });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['model.health', 'chat.start']);
  });

  it('rejects invalid renderer payloads before they reach the agent', async () => {
    const { invoke, request } = await setup();
    await expect(invoke(IpcChannels.tasksGet, { id: '' })).rejects.toThrow(
      /Invalid params for tasks\.get/,
    );
    await expect(invoke(IpcChannels.tasksGet, { id: 'a', extra: 1 })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('fails clearly for features that still need the in-process agent', async () => {
    const { invoke, request } = await setup();
    for (const channel of [
      IpcChannels.settingsGet,
      IpcChannels.storageBackup,
      IpcChannels.researchSearch,
    ]) {
      await expect(invoke(channel)).rejects.toThrow(
        `${channel} is not available with AGENT_TRANSPORT=service yet.`,
      );
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('answers app info locally and rejects untrusted senders', async () => {
    const { handlers, invoke } = await setup();
    await expect(invoke(IpcChannels.appGetInfo)).resolves.toEqual(appInfo);
    const handler = handlers.get(IpcChannels.tasksCounts);
    await expect(Promise.resolve(handler?.(event('https://evil.example/')))).rejects.toThrow(
      'Rejected IPC call from an untrusted sender.',
    );
  });

  it('passes agent errors through to the renderer', async () => {
    const { invoke } = await setup(
      vi.fn<RequestFn>((method) =>
        method === 'system.ping'
          ? Promise.resolve({ agentTime: '2026-11-14T12:00:00.000Z' })
          : Promise.reject(new AgentClientError('internal', 'tasks.counts failed in the agent.')),
      ),
    );
    await expect(invoke(IpcChannels.tasksCounts)).rejects.toThrow(
      'tasks.counts failed in the agent.',
    );
  });

  it('closes the connection on quit and warns only on an unexpected disconnect', async () => {
    const { client, log, quitListeners, close } = await setup();
    close(new AgentClientError('connection_closed', 'The agent closed the connection.'));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Agent service disconnected: The agent closed the connection.'),
    );
    log.warn.mockClear();
    for (const listener of quitListeners) listener();
    expect(client.close).toHaveBeenCalled();
    close(new AgentClientError('connection_closed', 'Closed by the client.'));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never imports the storage modules on the service path', () => {
    for (const file of [
      'service-shell.ts',
      'service-ipc.ts',
      'service-chat.ts',
      'agent-transport.ts',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/from '(@rka\/storage|\.\/app-storage\.js)'/);
    }
  });
});
