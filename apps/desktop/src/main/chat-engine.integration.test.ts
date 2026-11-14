/**
 * Phase 6: Chat engines at the Electron main-process boundary.
 *
 * Same wiring as main/index.ts: IPC handlers (registerIpcHandlers) →
 * ChatController → engine selected by the `agent.engine` flag → the real
 * OllamaProvider → HTTP to a local fake Ollama server. Every scenario runs
 * through both engines and compares what the renderer would receive (IPC
 * events) and what Ollama receives (HTTP requests).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdkRuntime, type AdkRuntime } from '@rka/adk-runtime';
import { createAgentRuntime } from '@rka/agent-runtime';
import { createOllamaProvider, loadOllamaConfig, type OllamaConfig } from '@rka/model-provider';
import {
  ChatEventSchema,
  ChatStartResultSchema,
  IpcChannels,
  IpcEvents,
  type ChatEvent,
  type ChatTurn,
} from '@rka/shared';
import { openStorage, type Storage } from '@rka/storage';
import { createToolRegistry } from '@rka/tools';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chatUsageRecorder } from './app-storage.js';
import { createRuntimeConfig } from './config/runtime-config.js';
import { ChatController } from './chat.js';
import { AGENT_ENGINE_ENV, createAppChatEngines, type AgentEngine } from './chat-engine.js';
import { registerIpcHandlers, type InvokeEventLike, type IpcMainLike } from './ipc.js';

const ENGINES: readonly AgentEngine[] = ['legacy', 'adk'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- fake Ollama ---------------------------------------------------------------

interface Recorded {
  aborted?: boolean;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}
type Handler = (
  body: Record<string, unknown>,
  res: ServerResponse,
  n: number,
) => void | Promise<void>;

let server: Server;
let baseHost: string;
let handler: Handler;
let recorded: Recorded[] = [];

const line = (content: string, done = false, extra: Record<string, unknown> = {}) => ({
  model: 'qwen3:8b',
  created_at: '2026-11-13T10:00:00Z',
  message: { role: 'assistant', content, ...extra },
  done,
  ...(done && {
    done_reason: 'stop',
    prompt_eval_count: 12,
    eval_count: 7,
    total_duration: 2_000_000_000,
    load_duration: 100_000_000,
  }),
});

async function stream(res: ServerResponse, lines: unknown[], delayMs = 10): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const l of lines) {
    if (res.destroyed) return;
    res.write(`${JSON.stringify(l)}\n`);
    await sleep(delayMs);
  }
  if (!res.destroyed) res.end();
}

const reply =
  (words: string[], delayMs = 10): Handler =>
  (_b, res) =>
    stream(res, [...words.map((w) => line(w)), line('', true)], delayMs);

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    res.setHeader('connection', 'close');
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const entry: Recorded = {
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      };
      recorded.push(entry);
      res.on('close', () => {
        if (!res.writableEnded) {
          entry.aborted = true;
        }
      });
      void handler(body, res, recorded.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  recorded = [];
  vi.restoreAllMocks();
});

// --- the app's Chat wiring, as in main/index.ts --------------------------------------

interface HarnessOptions {
  readonly engine?: string | undefined;
  readonly host?: string;
  readonly config?: Partial<OllamaConfig>;
  readonly loadAdk?: () => Promise<AdkRuntime>;
  /** Phase 7.4.2: the engine comes from Settings (RuntimeConfig with this environment), as in main/index.ts. */
  readonly settingsEnv?: NodeJS.ProcessEnv;
}

