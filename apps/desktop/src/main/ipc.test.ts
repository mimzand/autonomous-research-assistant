import { createAgentRuntime, type AgentRuntime } from '@rka/agent-runtime';
import { type ModelProvider } from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import { createSourceStore } from '@rka/agent-runtime';
import { createToolRegistry, createWebServices, loadWebConfig } from '@rka/tools';
import { IpcChannels, IpcEvents, type AppInfo, type ModelHealth } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChatController } from './chat.js';
import { createRuntimeConfig } from './config/runtime-config.js';
import { createSettingsService } from './config/settings-service.js';
import { createDashboardService } from './dashboard.js';
import { registerIpcHandlers, type InvokeEventLike, type IpcMainLike } from './ipc.js';
import { createResearchToolsService } from './research-tools.js';

type Listener = (event: InvokeEventLike, ...args: unknown[]) => unknown;

/** Reversible stand-in for Electron safeStorage. */
const testCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${text}`).reverse(),
  decryptString: (data: Buffer) => Buffer.from(data).reverse().toString().slice(4),
};

const STREAM_ID = '3b241101-e2bb-4255-8caf-4136c566a962';

function setup(overrides: Partial<{ health: unknown; appInfo: unknown }> = {}) {
  const handlers = new Map<string, Listener>();
  const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };

  const health = (overrides.health ?? {
    status: 'ready',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    checkedAt: '2026-11-04T12:00:00.000Z',
    serverVersion: '0.40.14',
    capabilities: ['completion', 'tools', 'thinking'],
    contextLength: 40960,
    structuredOutput: true,
  }) as ModelHealth;
  const provider: ModelProvider = {
    id: 'ollama',
    defaultModel: 'qwen3:8b',
    checkHealth: async () => health,
    checkModel: vi.fn(),
    generate: vi.fn(),
    generateStream: async function* () {
      yield { type: 'delta' as const, content: 'Hi' };
    },
  };
  const storage = openStorage({ path: ':memory:', cipher: testCipher });
  const runtime: AgentRuntime = createAgentRuntime({
    modelProvider: provider,
    tools: createToolRegistry([]),
    storage,
  });
  const dashboard = createDashboardService({
    storage,
    runtime,
    chooseBackupPath: async () => null,
  });

  const appInfo: AppInfo = {
    name: 'rka',
    version: '0.0.0',
    platform: 'win32',
    versions: { electron: '45.2.2', chrome: '1', node: '24' },
  };

  const webConfig = loadWebConfig({});
  const researchTools = createResearchToolsService({
    config: webConfig,
    services: createWebServices(webConfig),
    tools: createToolRegistry([]),
    storage,
    sourceStore: createSourceStore(storage),
    chooseFile: async () => null,
    openExternal: async () => undefined,
  });

  const config = createRuntimeConfig({ storage, env: {}, encryptionAvailable: () => true });
  const settings = createSettingsService({
    config,
    ollama: {} as never,
    chooseFolder: async () => '/home/user/Backups',
  });

  const chat = new ChatController({ runtime, newId: () => STREAM_ID });
  registerIpcHandlers(ipc, {
    runtime,
    chat,
    dashboard,
    researchTools,
    settings,
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

  return { handlers, invoke, chat, sender, destroyedListeners, storage };
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

  it('rejects calls from sub-frames and calls with extra arguments', async () => {
    const { handlers, sender } = setup();
    const handler = handlers.get(IpcChannels.appGetInfo);
    if (!handler) throw new Error('missing handler');
    const iframe = { url: trusted, parent: { url: trusted } };
    await expect(handler({ senderFrame: iframe, sender })).rejects.toThrow(/untrusted/);
    await expect(
      handler({ senderFrame: { url: trusted, parent: null }, sender }, {}, 'extra'),
    ).rejects.toThrow(/unexpected arguments/);
    await expect(
      handler({ senderFrame: { url: trusted, parent: null }, sender }),
    ).resolves.toMatchObject({ name: 'rka' });
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

describe('dashboard IPC', () => {
  it('serves task, source, report and storage data from SQLite', async () => {
    const { invoke, storage } = setup();
    const task = storage.tasks.create({ title: 'Heat pumps', input: { question: 'q' } });
    storage.sources.add(task.id, { url: 'https://example.org/a', title: 'A' });

    await expect(invoke(IpcChannels.tasksCounts, trusted)).resolves.toMatchObject({ total: 1 });
    await expect(invoke(IpcChannels.tasksList, trusted, {})).resolves.toMatchObject({
      total: 1,
      items: [{ title: 'Heat pumps', sourceCount: 1 }],
    });
    await expect(invoke(IpcChannels.tasksGet, trusted, { id: task.id })).resolves.toMatchObject({
      task: { title: 'Heat pumps' },
      recovery: { resumable: false },
    });
    await expect(invoke(IpcChannels.tasksGet, trusted, { id: 'missing' })).resolves.toBeNull();
    await expect(invoke(IpcChannels.sourcesList, trusted, {})).resolves.toMatchObject({ total: 1 });
    await expect(invoke(IpcChannels.reportsList, trusted, {})).resolves.toEqual({
      items: [],
      total: 0,
    });
    await expect(invoke(IpcChannels.storageStatus, trusted)).resolves.toMatchObject({
      connected: true,
    });
    await expect(invoke(IpcChannels.storageIntegrityCheck, trusted)).resolves.toMatchObject({
      ok: true,
    });
    await expect(invoke(IpcChannels.storageBackup, trusted)).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('validates dashboard inputs', async () => {
    const { invoke } = setup();
    await expect(invoke(IpcChannels.tasksList, trusted, { status: ['bogus'] })).rejects.toThrow();
    await expect(invoke(IpcChannels.tasksList, trusted, { limit: 5000 })).rejects.toThrow();
    await expect(
      invoke(IpcChannels.tasksList, trusted, { sql: 'DROP TABLE tasks' }),
    ).rejects.toThrow();
    await expect(invoke(IpcChannels.tasksGet, trusted, {})).rejects.toThrow();
    await expect(invoke(IpcChannels.sourcesGet, trusted, { id: 42 })).rejects.toThrow();
    await expect(
      invoke(IpcChannels.sourcesList, trusted, { content: 'everything' }),
    ).rejects.toThrow();
  });

  it('starts and pauses research tasks through validated channels', async () => {
    const { invoke, storage } = setup();
    // No web_search tool is registered in this setup: the start is refused with a reason.
    await expect(
      invoke(IpcChannels.tasksStartResearch, trusted, { goal: 'How efficient are heat pumps?' }),
    ).resolves.toEqual({
      status: 'rejected',
      message: expect.stringMatching(/SEARXNG_URL/),
    });
    await expect(
      invoke(IpcChannels.tasksStartResearch, trusted, { goal: 'short' }),
    ).rejects.toThrow();
    await expect(
      invoke(IpcChannels.tasksStartResearch, trusted, {
        goal: 'A valid goal here',
        maxSources: 99,
      }),
    ).rejects.toThrow();
    await expect(
      invoke(IpcChannels.tasksStartResearch, trusted, {
        goal: 'A valid goal here',
        model: 'gpt-4',
      }),
    ).rejects.toThrow();
    const task = storage.tasks.create({ title: 'Not research', input: {} });
    await expect(invoke(IpcChannels.tasksPause, trusted, { id: task.id })).resolves.toMatchObject({
      status: 'rejected',
    });
    await expect(invoke(IpcChannels.tasksGet, trusted, { id: task.id })).resolves.toMatchObject({
      progress: null,
      recovery: { paused: false, pausable: false, retryable: false, interruption: null },
    });
  });

  it('validates retry and log requests and maps log steps to their sequence numbers', async () => {
    const { invoke, storage } = setup();
    const task = storage.tasks.create({ title: 'Not research', input: {} });
    await expect(invoke(IpcChannels.tasksRetry, trusted, { id: task.id })).resolves.toMatchObject({
      status: 'rejected',
      message: expect.stringMatching(/Only research tasks/),
    });
    await expect(invoke(IpcChannels.tasksRetry, trusted, {})).rejects.toThrow();

    const step = storage.steps.append(task.id, { kind: 'plan', name: 'Plan', input: {} });
    storage.logs.append(task.id, { level: 'info', event: 'task.started', message: 'Started' });
    storage.logs.append(task.id, {
      stepId: step.id,
      level: 'warn',
      event: 'tool.retry',
      message: 'Retrying',
      data: { attempt: 1 },
    });
    await expect(invoke(IpcChannels.tasksLogs, trusted, { id: task.id })).resolves.toMatchObject({
      items: [
        { seq: 1, event: 'task.started', stepSeq: null, data: null },
        { seq: 2, event: 'tool.retry', stepSeq: 1, level: 'warn', data: { attempt: 1 } },
      ],
      lastSeq: 2,
    });
    await expect(
      invoke(IpcChannels.tasksLogs, trusted, { id: task.id, afterSeq: 2 }),
    ).resolves.toEqual({ items: [], lastSeq: 2 });
    await expect(
      invoke(IpcChannels.tasksLogs, trusted, { id: task.id, afterSeq: -1 }),
    ).rejects.toThrow();
  });

  it('exposes setting counts but never setting values', async () => {
    const { invoke, storage } = setup();
    storage.settings.set('ui.theme', 'dark');
    const status = (await invoke(IpcChannels.storageStatus, trusted)) as {
      tables: { name: string; rows: number }[];
    };
    expect(status.tables.find((t) => t.name === 'settings')?.rows).toBe(1);
    expect(JSON.stringify(status)).not.toContain('dark');
  });

  it('serves settings: get, validate, update, reset - and never returns secrets', async () => {
    const { invoke, storage } = setup();
    const view = (await invoke(IpcChannels.settingsGet, trusted)) as {
      values: Record<string, unknown>;
      entries: Record<string, { source: string }>;
    };
    expect(view.values['ollama.baseUrl']).toBe('http://127.0.0.1:11434');
    expect(view.entries['ollama.baseUrl']?.source).toBe('default');

    await expect(
      invoke(IpcChannels.settingsValidate, trusted, { 'model.temperature': 7 }),
    ).resolves.toMatchObject({ ok: false, errors: { 'model.temperature': expect.any(String) } });
    await expect(
      invoke(IpcChannels.settingsUpdate, trusted, { 'model.temperature': 0.4 }),
    ).resolves.toMatchObject({ status: 'saved', changed: ['model.temperature'] });
    await expect(invoke(IpcChannels.settingsUpdate, trusted, 'nope')).rejects.toThrow();
    // The backup folder can only be set through the folder picker.
    await expect(
      invoke(IpcChannels.settingsUpdate, trusted, { 'backup.defaultDirectory': '/etc' }),
    ).resolves.toMatchObject({ status: 'invalid' });
    await expect(invoke(IpcChannels.settingsChooseBackupFolder, trusted)).resolves.toMatchObject({
      status: 'saved',
      view: { values: { 'backup.defaultDirectory': '/home/user/Backups' } },
    });

    const secret = await invoke(IpcChannels.settingsSetSecret, trusted, {
      key: 'ollama.authToken',
      value: 'tok-123456',
    });
    expect(JSON.stringify(secret)).not.toContain('tok-123456');
    expect(secret).toMatchObject({ view: { secrets: { 'ollama.authToken': { set: true } } } });
    expect(JSON.stringify(await invoke(IpcChannels.settingsGet, trusted))).not.toContain(
      'tok-123456',
    );
    // Stored encrypted, not in plaintext.
    expect(JSON.stringify(storage.settings.list())).not.toContain('tok-123456');
    await expect(
      invoke(IpcChannels.settingsSetSecret, trusted, { key: 'other.secret', value: 'x' }),
    ).rejects.toThrow();

    await expect(
      invoke(IpcChannels.settingsReset, trusted, { keys: ['model.temperature'] }),
    ).resolves.toMatchObject({ status: 'saved', view: { values: { 'model.temperature': null } } });
  });
});
