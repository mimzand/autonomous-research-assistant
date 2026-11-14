/**
 * Phase 7.3: Legacy/ADK transport parity against a remote HTTPS (ngrok) Ollama.
 *
 * The app's own wiring (ChatController → engine selector → OllamaProvider, and
 * researchTaskModelsFor → task snapshot → legacy or ADK model) over a scripted
 * fetch: nothing leaves this process. Both engines must send byte-identical
 * requests (URL, headers, body) to the remote endpoint and handle its replies
 * the same way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '@rka/agent-runtime';
import {
  createOllamaProvider,
  generateObject,
  loadOllamaConfig,
  type FetchLike,
} from '@rka/model-provider';
import { type ChatEvent } from '@rka/shared';
import { openStorage } from '@rka/storage';
import { createToolRegistry } from '@rka/tools';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatController, type ChatEventSink } from './chat.js';
import {
  AGENT_ENGINE_ENV,
  createAppChatEngines,
  researchTaskModelsFor,
  type AgentEngine,
} from '@rka/agent-host';

const TUNNEL = 'example-tunnel.ngrok-free.dev';
const MODEL = 'qwen3.5:9b-mlx';
const ENGINES: readonly AgentEngine[] = ['legacy', 'adk'];

const dir = mkdtempSync(join(tmpdir(), 'rka-remote-'));
const storage = openStorage({ path: join(dir, 'remote.db') });
afterAll(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}
type ChatReply = (body: Record<string, unknown>) => Response;

const line = (content: string, done: boolean, doneReason = 'stop', thinking?: string) => ({
  model: MODEL,
  created_at: '2026-11-13T10:00:00Z',
  message: { role: 'assistant', content, ...(thinking && { thinking }) },
  done,
  ...(done && {
    done_reason: doneReason,
    prompt_eval_count: 10,
    eval_count: 3,
    total_duration: 1_000_000,
    load_duration: 0,
  }),
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const ndjson = (lines: unknown[]) =>
  new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), {
    headers: { 'content-type': 'application/x-ndjson' },
  });

const okChat: ChatReply = (body) =>
  body['stream']
    ? ndjson([line('O', false), line('K', false), line('', true)])
    : json(line('{"answer":"OK"}', true));

function scripted(chat: ChatReply) {
  const seen: Seen[] = [];
  const fetch: FetchLike = (input, init = {}) => {
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen.push({ url: input, headers: { ...(init.headers as Record<string, string>) }, body });
    const path = new URL(input).pathname;
    if (path === '/api/version') return Promise.resolve(json({ version: '0.40.14' }));
    if (path === '/api/show') return Promise.resolve(json({ capabilities: ['completion'] }));
    if (path === '/api/tags') return Promise.resolve(json({ models: [{ name: MODEL }] }));
    return Promise.resolve(chat(body ?? {}));
  };
  return { seen, fetch };
}

function remoteProvider(fetch: FetchLike) {
  return createOllamaProvider(
    loadOllamaConfig({ OLLAMA_HOST: `https://${TUNNEL}`, OLLAMA_MODEL: MODEL }),
    { fetch, ngrokBypassHosts: [TUNNEL], getAuthToken: () => 'company-token' },
  );
}

async function chatThrough(engine: AgentEngine, reply: ChatReply = okChat) {
  const { seen, fetch } = scripted(reply);
  const provider = remoteProvider(fetch);
  const runtime = createAgentRuntime({
    modelProvider: provider,
    tools: createToolRegistry([]),
    storage,
  });
  const chat = new ChatController({
    runtime,
    selectEngine: createAppChatEngines({
      runtime,
      provider,
      env: { [AGENT_ENGINE_ENV]: engine },
      log: () => undefined,
    }),
  });
  const events: ChatEvent[] = [];
  const sink: ChatEventSink = { id: 1, isDestroyed: () => false, send: (e) => events.push(e) };
  const started = chat.start(sink, { messages: [{ role: 'user', content: 'Reply with OK.' }] });
  if (started.status !== 'started') throw new Error(started.message);
  await chat.whenIdle();
  // Stream ids differ per run; compare everything else.
  return { seen, events: events.map(({ streamId: _, ...rest }) => rest) };
}

async function researchThrough(engine: AgentEngine, reply: ChatReply = okChat) {
  const { seen, fetch } = scripted(reply);
  const models = researchTaskModelsFor(remoteProvider(fetch), {
    readFlag: () => engine,
    log: () => undefined,
  });
  const model = models.providerFor(models.capture());
  const result = await generateObject(
    model,
    { messages: [{ role: 'user', content: 'Answer as JSON.' }] },
    z.object({ answer: z.string() }),
  ).then(
    (r) => ({ ok: true as const, value: r.object }),
    (e: unknown) => ({ ok: false as const, error: (e as { code?: string }).code }),
  );
  return { seen, result };
}

describe('Legacy/ADK parity over a remote HTTPS Ollama (ngrok, trusted host)', () => {
  it('Chat: identical requests (URL, headers incl. the ngrok header and token, body) and events', async () => {
    const [legacy, adk] = await Promise.all(ENGINES.map((e) => chatThrough(e)));
    expect(adk?.seen).toEqual(legacy?.seen);
    expect(adk?.events).toEqual(legacy?.events);
    const chatCall = legacy?.seen.find((s) => s.url.endsWith('/api/chat'));
    expect(chatCall).toMatchObject({
      url: `https://${TUNNEL}/api/chat`,
      headers: { 'ngrok-skip-browser-warning': 'true', authorization: 'Bearer company-token' },
      body: { model: MODEL, stream: true, think: false },
    });
    expect(legacy?.events.map((e) => e.type)).toEqual(['delta', 'delta', 'done']);
  });

  it('Research: identical structured-output requests and validated results', async () => {
    const [legacy, adk] = await Promise.all(ENGINES.map((e) => researchThrough(e)));
    expect(adk?.seen).toEqual(legacy?.seen);
    expect(adk?.result).toEqual(legacy?.result);
    expect(legacy?.result).toEqual({ ok: true, value: { answer: 'OK' } });
    const chatCall = legacy?.seen.find((s) => s.url.endsWith('/api/chat'));
    expect(chatCall?.headers['ngrok-skip-browser-warning']).toBe('true');
    expect(chatCall?.body).toMatchObject({
      stream: false,
      think: false,
      format: { type: 'object' },
    });
  });

  it('thinking-only replies: Chat shows nothing but completes; Research gets a clean invalid-response', async () => {
    const thinkingOnly: ChatReply = (body) =>
      body['stream']
        ? ndjson([line('', false, 'stop', 'hmm…'), line('', true)])
        : json(line('', true, 'stop', 'hmm…'));
    for (const engine of ENGINES) {
      const chat = await chatThrough(engine, thinkingOnly);
      expect(
        chat.events.map((e) => e.type),
        engine,
      ).toEqual(['done']);
      expect(JSON.stringify(chat.events), engine).not.toContain('hmm');
      const research = await researchThrough(engine, thinkingOnly);
      expect(research.result, engine).toEqual({ ok: false, error: 'invalid-response' });
    }
  });

  it('done_reason=length: both engines report finishReason "length"', async () => {
    const truncated: ChatReply = () => ndjson([line('partial', false), line('', true, 'length')]);
    const [legacy, adk] = await Promise.all(ENGINES.map((e) => chatThrough(e, truncated)));
    expect(adk?.events).toEqual(legacy?.events);
    expect(legacy?.events.at(-1)).toMatchObject({ type: 'done', finishReason: 'length' });
  });

  it('model not found: both engines report model-not-found', async () => {
    const missing: ChatReply = () => json({ error: `model '${MODEL}' not found` }, 404);
    const [legacy, adk] = await Promise.all(ENGINES.map((e) => chatThrough(e, missing)));
    expect(adk?.events).toEqual(legacy?.events);
    expect(legacy?.events).toEqual([
      expect.objectContaining({ type: 'error', code: 'model-not-found' }),
    ]);
  });
});