function harness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rka-chat-engine-'));
  const storage: Storage = openStorage({ path: join(dir, 'research.db') });
  cleanups.push(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const provider = createOllamaProvider(
    { ...loadOllamaConfig({ OLLAMA_HOST: options.host ?? baseHost }), ...options.config },
    { getAuthToken: () => 'local-test-token' },
  );
  const runtime = createAgentRuntime({
    modelProvider: provider,
    tools: createToolRegistry([]),
    storage,
  });
  const legacyCalls = vi.fn();
  const env: Record<string, string | undefined> = { [AGENT_ENGINE_ENV]: options.engine };
  const logs: string[] = [];
  const settings = options.settingsEnv
    ? createRuntimeConfig({
        storage,
        env: options.settingsEnv,
        encryptionAvailable: () => false,
        warn: (m) => logs.push(m),
      })
    : undefined;
  const selectEngine = createAppChatEngines({
    runtime: {
      streamChat: (turns, o) => {
        legacyCalls();
        return runtime.streamChat(turns, o);
      },
    },
    provider,
    env,
    ...(settings && { readFlag: () => settings.getSettings()['engine.chat'] }),
    log: (m) => logs.push(m),
    ...(options.loadAdk && { loadAdk: options.loadAdk }),
  });
  const chat = new ChatController({ runtime, onUsage: chatUsageRecorder(storage), selectEngine });

  const handlers = new Map<string, (event: InvokeEventLike, ...args: unknown[]) => unknown>();
  const ipc: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) };
  registerIpcHandlers(ipc, {
    runtime,
    chat,
    dashboard: {} as never,
    researchTools: {} as never,
    settings: {} as never,
    getAppInfo: () => ({}) as never,
    isTrustedSender: (url) => url.startsWith('file://'),
  });
  const events: ChatEvent[] = [];
  const destroyed: (() => void)[] = [];
  let senderDestroyed = false;
  const sender = {
    id: 7,
    isDestroyed: () => senderDestroyed,
    send: (channel: string, event: unknown) => {
      expect(channel).toBe(IpcEvents.chatEvent);
      events.push(ChatEventSchema.parse(event)); // the preload's validation
    },
    once: (_e: 'destroyed', listener: () => void) => void destroyed.push(listener),
  };
  const invoke = (channel: string, payload?: unknown) => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h({ senderFrame: { url: 'file:///app/index.html', parent: null }, sender }, payload);
  };
  const start = async (messages: ChatTurn[]) =>
    ChatStartResultSchema.parse(await invoke(IpcChannels.chatStart, { messages }));
  const stop = (streamId: string) => invoke(IpcChannels.chatStop, { streamId });
  const run = async (messages: ChatTurn[]) => {
    const result = await start(messages);
    await chat.whenIdle();
    return result;
  };
  const closeWindow = () => {
    senderDestroyed = true;
    destroyed.forEach((fn) => fn());
  };
  return {
    storage,
    provider,
    chat,
    env,
    settings,
    logs,
    legacyCalls,
    events,
    start,
    stop,
    run,
    closeWindow,
  };
}

/** Events with the (random) stream id normalised, for comparing engines. */
const normal = (events: ChatEvent[]) => events.map((e) => ({ ...e, streamId: 'S' }));
const textOf = (events: ChatEvent[]) =>
  events.map((e) => (e.type === 'delta' ? e.content : '')).join('');
const chatBodies = () => recorded.filter((r) => r.url === '/api/chat').map((r) => r.body);

/** Runs the same scenario on both engines and returns what each produced. */
async function both(
  scenario: (h: ReturnType<typeof harness>) => Promise<void>,
  options: HarnessOptions = {},
) {
  const out: Record<
    AgentEngine,
    { events: ChatEvent[]; requests: Recorded[]; legacyCalls: number }
  > = {} as never;
  for (const engine of ENGINES) {
    recorded = [];
    const h = harness({ ...options, engine });
    await scenario(h);
    out[engine] = {
      events: h.events,
      // What was sent (whether the server finished writing before the client closed is timing).
      requests: recorded.map(({ url, authorization, body }) => ({ url, authorization, body })),
      legacyCalls: h.legacyCalls.mock.calls.length,
    };
  }
  return out;
}

const HISTORY: ChatTurn[] = [
  { role: 'user', content: 'سلام! My name is Morteza.' },
  { role: 'assistant', content: 'Hello Morteza 👋 — نام شما ثبت شد.' },
  { role: 'user', content: '  leading and trailing spaces  ' },
  { role: 'user', content: 'Two user turns in a row.' },
  { role: 'assistant', content: 'Noted.\n\nSecond paragraph.' },
  { role: 'user', content: 'What is my name? 名字' },
];

