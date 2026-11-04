import { type AgentRuntime } from '@rka/agent-runtime';
import { IpcChannels, type AppInfo } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { registerIpcHandlers, type InvokeEventLike, type IpcMainLike } from './ipc.js';

type Listener = (event: InvokeEventLike, ...args: unknown[]) => unknown;

function setup(overrides: Partial<{ health: unknown; appInfo: unknown }> = {}) {
  const handlers = new Map<string, Listener>();
  const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };

  const runtime: AgentRuntime = {
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
  };

  const appInfo: AppInfo = {
    name: 'rka',
    version: '0.0.0',
    platform: 'win32',
    versions: { electron: '45.2.2', chrome: '1', node: '24' },
  };

  registerIpcHandlers(ipc, {
    runtime,
    getAppInfo: () => (overrides.appInfo ?? appInfo) as AppInfo,
    isTrustedSender: (url) => url.startsWith('file://'),
  });

  const invoke = (channel: string, url: string | null) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ senderFrame: url === null ? null : { url } });
  };

  return { handlers, invoke };
}

describe('registerIpcHandlers', () => {
  it('registers exactly the channels in the shared contract', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(Object.values(IpcChannels).sort());
  });

  it('serves trusted senders', async () => {
    const { invoke } = setup();
    await expect(invoke(IpcChannels.appGetInfo, 'file:///app/index.html')).resolves.toMatchObject({
      name: 'rka',
    });
    await expect(
      invoke(IpcChannels.modelGetHealth, 'file:///app/index.html'),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('rejects untrusted or missing senders', async () => {
    const { invoke } = setup();
    await expect(invoke(IpcChannels.appGetInfo, 'https://evil.example')).rejects.toThrow(
      /untrusted/,
    );
    await expect(invoke(IpcChannels.modelGetHealth, null)).rejects.toThrow(/untrusted/);
  });

  it('refuses to send responses that break the contract', async () => {
    const { invoke } = setup({ health: { status: 'ready', provider: 'openai' } });
    await expect(invoke(IpcChannels.modelGetHealth, 'file:///app/index.html')).rejects.toThrow();
  });
});
