import { type ResearchEvent } from '@rka/agent-runtime';
import { createOllamaProvider, loadOllamaConfig, type FetchLike } from '@rka/model-provider';
import { type ChatEvent, type ResearchProgressEvent } from '@rka/shared';
import { openStorage } from '@rka/storage';
import { createReconfigurableWebServices, loadWebConfig } from '@rka/tools';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentHost,
  forwardResearchProgress,
  type AgentHostPorts,
  type AgentHostSettings,
} from './agent-host.js';
import { type ChatEventSink, type ChatUsage } from './chat-controller.js';

const MODEL = 'qwen3:8b';

/** A scripted Ollama: every /api/chat streams "Hi" then a done line. */
const ollamaFetch: FetchLike = (input) => {
  if (new URL(input).pathname !== '/api/chat') {
    return Promise.resolve(new Response('', { status: 404 }));
  }
  const lines = [
    { model: MODEL, message: { role: 'assistant', content: 'Hi' }, done: false },
    {
      model: MODEL,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 4,
      eval_count: 1,
      total_duration: 1_000_000,
      load_duration: 0,
    },
  ];
  return Promise.resolve(
    new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), {
      headers: { 'content-type': 'application/x-ndjson' },
    }),
  );
};

function setup(overrides: Partial<AgentHostSettings> = {}) {
  const ports = {
    emitResearchProgress: vi.fn(),
    chooseBackupPath: vi.fn(() => Promise.resolve(null)),
    chooseFile: vi.fn(() => Promise.resolve(null)),
    openExternal: vi.fn(() => Promise.resolve()),
  } satisfies AgentHostPorts;
  const settings: AgentHostSettings = {
    researchDefaults: vi.fn(() => ({})),
    chatEngine: vi.fn(() => 'legacy'),
    researchEngine: vi.fn(() => 'legacy'),
    chatWebSearch: vi.fn(() => false),
    ...overrides,
  };
  const usage: ChatUsage[] = [];
  const host = createAgentHost({
    storage: openStorage({ path: ':memory:' }),
    modelProvider: createOllamaProvider(
      loadOllamaConfig({ OLLAMA_HOST: '127.0.0.1:9', OLLAMA_MODEL: MODEL }),
      { fetch: ollamaFetch },
    ),
    webServices: createReconfigurableWebServices(loadWebConfig({})),
    settings,
    ports,
    onChatUsage: (u) => usage.push(u),
  });
  return { host, ports, settings, usage };
}

describe('createAgentHost', () => {
  it('registers the web research tools on the shared registry', () => {
    const { host } = setup();
    expect(host.tools.list().map((t) => t.name)).toEqual(
      expect.arrayContaining(['web_search', 'fetch_source']),
    );
  });

  it('reads no setting while composing (each is read when it is needed)', () => {
    const { settings } = setup();
    for (const read of Object.values(settings)) expect(read).not.toHaveBeenCalled();
  });

  it('routes Chat through the selected engine, reads the flags per request and reports usage', async () => {
    const { host, settings, usage } = setup();
    const events: ChatEvent[] = [];
    const sink: ChatEventSink = { id: 1, isDestroyed: () => false, send: (e) => events.push(e) };
    host.chat.start(sink, { messages: [{ role: 'user', content: 'Hello' }] });
    await host.chat.whenIdle();
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
    expect(settings.chatEngine).toHaveBeenCalledTimes(1);
    expect(settings.chatWebSearch).toHaveBeenCalledTimes(1);
    expect(usage).toEqual([expect.objectContaining({ model: MODEL, completionTokens: 1 })]);
  });

  it('uses the injected dialogs and browser port, never anything else', async () => {
    const { host, ports } = setup();
    await expect(host.dashboard.backup()).resolves.toEqual({ status: 'cancelled' });
    expect(ports.chooseBackupPath).toHaveBeenCalledTimes(1);
    await expect(host.researchTools.pickFile()).resolves.toEqual({ status: 'cancelled' });
    expect(ports.chooseFile).toHaveBeenCalledTimes(1);
    // Not seen in a search or fetch: refused before the port is asked.
    await expect(
      host.researchTools.openUrl({ url: 'https://example.org/' }),
    ).resolves.toMatchObject({ status: 'refused' });
    expect(ports.openExternal).not.toHaveBeenCalled();
  });
});

describe('forwardResearchProgress', () => {
  const valid: ResearchProgressEvent = {
    type: 'step-started',
    taskId: 'task-1',
    taskStatus: 'running',
    progress: { completed: 1, total: 5, estimated: true, current: null },
  };

  it('emits events that match the shared contract', () => {
    const emit = vi.fn();
    forwardResearchProgress(emit)(valid as unknown as ResearchEvent);
    expect(emit).toHaveBeenCalledWith(valid);
  });

  it('drops events that do not match the contract', () => {
    const emit = vi.fn();
    forwardResearchProgress(emit)({ ...valid, taskStatus: 'exploded' } as unknown as ResearchEvent);
    expect(emit).not.toHaveBeenCalled();
  });
});
