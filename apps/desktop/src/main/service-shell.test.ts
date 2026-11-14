import { readFileSync } from 'node:fs';
import { AgentClientError, type ShellHandlers } from '@rka/agent-client';
import { SHELL_DIALOG_TIMEOUT_MS, type ParsedEvent } from '@rka/agent-protocol';
import { IpcChannels, IpcEvents, type AppInfo } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { type InvokeEventLike, type IpcMainLike } from './ipc.js';
import {
  SERVICE_DIALOG_TIMEOUT_MS,
  SERVICE_REQUEST_TIMEOUT_MS,
  SERVICE_ROUTES,
  SERVICE_TOOLS_TIMEOUT_MS,
} from './service-ipc.js';
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

type RequestFn = (method: string, params?: unknown, options?: unknown) => Promise<unknown>;

/** A settings view, as far as the shell reads it. */
const viewOf = (backupDirectory: string | null) =>
  ({
    values: { 'backup.defaultDirectory': backupDirectory },
    encryptionAvailable: false,
  }) as never;

const defaultReply: RequestFn = (method) =>
  Promise.resolve(method === 'settings.get' ? viewOf('C:\\saved') : { from: method });

/** A stand-in for safeStorage: reversible, and never the identity. */
function fakeCipher(available = true) {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`)),
    decryptString: vi.fn((encrypted: Buffer) => {
      const text = encrypted.toString();
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
      return text.slice(4);
    }),
  };
}

async function setup(
  request = vi.fn<RequestFn>(defaultReply),
  cipher: ReturnType<typeof fakeCipher> = fakeCipher(),
) {
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
    serve: vi.fn<(handlers: ShellHandlers) => void>(),
    close: vi.fn(),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  const broadcast = vi.fn();
  const ports = fakePorts();
  const started = await startServiceShell({
    ipc,
    agent: { client: client as never, summary: 'test agent' },
    getAppInfo: () => appInfo,
    isTrustedSender: (url) => url === APP_URL,
    broadcast,
    ports,
    cipher,
    onQuit: (listener) => quitListeners.push(listener),
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
  return {
    handlers,
    invoke,
    request,
    client,
    log,
    quitListeners,
    close,
    broadcast,
    push,
    ports,
    cipher,
    settings: started.settings,
  };
}

function fakePorts() {
  return {
    chooseBackupPath: vi.fn(() => Promise.resolve<string | null>('C:\\backups\\rka.db')),
    chooseFile: vi.fn(() => Promise.resolve<string | null>(null)),
    chooseFolder: vi.fn((current: string | null) => Promise.resolve(current)),
    openExternal: vi.fn((url: string) =>
      url.startsWith('https://') ? Promise.resolve() : Promise.reject(new Error('Refused')),
    ),
  };
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
    expect(Object.keys(SERVICE_ROUTES)).toHaveLength(41);
  });

  it('proxies Research Tools and backup with timeouts that outlast a dialog', async () => {
    const { invoke, request } = await setup();
    await invoke(IpcChannels.storageBackup);
    await invoke(IpcChannels.researchPickFile);
    await invoke(IpcChannels.researchSearch, { requestId: 'r1', query: 'solar wind' });
    await invoke(IpcChannels.researchFetch, { requestId: 'r2', url: 'https://example.com/' });
    await invoke(IpcChannels.researchOpenUrl, { url: 'https://example.com/' });
    await invoke(IpcChannels.researchStatus);
    expect(request.mock.calls).toEqual([
      ['storage.backup', {}, { timeoutMs: SERVICE_DIALOG_TIMEOUT_MS }],
      ['researchTools.pickFile', {}, { timeoutMs: SERVICE_DIALOG_TIMEOUT_MS }],
      ['researchTools.search', expect.any(Object), { timeoutMs: SERVICE_TOOLS_TIMEOUT_MS }],
      ['researchTools.fetchUrl', expect.any(Object), { timeoutMs: SERVICE_TOOLS_TIMEOUT_MS }],
      ['researchTools.openUrl', expect.any(Object), { timeoutMs: SERVICE_TOOLS_TIMEOUT_MS }],
      ['researchTools.status', {}, { timeoutMs: SERVICE_TOOLS_TIMEOUT_MS }],
    ]);
    expect(SERVICE_DIALOG_TIMEOUT_MS).toBeGreaterThan(SHELL_DIALOG_TIMEOUT_MS);
  });

  it('answers the agent dialog, link and secret requests with the Electron ports', async () => {
    const { client, ports } = await setup();
    expect(client.serve).toHaveBeenCalledTimes(1);
    const served = client.serve.mock.calls[0]?.[0];
    if (!served) throw new Error('not served');
    await expect(served['shell.chooseBackupPath']?.({})).resolves.toEqual({
      path: 'C:\\backups\\rka.db',
    });
    await expect(served['shell.chooseFile']?.({})).resolves.toEqual({ path: null });
    await expect(served['shell.chooseFolder']?.({ defaultPath: 'C:\\x' })).resolves.toEqual({
      path: 'C:\\x',
    });
    await expect(served['shell.openExternal']?.({ url: 'https://example.com/' })).resolves.toBe(
      null,
    );
    await expect(served['shell.openExternal']?.({ url: 'http://example.com/' })).rejects.toThrow();
    expect(ports.openExternal).toHaveBeenCalledTimes(2);
    // The agent sends the stored ciphertext; only this shell can decrypt it (Phase 7).
    const ciphertext = Buffer.from('enc:token-1').toString('base64');
    expect(await served['shell.getSecret']?.({ key: 'ollama.authToken', ciphertext })).toEqual({
      value: 'token-1',
    });
    const garbage = Buffer.from('not ours').toString('base64');
    expect(
      await served['shell.getSecret']?.({ key: 'ollama.authToken', ciphertext: garbage }),
    ).toEqual({ value: null });
    expect(await served['shell.encryptionAvailable']?.({})).toEqual({ available: true });
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

  it('routes every renderer channel: nothing is left unavailable in service mode (Phase 7)', () => {
    const local = [
      IpcChannels.appGetInfo,
      IpcChannels.chatStart,
      IpcChannels.chatStop,
      IpcChannels.settingsSetSecret,
    ];
    expect([...Object.keys(SERVICE_ROUTES), ...local].sort()).toEqual(
      Object.values(IpcChannels).sort(),
    );
  });

  it('proxies Settings and Ollama to the agent with fitting timeouts', async () => {
    const { invoke, request } = await setup();
    await invoke(IpcChannels.settingsUpdate, { 'model.name': 'qwen3:8b' });
    await invoke(IpcChannels.settingsReset, { keys: ['model.name'] });
    await invoke(IpcChannels.settingsChooseBackupFolder);
    await invoke(IpcChannels.settingsTestSearxng, { url: 'http://127.0.0.1:8080' });
    await invoke(IpcChannels.ollamaConnect);
    await invoke(IpcChannels.ollamaTestModel, { name: 'qwen3:8b', prompt: 'Say OK.' });
    expect(request.mock.calls).toEqual([
      ['settings.update', { 'model.name': 'qwen3:8b' }, { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS }],
      ['settings.reset', { keys: ['model.name'] }, { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS }],
      ['settings.chooseBackupFolder', {}, { timeoutMs: SERVICE_DIALOG_TIMEOUT_MS }],
      ['settings.testSearxng', expect.any(Object), { timeoutMs: SERVICE_TOOLS_TIMEOUT_MS }],
      ['model.connect', {}, { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS }],
      ['model.testModel', expect.any(Object), { timeoutMs: SERVICE_TOOLS_TIMEOUT_MS }],
    ]);
  });

  it('adds its own encryption availability to every settings view and remembers the backup folder', async () => {
    const { invoke, settings, push, broadcast } = await setup(
      vi.fn<RequestFn>((method) =>
        Promise.resolve(
          method === 'settings.get'
            ? viewOf('C:\\saved')
            : { status: 'saved', view: viewOf('D:\\new'), changed: [], warnings: [] },
        ),
      ),
    );
    // Learned at startup (the agent holds no key, so its views say false).
    expect(settings.backupDirectory()).toBe('C:\\saved');
    await expect(invoke(IpcChannels.settingsGet)).resolves.toMatchObject({
      encryptionAvailable: true,
    });
    await expect(invoke(IpcChannels.settingsUpdate, {})).resolves.toMatchObject({
      view: { encryptionAvailable: true },
    });
    expect(settings.backupDirectory()).toBe('D:\\new');
    push({
      id: 'e1',
      method: 'ui.settingsChanged',
      payload: { changed: ['model.name'], view: viewOf('E:\\pushed') },
    } as never);
    expect(broadcast).toHaveBeenCalledWith(
      IpcEvents.settingsChanged,
      expect.objectContaining({ view: expect.objectContaining({ encryptionAvailable: true }) }),
    );
    expect(settings.backupDirectory()).toBe('E:\\pushed');
  });

  it('encrypts a new token here and sends the agent only its ciphertext', async () => {
    const { invoke, request, cipher } = await setup(
      vi.fn<RequestFn>(() =>
        Promise.resolve({ status: 'saved', view: viewOf(null), changed: [], warnings: [] }),
      ),
    );
    await expect(
      invoke(IpcChannels.settingsSetSecret, { key: 'ollama.authToken', value: '  tok-123  ' }),
    ).resolves.toMatchObject({ status: 'saved', view: { encryptionAvailable: true } });
    expect(cipher.encryptString).toHaveBeenCalledWith('tok-123');
    expect(request.mock.calls).toEqual([
      [
        'settings.storeSecret',
        { key: 'ollama.authToken', ciphertext: Buffer.from('enc:tok-123').toString('base64') },
        { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS },
      ],
    ]);
    expect(JSON.stringify(request.mock.calls)).not.toContain('tok-123');

    // Clearing the token sends no ciphertext at all.
    request.mockClear();
    await invoke(IpcChannels.settingsSetSecret, { key: 'ollama.authToken', value: '' });
    expect(request.mock.calls[0]?.[1]).toEqual({ key: 'ollama.authToken', ciphertext: null });
  });

  it('refuses an unsafe token before anything is encrypted or sent', async () => {
    const { invoke, request, cipher } = await setup();
    await expect(
      invoke(IpcChannels.settingsSetSecret, { key: 'ollama.authToken', value: 'has space' }),
    ).resolves.toMatchObject({ status: 'invalid' });
    await expect(
      invoke(IpcChannels.settingsSetSecret, { key: 'other', value: 'x' }),
    ).rejects.toThrow();
    expect(cipher.encryptString).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    const locked = await setup(undefined, fakeCipher(false));
    await expect(
      locked.invoke(IpcChannels.settingsSetSecret, { key: 'ollama.authToken', value: 'tok' }),
    ).resolves.toMatchObject({ status: 'failed', message: expect.stringMatching(/encryption/) });
    expect(locked.request).not.toHaveBeenCalled();
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
      'service-shell-ports.ts',
      'service-settings.ts',
      'agent-transport.ts',
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/from '(@rka\/storage|\.\/app-storage\.js)'/);
    }
  });
});