// --- A. flag ------------------------------------------------------------------------

describe('A. the flag: legacy is the default', () => {
  it('no flag, an empty flag and an unknown flag all use the legacy engine', async () => {
    for (const engine of [undefined, '', 'ADK2', 'gemini']) {
      handler = reply(['ok']);
      const h = harness({ engine });
      await h.run([{ role: 'user', content: 'Hi' }]);
      expect(h.legacyCalls).toHaveBeenCalledTimes(1);
      expect(textOf(h.events)).toBe('ok');
    }
  });

  it('logs the selection and a warning for an unknown value', async () => {
    handler = reply(['ok']);
    const h = harness({ engine: 'turbo' });
    await h.run([{ role: 'user', content: 'Hi' }]);
    expect(h.logs).toEqual([expect.stringMatching(/Ignoring AGENT_ENGINE="turbo".*legacy/)]);
    const a = harness({ engine: ' ADK ' });
    await a.run([{ role: 'user', content: 'Hi' }]);
    expect(a.logs).toEqual(['Chat engine: adk']);
    expect(a.legacyCalls).not.toHaveBeenCalled();
  });
});

// --- B/C/D/O. responses and streaming through the IPC contract ----------------------

describe('B/C/D/O. same IPC events and the same Ollama request from both engines', () => {
  it('a streamed plain-text reply (Unicode, empty deltas): identical events, usage and request', async () => {
    handler = (_b, res) =>
      stream(res, [line('Hel'), line(''), line('lo 👋'), line(' — سلام 世界'), line('', true)]);
    const out = await both(async (h) => {
      const result = await h.run([{ role: 'user', content: 'Hi' }]);
      expect(result).toMatchObject({ status: 'started', model: 'qwen3:8b' });
    });
    expect(normal(out.adk.events)).toEqual(normal(out.legacy.events));
    expect(normal(out.adk.events)).toEqual([
      { type: 'delta', streamId: 'S', content: 'Hel' },
      { type: 'delta', streamId: 'S', content: 'lo 👋' },
      { type: 'delta', streamId: 'S', content: ' — سلام 世界' },
      {
        type: 'done',
        streamId: 'S',
        model: 'qwen3:8b',
        finishReason: 'stop',
        completionTokens: 7,
        totalDurationMs: 2000,
      },
    ]);
    // Byte-identical request: same model, options, think flag, auth, no tools, no system prompt.
    expect(out.adk.requests).toEqual(out.legacy.requests);
    expect(out.adk.legacyCalls).toBe(0);
  });

  it('the final text is never appended after the streamed text (no duplicates)', async () => {
    handler = reply(['One', ' two', ' three.']);
    const out = await both((h) =>
      h.run([{ role: 'user', content: 'Count' }]).then(() => undefined),
    );
    expect(textOf(out.adk.events)).toBe('One two three.');
    expect(out.adk.events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('a reply delivered in a single line', async () => {
    handler = (_b, res) => stream(res, [{ ...line('All at once.', true) }]);
    const out = await both((h) => h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined));
    expect(normal(out.adk.events)).toEqual(normal(out.legacy.events));
    expect(textOf(out.adk.events)).toBe('All at once.');
  });

  it('an empty reply', async () => {
    handler = (_b, res) => stream(res, [line('', true)]);
    const out = await both((h) => h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined));
    expect(normal(out.adk.events)).toEqual(normal(out.legacy.events));
    expect(out.adk.events.map((e) => e.type)).toEqual(['done']);
  });

  it('records the same chat usage row for both engines', async () => {
    handler = reply(['ok']);
    const rows: unknown[] = [];
    for (const engine of ENGINES) {
      const h = harness({ engine });
      await h.run([{ role: 'user', content: 'Hi' }]);
      const usage = h.storage.sqlite
        .prepare(
          'select provider, purpose, model, prompt_tokens, completion_tokens, total_duration_ms, load_duration_ms from model_usage',
        )
        .all();
      rows.push(usage);
    }
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[0]).toEqual([
      expect.objectContaining({
        purpose: 'chat',
        model: 'qwen3:8b',
        prompt_tokens: 12,
        completion_tokens: 7,
      }),
    ]);
  });
});

