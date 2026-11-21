/**
 * Chat over the agent protocol (Phase 4): AgentClient → agent server → ChatController
 * → real Ollama provider → a scripted fake Ollama HTTP server. No live model needed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgent, type AgentClient } from '@rka/agent-client';
import { type EventPayload } from '@rka/agent-protocol';
import { appDatabasePath, openStorage } from '@rka/storage';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startAgentServer } from './server.js';
import { openAgentServices, type AgentServices } from './services.js';
import { generateToken } from './token.js';

const MODEL = 'fake-model:1b';
type ChatEvent = EventPayload<'chat.event'>;
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let ollama: Server;
let ollamaPort: number;
let handler: Handler;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res: ServerResponse, value: unknown) =>
  void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const chunk = (content: string, done = false) =>
  `${JSON.stringify({
    model: MODEL,
    message: { role: 'assistant', content },
    done,
    ...(done && {
      done_reason: 'stop',
      prompt_eval_count: 7,
      eval_count: 3,
      total_duration: 5_000_000,
    }),
  })}\n`;

async function streamReply(res: ServerResponse, words: string[], delayMs = 10): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const word of words) {
    if (res.destroyed) return;
    res.write(chunk(word));
    await sleep(delayMs);
  }
  if (!res.destroyed) res.end(chunk('', true));
}

beforeAll(async () => {
  ollama = createServer((req, res) => {
    res.setHeader('connection', 'close');
    req.resume();
    req.on('end', () => {
      if (req.url === '/api/version') return json(res, { version: '0.40.14' });
      if (req.url === '/api/tags') {
        return json(res, { models: [{ name: MODEL, model: MODEL, size: 1, details: {} }] });
      }
      if (req.url === '/api/show') {
        return json(res, { capabilities: ['completion'], model_info: {}, details: {} });
      }
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  ollamaPort = (ollama.address() as AddressInfo).port;
});

afterAll(async () => {
  ollama.closeAllConnections();
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
});

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Agent services on a fresh data dir, served over TCP, plus one connected shell. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-chat-'));
  dirs.push(dir);
  const services: AgentServices = openAgentServices({
    dataDir: dir,
    env: { OLLAMA_HOST: `127.0.0.1:${ollamaPort}`, OLLAMA_MODEL: MODEL },
  });
  cleanups.push(() => services.close());
  cleanups.push(() => services.whenChatIdle());
  const token = generateToken();
  const server = await startAgentServer({
    token,
    agentVersion: '1.0.0',
    handlers: services.handlers,
    onDisconnect: (id) => services.onDisconnect(id),
  });
  cleanups.push(() => server.close());
  const connect = async () => {
    const client = await connectAgent({ port: server.port, token });
    cleanups.push(() => client.close());
    const events: ChatEvent[] = [];
    client.onEvent((event) => {
      if (event.method === 'chat.event') events.push(event.payload);
    });
    return { client, events };
  };
  return { dir, services, connect, ...(await connect()) };
}

/** Resolves when `events` contains a terminal event for `streamId`. */
async function terminal(events: ChatEvent[], streamId: string): Promise<ChatEvent> {
  for (let i = 0; i < 300; i++) {
    const end = events.find(
      (e) => e.streamId === streamId && ['done', 'error', 'cancelled'].includes(e.type),
    );
    if (end) return end;
    await sleep(10);
  }
  throw new Error('no terminal event');
}

const text = (events: ChatEvent[]) =>
  events.map((e) => (e.type === 'delta' ? e.content : '')).join('');

async function started(client: AgentClient, content = 'Hi') {
  const result = await client.request('chat.start', { text: content });
  if (result.status !== 'started') throw new Error(`not started: ${JSON.stringify(result)}`);
  return result;
}

