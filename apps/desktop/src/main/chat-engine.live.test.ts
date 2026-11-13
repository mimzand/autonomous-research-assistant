/**
 * Live Chat engine comparison (phase 6): the legacy and ADK engines through
 * the same main-process Chat path (ChatController → engine → OllamaProvider)
 * against the configured Ollama server and model. Compares protocol
 * behaviour, not wording. Uses a temporary database; never pulls a model.
 *
 *   pnpm test:chat:ollama
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '@rka/agent-runtime';
import {
  createOllamaProvider,
  loadOllamaConfig,
  type OllamaConfig,
  ollamaTransportOptionsFromEnv,
} from '@rka/model-provider';
import { type ChatEvent, type ChatTurn } from '@rka/shared';
import { openStorage } from '@rka/storage';
import { createToolRegistry } from '@rka/tools';
import { afterAll, describe, expect, it } from 'vitest';
import { chatUsageRecorder } from './app-storage.js';
import { ChatController, type ChatEventSink } from './chat.js';
import { AGENT_ENGINE_ENV, createAppChatEngines, type AgentEngine } from './chat-engine.js';
/** Trusted ngrok tunnels from OLLAMA_NGROK_BYPASS_HOSTS (same rule as the app). */
const liveTransport = {
  ngrokBypassHosts: ollamaTransportOptionsFromEnv(process.env).ngrokBypassHosts,
};

const base = loadOllamaConfig(process.env);
const dir = mkdtempSync(join(tmpdir(), 'rka-chat-live-'));
const storage = openStorage({ path: join(dir, 'chat-live.db') });
afterAll(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

const ENGINES: readonly AgentEngine[] = ['legacy', 'adk'];
const log = (label: string, value: unknown) =>
  console.info(`[chat-live] ${label}: ${JSON.stringify(value)}`);

function wire(engine: AgentEngine, config: Partial<OllamaConfig> = {}) {
  const provider = createOllamaProvider({ ...base, ...config }, liveTransport);
  const runtime = createAgentRuntime({
    modelProvider: provider,
    tools: createToolRegistry([]),
    storage,
  });
  const chat = new ChatController({
    runtime,
    onUsage: chatUsageRecorder(storage),
    selectEngine: createAppChatEngines({
      runtime,
      provider,
      env: { [AGENT_ENGINE_ENV]: engine },
      log: () => undefined,
    }),
  });
  const events: ChatEvent[] = [];
  const sink: ChatEventSink = { id: 1, isDestroyed: () => false, send: (e) => events.push(e) };
  const start = (messages: ChatTurn[]) => {
    const result = chat.start(sink, { messages });
    if (result.status !== 'started') throw new Error(result.message);
    return result.streamId;
  };
  return { chat, events, start };
}

const textOf = (events: ChatEvent[]) =>
  events.map((e) => (e.type === 'delta' ? e.content : '')).join('');
const types = (events: ChatEvent[]) => [...new Set(events.map((e) => e.type))];

/** Protocol shape of a completed reply: deltas, then exactly one done, nothing after. */
function expectCompleted(events: ChatEvent[], engine: AgentEngine) {
  const last = events.at(-1);
  expect(last?.type, engine).toBe('done');
  expect(
    events.filter((e) => e.type === 'done'),
    engine,
  ).toHaveLength(1);
  expect(
    events.slice(0, -1).every((e) => e.type === 'delta'),
    engine,
  ).toBe(true);
  expect(textOf(events).trim().length, engine).toBeGreaterThan(0);
  if (last?.type === 'done') {
    expect(last.model, engine).toBe(base.model);
    expect(last.completionTokens, engine).toBeGreaterThan(0);
  }
}

describe(`live Chat engines at ${base.baseUrl} (${base.model})`, () => {
  for (const engine of ENGINES) {
    it(`${engine}: simple prompt, streamed in several deltas`, async () => {
      const w = wire(engine);
      w.start([{ role: 'user', content: 'Name three primary colours, comma-separated.' }]);
      await w.chat.whenIdle();
      log(`${engine} simple`, { text: textOf(w.events), deltas: w.events.length - 1 });
      expectCompleted(w.events, engine);
      expect(w.events.filter((e) => e.type === 'delta').length, engine).toBeGreaterThan(1);
    });

    it(`${engine}: multi-turn conversation supplied by the renderer`, async () => {
      const w = wire(engine);
      w.start([
        { role: 'user', content: 'Remember this code word: PELICAN. Reply only "OK".' },
        { role: 'assistant', content: 'OK' },
        { role: 'user', content: 'What was the code word? Answer with the word only.' },
      ]);
      await w.chat.whenIdle();
      log(`${engine} multi-turn`, { text: textOf(w.events) });
      expectCompleted(w.events, engine);
      expect(textOf(w.events), engine).toMatch(/pelican/i);
    });

    it(`${engine}: cancellation after the first delta`, async () => {
      const w = wire(engine);
      const id = w.start([
        { role: 'user', content: 'Write a long essay about the history of maps.' },
      ]);
      while (!w.events.some((e) => e.type === 'delta')) {
        if (w.events.some((e) => e.type !== 'delta')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      w.chat.stop({ streamId: id });
      await w.chat.whenIdle();
      log(`${engine} cancel`, { types: types(w.events) });
      expect(w.events.at(-1), engine).toEqual({ type: 'cancelled', streamId: id });
      expect(
        w.events.some((e) => e.type === 'done' || e.type === 'error'),
        engine,
      ).toBe(false);
    });

    it(`${engine}: runtime configuration (token limit) is applied`, async () => {
      const w = wire(engine, { generation: { ...base.generation, numPredict: 8, temperature: 0 } });
      w.start([{ role: 'user', content: 'Write a long essay about the history of maps.' }]);
      await w.chat.whenIdle();
      const done = w.events.at(-1);
      log(`${engine} numPredict=8`, { done });
      expect(done, engine).toMatchObject({ type: 'done', finishReason: 'length' });
      if (done?.type === 'done') expect(done.completionTokens ?? 0, engine).toBeLessThanOrEqual(8);
    });

    it(`${engine}: a missing model is reported as model-not-found (nothing is downloaded)`, async () => {
      const w = wire(engine, { model: 'rka-live-test-missing-model:0' });
      w.start([{ role: 'user', content: 'Hi' }]);
      await w.chat.whenIdle();
      log(`${engine} missing model`, { events: w.events });
      expect(w.events, engine).toEqual([
        expect.objectContaining({ type: 'error', code: 'model-not-found' }),
      ]);
    });
  }
});