// --- E/F/G. stateless history ------------------------------------------------------------

describe('E/F/G. renderer-supplied history', () => {
  it('multi-turn history reaches Ollama exactly as with legacy; the current message appears once', async () => {
    handler = reply(['Morteza.']);
    const out = await both((h) => h.run(HISTORY).then(() => undefined));
    const [adk] = out.adk.requests.map((r) => r.body);
    const [legacy] = out.legacy.requests.map((r) => r.body);
    expect(adk).toEqual(legacy);
    expect(adk?.['messages']).toEqual(HISTORY);
    const current = HISTORY.at(-1)?.content;
    expect((adk?.['messages'] as ChatTurn[]).filter((m) => m.content === current)).toHaveLength(1);
  });

  it('two requests do not share ADK session state', async () => {
    handler = reply(['ok']);
    const h = harness({ engine: 'adk' });
    await h.run([{ role: 'user', content: 'Secret: PELICAN' }]);
    await h.run([{ role: 'user', content: 'What was the secret?' }]);
    expect(chatBodies().map((b) => b['messages'])).toEqual([
      [{ role: 'user', content: 'Secret: PELICAN' }],
      [{ role: 'user', content: 'What was the secret?' }],
    ]);
  });

  it('an exactly-empty earlier turn is refused with "unsupported" rather than silently dropped', async () => {
    handler = reply(['ok']);
    const h = harness({ engine: 'adk' });
    await h.run([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Again' },
    ]);
    expect(normal(h.events)).toEqual([
      {
        type: 'error',
        streamId: 'S',
        code: 'unsupported',
        message: 'The ADK chat engine cannot send empty messages in the conversation history.',
      },
    ]);
    expect(chatBodies()).toEqual([]);
  });
});

// --- H. cancellation -----------------------------------------------------------------

