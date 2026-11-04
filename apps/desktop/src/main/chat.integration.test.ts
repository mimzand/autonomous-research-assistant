/**
 * Integration: ChatController → AgentRuntime → real OllamaProvider → HTTP,
 * against a local fake Ollama server. Same wiring as main/index.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createAgentRuntime } from '@rka/agent-runtime';
import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { type ChatEvent } from '@rka/shared';
import { createInMemoryTaskRepository } from '@rka/storage';
import { createToolRegistry } from '@rka/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatController, type ChatEventSink } from './chat.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let port: number;
let handler: Handler;
const requests: unknown[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const chunk = (content: string, done = false) => ({
  model: 'qwen3:8b',
  message: { role: 'assistant', content },
  done,
  ...(done && { done_reason: 'stop', eval_count: 3, total_duration: 5_000_000 }),
});

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('connection', 'close');
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (body) requests.push(JSON.parse(body));
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function wire(host = `127.0.0.1:${port}`) {
  const runtime = createAgentRuntime({
    modelProvider: createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: host })),
    tools: createToolRegistry([]),
    tasks: createInMemoryTaskRepository(),
  });
  const events: ChatEvent[] = [];
  const sink: ChatEventSink = { id: 1, isDestroyed: () => false, send: (e) => events.push(e) };
  return { chat: new ChatController({ runtime }), sink, events };
}

async function streamReply(res: ServerResponse, words: string[], delayMs = 15): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const word of words) {
    if (res.destroyed) return;
    res.write(`${JSON.stringify(chunk(word))}\n`);
    await sleep(delayMs);
  }
  if (!res.destroyed) res.end(`${JSON.stringify(chunk('', true))}\n`);
}

const text = (events: ChatEvent[]) =>
  events.map((e) => (e.type === 'delta' ? e.content : '')).join('');

describe('chat over the real Ollama provider', () => {
  it('streams a reply and supports multiple turns in one session', async () => {
    handler = (_req, res) => void streamReply(res, ['Hello', ' there', '!']);
    const { chat, sink, events } = wire();

    chat.start(sink, { messages: [{ role: 'user', content: 'Hi' }] });
    await chat.whenIdle();
    expect(text(events)).toBe('Hello there!');
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      finishReason: 'stop',
      completionTokens: 3,
    });

    events.length = 0;
    requests.length = 0;
    handler = (_req, res) => void streamReply(res, ['Second', ' answer']);
    chat.start(sink, {
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there!' },
        { role: 'user', content: 'And again?' },
      ],
    });
    await chat.whenIdle();
    expect(text(events)).toBe('Second answer');
    expect(requests[0]).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      think: false,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there!' },
        { role: 'user', content: 'And again?' },
      ],
    });
  });

  it('cancels a long generation mid-stream', async () => {
    let closedEarly = false;
    handler = (_req, res) => {
      res.on('close', () => (closedEarly = !res.writableEnded));
      void streamReply(
        res,
        Array.from({ length: 200 }, (_, i) => `w${i} `),
        10,
      );
    };
    const { chat, sink, events } = wire();
    const result = chat.start(sink, { messages: [{ role: 'user', content: 'Long essay' }] });
    if (result.status !== 'started') throw new Error('not started');

    await sleep(80);
    chat.stop({ streamId: result.streamId });
    await chat.whenIdle();
    await sleep(20);

    expect(events.at(-1)).toEqual({ type: 'cancelled', streamId: result.streamId });
    expect(events.filter((e) => e.type === 'delta').length).toBeLessThan(50);
    expect(closedEarly).toBe(true);
  });

  it('reports a missing model', async () => {
    handler = (_req, res) =>
      res
        .writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: "model 'qwen3:8b' not found" }));
    const { chat, sink, events } = wire();
    chat.start(sink, { messages: [{ role: 'user', content: 'Hi' }] });
    await chat.whenIdle();
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'model-not-found' })]);
  });

  it('reports Ollama being unavailable', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const { chat, sink, events } = wire(`127.0.0.1:${deadPort}`);
    chat.start(sink, { messages: [{ role: 'user', content: 'Hi' }] });
    await chat.whenIdle();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'unavailable',
        message: expect.stringContaining('ECONNREFUSED'),
      }),
    ]);
  });

  it('reports a generation that fails mid-stream', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(chunk('Partial'))}\n`);
      res.end(`${JSON.stringify({ error: 'CUDA error: out of memory' })}\n`);
    };
    const { chat, sink, events } = wire();
    chat.start(sink, { messages: [{ role: 'user', content: 'Hi' }] });
    await chat.whenIdle();
    expect(text(events)).toBe('Partial');
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      code: 'generation-failed',
      message: expect.stringContaining('out of memory'),
    });
  });
});