describe('chat over the agent protocol', () => {
  it('streams chat.event deltas then done, and records usage in the agent database', async () => {
    handler = (_req, res) => void streamReply(res, ['Hello', ' there', '!']);
    const { dir, client, events } = await setup();

    const result = await started(client);
    expect(result.model).toBe(MODEL);
    expect(await terminal(events, result.streamId)).toMatchObject({
      type: 'done',
      model: MODEL,
      finishReason: 'stop',
      completionTokens: 3,
    });
    expect(text(events)).toBe('Hello there!');
    expect(events.every((e) => e.streamId === result.streamId)).toBe(true);

    const storage = openStorage({ path: appDatabasePath(dir) });
    try {
      expect(storage.modelUsage.listRecent()).toEqual([
        expect.objectContaining({
          provider: 'ollama',
          model: MODEL,
          purpose: 'chat',
          promptTokens: 7,
          completionTokens: 3,
        }),
      ]);
    } finally {
      storage.close();
    }
  });

  it('rejects a second start while busy, and stops by streamId', async () => {
    handler = (_req, res) =>
      void streamReply(
        res,
        Array.from({ length: 200 }, (_, i) => `w${i} `),
      );
    const { client, events } = await setup();
    const first = await started(client, 'Long essay');

    await expect(client.request('chat.start', { text: 'Again' })).resolves.toMatchObject({
      status: 'rejected',
      code: 'busy',
    });

    await sleep(50);
    await expect(client.request('chat.stop', { streamId: first.streamId })).resolves.toBeNull();
    expect(await terminal(events, first.streamId)).toEqual({
      type: 'cancelled',
      streamId: first.streamId,
    });
    expect(events.filter((e) => e.type === 'delta').length).toBeLessThan(100);
  });

  it('busy is shared by all connected shells', async () => {
    handler = (_req, res) => void streamReply(res, ['a', 'b', 'c'], 30);
    const { client, events, connect } = await setup();
    const other = await connect();
    const first = await started(client);
    await expect(other.client.request('chat.start', { text: 'Hi' })).resolves.toMatchObject({
      status: 'rejected',
      code: 'busy',
    });
    await terminal(events, first.streamId);
    expect(other.events).toEqual([]);
  });

  it('aborts the generation when the shell disconnects', async () => {
    let closedEarly = false;
    handler = (_req, res) => {
      res.on('close', () => (closedEarly = !res.writableEnded));
      void streamReply(
        res,
        Array.from({ length: 200 }, (_, i) => `w${i} `),
      );
    };
    const { client, services } = await setup();
    await started(client, 'Long essay');
    await sleep(50);
    client.close();
    await services.whenChatIdle();
    await sleep(20);
    expect(closedEarly).toBe(true);
  });

  it('stores the transcript in the agent database: chat.history, then chat.clear', async () => {
    handler = (_req, res) => void streamReply(res, ['Stored', ' reply']);
    const { client, events } = await setup();
    const first = await started(client, 'Keep this');
    await terminal(events, first.streamId);
    await expect(client.request('chat.history', {})).resolves.toEqual({
      messages: [
        {
          role: 'user',
          content: 'Keep this',
          status: 'complete',
          model: null,
          promptTokens: null,
          completionTokens: null,
        },
        expect.objectContaining({ role: 'assistant', content: 'Stored reply', model: MODEL }),
      ],
    });
    await expect(client.request('chat.clear', {})).resolves.toBeNull();
    await expect(client.request('chat.history', {})).resolves.toEqual({ messages: [] });
  });

  it('rejects malformed chat requests at the protocol boundary', async () => {
    const { client } = await setup();
    await expect(
      client.request('chat.start', { messages: [{ role: 'user', content: 'Hi' }] } as never),
    ).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(client.request('chat.stop', { streamId: 'nope' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('reports Ollama errors as chat.event errors', async () => {
    handler = (_req, res) =>
      void res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: `model '${MODEL}' not found` }));
    const { client, events } = await setup();
    const result = await started(client);
    expect(await terminal(events, result.streamId)).toMatchObject({
      type: 'error',
      code: 'model-not-found',
    });
  });

  it('serves model.health from the agent runtime', async () => {
    const { client } = await setup();
    await expect(client.request('model.health', {})).resolves.toMatchObject({
      status: 'ready',
      model: MODEL,
      serverVersion: '0.40.14',
    });
  });
});