describe('H. cancellation', () => {
  it('stop right after start (before generation): cancelled, no deltas, no usage', async () => {
    handler = reply(['never'], 50);
    const out = await both(async (h) => {
      const r = await h.start([{ role: 'user', content: 'Hi' }]);
      if (r.status !== 'started') throw new Error('not started');
      await h.stop(r.streamId);
      await h.chat.whenIdle();
      expect(h.storage.sqlite.prepare('select count(*) as n from model_usage').get()).toEqual({
        n: 0,
      });
      expect(h.chat.activeStreamId).toBeUndefined();
    });
    expect(normal(out.adk.events)).toEqual([{ type: 'cancelled', streamId: 'S' }]);
    expect(normal(out.legacy.events)).toEqual([{ type: 'cancelled', streamId: 'S' }]);
  });

  it('stop after partial output: the partial text stays, then cancelled; never done', async () => {
    handler = (_b, res) =>
      stream(
        res,
        [...Array.from({ length: 100 }, (_, i) => line(`w${String(i)} `)), line('', true)],
        15,
      );
    for (const engine of ENGINES) {
      recorded = [];
      const h = harness({ engine });
      const r = await h.start([{ role: 'user', content: 'Long essay' }]);
      if (r.status !== 'started') throw new Error('not started');
      while (!h.events.some((e) => e.type === 'delta')) await sleep(5);
      await h.stop(r.streamId);
      await h.chat.whenIdle();
      await sleep(30);
      expect(h.events.at(-1), engine).toEqual({ type: 'cancelled', streamId: r.streamId });
      expect(
        h.events.some((e) => e.type === 'done' || e.type === 'error'),
        engine,
      ).toBe(false);
      expect(h.events.filter((e) => e.type === 'delta').length, engine).toBeLessThan(50);
      expect(
        recorded.map((r) => [r.url, r.aborted]),
        engine,
      ).toEqual([['/api/chat', true]]); // aborted
      expect(h.chat.activeStreamId).toBeUndefined();
    }
  });

  it('stop while waiting for Ollama (network I/O, no response yet)', async () => {
    handler = async (_b, res) => {
      await sleep(400);
      if (!res.destroyed) await stream(res, [line('late', true)]);
    };
    const out = await both(async (h) => {
      const r = await h.start([{ role: 'user', content: 'Hi' }]);
      if (r.status !== 'started') throw new Error('not started');
      await sleep(60);
      await h.stop(r.streamId);
      await h.chat.whenIdle();
    });
    expect(normal(out.adk.events)).toEqual([{ type: 'cancelled', streamId: 'S' }]);
    expect(normal(out.legacy.events)).toEqual([{ type: 'cancelled', streamId: 'S' }]);
  });

  it('closing the window aborts the request and sends nothing more', async () => {
    handler = reply(
      Array.from({ length: 100 }, (_, i) => `w${String(i)} `),
      15,
    );
    for (const engine of ENGINES) {
      recorded = [];
      const h = harness({ engine });
      await h.start([{ role: 'user', content: 'Hi' }]);
      while (!h.events.some((e) => e.type === 'delta')) await sleep(5);
      h.closeWindow();
      const sent = h.events.length;
      await h.chat.whenIdle();
      await sleep(30);
      expect(h.events.length, engine).toBe(sent);
      expect(
        recorded.map((r) => [r.url, r.aborted]),
        engine,
      ).toEqual([['/api/chat', true]]);
      expect(h.chat.activeStreamId).toBeUndefined();
    }
  });

  it('changing the flag and the settings during a request, then cancelling it', async () => {
    handler = reply(
      Array.from({ length: 60 }, (_, i) => `w${String(i)} `),
      15,
    );
    const h = harness({ engine: 'adk' });
    const r = await h.start([{ role: 'user', content: 'Hi' }]);
    if (r.status !== 'started') throw new Error('not started');
    while (!h.events.some((e) => e.type === 'delta')) await sleep(5);
    h.env[AGENT_ENGINE_ENV] = 'legacy';
    h.provider.reconfigure({ ...h.provider.currentConfig, model: 'other-model:1b' });
    await h.stop(r.streamId);
    await h.chat.whenIdle();
    expect(h.events.at(-1)).toEqual({ type: 'cancelled', streamId: r.streamId });
    expect(h.legacyCalls).not.toHaveBeenCalled(); // the running request kept its engine

    handler = reply(['next']);
    await h.run([{ role: 'user', content: 'Next' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(1); // the next request uses the new flag
    expect(chatBodies().at(-1)?.['model']).toBe('other-model:1b');
  });
});

// --- I. errors -----------------------------------------------------------------------

describe('I. errors map to the same Chat error contract', () => {
  it('model not found', async () => {
    handler = (_b, res) =>
      void res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: "model 'qwen3:8b' not found" }));
    const out = await both((h) => h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined));
    expect(normal(out.adk.events)).toEqual(normal(out.legacy.events));
    expect(out.adk.events).toEqual([
      expect.objectContaining({ type: 'error', code: 'model-not-found' }),
    ]);
  });

  it('Ollama unavailable', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const dead = `127.0.0.1:${String((closed.address() as AddressInfo).port)}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const out = await both((h) => h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined), {
      host: dead,
    });
    expect(normal(out.adk.events)).toEqual(normal(out.legacy.events));
    expect(out.adk.events).toEqual([
      expect.objectContaining({ type: 'error', code: 'unavailable' }),
    ]);
  });

  it('stream idle timeout after partial output', async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(line('Partial'))}\n`);
      await sleep(600); // silence longer than the idle timeout
      if (!res.destroyed) res.end();
    };
    const out = await both((h) => h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined), {
      config: { streamIdleTimeoutMs: 150 },
    });
    expect(normal(out.adk.events)).toEqual(normal(out.legacy.events));
    expect(textOf(out.adk.events)).toBe('Partial');
    expect(out.adk.events.at(-1)).toMatchObject({ type: 'error', code: 'timeout' });
  });

  it('a generation that fails mid-stream, and an invalid response', async () => {
    handler = async (_b, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(line('Partial'))}\n`);
      await sleep(10);
      res.end(`${JSON.stringify({ error: 'CUDA error: out of memory' })}\n`);
    };
    const failed = await both((h) =>
      h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined),
    );
    expect(normal(failed.adk.events)).toEqual(normal(failed.legacy.events));
    expect(failed.adk.events.at(-1)).toMatchObject({ type: 'error', code: 'generation-failed' });

    handler = (_b, res) =>
      void res.writeHead(200, { 'content-type': 'application/x-ndjson' }).end('not json\n');
    const invalid = await both((h) =>
      h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined),
    );
    expect(normal(invalid.adk.events)).toEqual(normal(invalid.legacy.events));
    expect(invalid.adk.events.at(-1)).toMatchObject({ type: 'error', code: 'invalid-response' });
  });

  it('ADK cannot be loaded: a controlled error, no request to Ollama, no silent switch to legacy', async () => {
    handler = reply(['should not run']);
    const h = harness({
      engine: 'adk',
      loadAdk: () => Promise.reject(new Error('Cannot find module /secret/path/engine.js')),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await h.run([{ role: 'user', content: 'Hi' }]);
    expect(normal(h.events)).toEqual([
      {
        type: 'error',
        streamId: 'S',
        code: 'generation-failed',
        message:
          'The ADK chat engine could not be started. Choose Legacy for Chat in Settings → Agent Engines to use the legacy engine.',
      },
    ]);
    expect(JSON.stringify(h.events)).not.toContain('/secret/path');
    expect(h.legacyCalls).not.toHaveBeenCalled();
    expect(chatBodies()).toEqual([]);
  });
});

// --- J/K. settings and flag per request -------------------------------------------------

describe('J/K. runtime settings and the flag are captured per request', () => {
  it('both engines send the same effective settings (model, context, sampling, auth)', async () => {
    handler = reply(['ok']);
    const config: Partial<OllamaConfig> = {
      model: 'llama3.2:3b',
      numCtx: 4096,
      generation: { temperature: 0.2, topP: 0.8, topK: 30, numPredict: 256, repeatPenalty: 1.15 },
    };
    const out = await both((h) => h.run([{ role: 'user', content: 'Hi' }]).then(() => undefined), {
      config,
    });
    expect(out.adk.requests).toEqual(out.legacy.requests);
    expect(out.adk.requests[0]).toMatchObject({
      authorization: 'Bearer local-test-token',
      body: {
        model: 'llama3.2:3b',
        think: false,
        options: {
          num_ctx: 4096,
          temperature: 0.2,
          top_p: 0.8,
          top_k: 30,
          num_predict: 256,
          repeat_penalty: 1.15,
        },
      },
    });
  });

  it('a settings change mid-stream applies to the next request only (both engines)', async () => {
    for (const engine of ENGINES) {
      recorded = [];
      handler = reply(['a', 'b', 'c', 'd'], 40);
      const h = harness({ engine });
      await h.start([{ role: 'user', content: 'Hi' }]);
      while (!h.events.some((e) => e.type === 'delta')) await sleep(5);
      h.provider.reconfigure({ ...h.provider.currentConfig, model: 'changed:1b' });
      await h.chat.whenIdle();
      expect(h.events.at(-1), engine).toMatchObject({ type: 'done' });
      handler = reply(['x']);
      await h.run([{ role: 'user', content: 'Next' }]);
      expect(
        chatBodies().map((b) => b['model']),
        engine,
      ).toEqual(['qwen3:8b', 'changed:1b']);
    }
  });

  it('switching the flag affects only subsequent requests', async () => {
    handler = reply(['a', 'b', 'c'], 40);
    const h = harness({ engine: 'legacy' });
    await h.start([{ role: 'user', content: 'Hi' }]);
    while (!h.events.some((e) => e.type === 'delta')) await sleep(5);
    h.env[AGENT_ENGINE_ENV] = 'adk'; // switch while the legacy request runs
    await h.chat.whenIdle();
    expect(h.events.at(-1)).toMatchObject({ type: 'done' });
    expect(h.legacyCalls).toHaveBeenCalledTimes(1);

    handler = reply(['adk']);
    await h.run([{ role: 'user', content: 'Next' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(1); // served by ADK
    h.env[AGENT_ENGINE_ENV] = 'legacy'; // explicit rollback
    await h.run([{ role: 'user', content: 'Back' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(2);
    expect(h.logs).toEqual(['Chat engine: legacy', 'Chat engine: adk', 'Chat engine: legacy']);
  });
});

// --- Phase 7.4.2: the engine chosen in Settings ---------------------------------------------

describe('Phase 7.4.2. Chat engine from Settings → Agent Engines', () => {
  it('default (nothing saved, no AGENT_ENGINE): legacy', async () => {
    handler = reply(['ok']);
    const h = harness({ settingsEnv: {} });
    await h.run([{ role: 'user', content: 'Hi' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(1);
    expect(h.logs).toEqual(['Chat engine: legacy']);
  });

  it('a saved choice applies to the next request without a restart; a running reply keeps its engine', async () => {
    handler = reply(['a', 'b', 'c'], 40);
    const h = harness({ settingsEnv: {} });
    await h.start([{ role: 'user', content: 'Hi' }]);
    while (!h.events.some((e) => e.type === 'delta')) await sleep(5);
    // Settings → Save while the legacy reply is streaming.
    expect(h.settings?.updateSettings({ 'engine.chat': 'adk' })).toMatchObject({
      status: 'saved',
    });
    await h.chat.whenIdle();
    expect(normal(h.events).map((e) => e.type)).toEqual(['delta', 'delta', 'delta', 'done']);
    expect(h.legacyCalls).toHaveBeenCalledTimes(1);

    handler = reply(['adk']);
    await h.run([{ role: 'user', content: 'Next' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(1); // served by ADK
    expect(h.settings?.updateSettings({ 'engine.chat': 'legacy' })).toMatchObject({
      status: 'saved',
    });
    await h.run([{ role: 'user', content: 'Back' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(2);
    expect(h.logs).toEqual(['Chat engine: legacy', 'Chat engine: adk', 'Chat engine: legacy']);
  });

  it('cancelling a reply works the same after switching engines in Settings', async () => {
    for (const engine of ENGINES) {
      handler = reply(['a', 'b', 'c', 'd', 'e'], 60);
      const h = harness({ settingsEnv: {} });
      h.settings?.updateSettings({ 'engine.chat': engine });
      const started = await h.start([{ role: 'user', content: 'Hi' }]);
      if (started.status !== 'started') throw new Error('not started');
      while (!h.events.some((e) => e.type === 'delta')) await sleep(5);
      await h.stop(started.streamId);
      await h.chat.whenIdle();
      expect(h.events.at(-1), engine).toMatchObject({ type: 'cancelled' });
    }
  });

  it('an invalid choice is rejected and the engine in use does not change', async () => {
    handler = reply(['ok']);
    const h = harness({ settingsEnv: {} });
    h.settings?.updateSettings({ 'engine.chat': 'adk' });
    for (const bad of ['turbo', '', 'ADK ', null, 1]) {
      expect(h.settings?.updateSettings({ 'engine.chat': bad }), String(bad)).toMatchObject({
        status: 'invalid',
      });
    }
    await h.run([{ role: 'user', content: 'Hi' }]);
    expect(h.legacyCalls).not.toHaveBeenCalled(); // still ADK (the saved choice)
  });

  it('an invalid AGENT_ENGINE is not applied (reported), and Settings can still choose ADK', async () => {
    handler = reply(['ok']);
    const h = harness({ settingsEnv: { AGENT_ENGINE: 'turbo' } });
    expect(h.logs).toEqual([expect.stringMatching(/^AGENT_ENGINE="turbo" is not used/)]);
    await h.run([{ role: 'user', content: 'Hi' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(1);
    h.settings?.updateSettings({ 'engine.chat': 'adk' });
    await h.run([{ role: 'user', content: 'Again' }]);
    expect(h.legacyCalls).toHaveBeenCalledTimes(1);
  });
});

describe('Configuration precedence: AGENT_ENGINE override', () => {
  it('AGENT_ENGINE overrides the saved choice for new requests; Settings cannot switch it while set', async () => {
    handler = reply(['ok']);
    const h = harness({ settingsEnv: { AGENT_ENGINE: 'adk' } });
    expect(h.settings?.updateSettings({ 'engine.chat': 'legacy' })).toMatchObject({
      status: 'invalid',
    });
    await h.run([{ role: 'user', content: 'Hi' }]);
    expect(h.legacyCalls).not.toHaveBeenCalled(); // ADK, from the override
    expect(h.logs).toEqual(['Chat engine: adk']);
  });
});

// --- L/M/N/P. no tools, no persistence, research untouched, no other hosts ---------------

describe('L/M/N/P. isolation', () => {
  it('Chat never sends tools, and a tool call in the reply is never executed', async () => {
    handler = (_b, res) =>
      stream(res, [
        line('I published the note.', false),
        line('', true, {
          tool_calls: [{ id: 'c1', function: { name: 'publish_note', arguments: { text: 'x' } } }],
        }),
      ]);
    const out = await both((h) =>
      h.run([{ role: 'user', content: 'Publish it' }]).then(() => undefined),
    );
    for (const engine of ENGINES) {
      expect(
        out[engine].requests.every((r) => !('tools' in r.body)),
        engine,
      ).toBe(true);
    }
    // Nothing is executed and no tool status is ever reported (the Chat contract has none).
    // Legacy ignores the stray call and completes; ADK fails closed (documented difference).
    expect(normal(out.legacy.events)).toEqual([
      { type: 'delta', streamId: 'S', content: 'I published the note.' },
      expect.objectContaining({ type: 'done' }),
    ]);
    expect(normal(out.adk.events)).toEqual([
      { type: 'delta', streamId: 'S', content: 'I published the note.' },
      {
        type: 'error',
        streamId: 'S',
        code: 'invalid-response',
        message: 'The model called "publish_note", which is not one of the provided tools.',
      },
    ]);
  });

  it('ADK Chat writes nothing to the ADK session tables and leaves Research data unchanged', async () => {
    handler = reply(['ok']);
    const h = harness({ engine: 'adk' });
    const task = h.storage.tasks.create({ title: 'Research', input: { question: 'q' } });
    h.storage.logs.append(task.id, { level: 'info', event: 'task.note', message: 'kept' });
    const research = [
      'tasks',
      'task_steps',
      'task_logs',
      'sources',
      'source_contents',
      'reports',
      'approvals',
    ];
    const snapshot = () =>
      research.map((t) => h.storage.sqlite.prepare(`select * from ${t}`).all());
    const before = snapshot();
    await h.run(HISTORY);
    await h.run([{ role: 'user', content: 'Again' }]);
    expect(snapshot()).toEqual(before);
    for (const table of ['adk_sessions', 'adk_events', 'adk_app_state', 'adk_user_state']) {
      expect(h.storage.sqlite.prepare(`select count(*) as n from ${table}`).get(), table).toEqual({
        n: 0,
      });
    }
  });

  it('only the configured Ollama server is contacted; ADK runs with telemetry disabled', async () => {
    handler = reply(['ok']);
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return realFetch(input, init);
    });
    const h = harness({ engine: 'adk' });
    await h.run(HISTORY);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith(`http://${baseHost}/`))).toBe(true);
    const runtime = await loadAdkRuntime();
    expect(process.env['OTEL_SDK_DISABLED']).toBe('true');
    expect(runtime.environment).toBeDefined();
  });
});
