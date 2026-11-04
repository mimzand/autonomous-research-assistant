/**
 * Integration tests: real HTTP against a local fake Ollama server.
 * Exercises the real fetch, streaming, socket aborts and timers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOllamaConfig } from '../config.js';
import { TAGS_QWEN, chatChunk } from '../testing/fixtures.js';
import { OllamaProvider } from './provider.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let handler: Handler = (_req, res) => res.writeHead(500).end();
/** Resolves when the client closes the current connection early. */
let clientClosed: Promise<void>;
let markClosed: () => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  server = createServer((req, res) => {
    // One request per connection, so a test that stalls or aborts never leaves a
    // half-used keep-alive socket behind for the next test.
    res.setHeader('connection', 'close');
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => handler(req, res, body));
    res.on('close', () => {
      if (!res.writableEnded) markClosed();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections(); // Stalled handlers keep sockets open on purpose.
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function freshCloseSignal(): void {
  clientClosed = new Promise((resolve) => (markClosed = resolve));
}

function makeProvider(overrides: Record<string, string> = {}) {
  freshCloseSignal();
  const config = loadOllamaConfig({ OLLAMA_HOST: baseUrl, ...overrides });
  return new OllamaProvider(config);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

/** Streams NDJSON lines with a delay between them. Stops if the client disconnects. */
async function streamLines(res: ServerResponse, lines: unknown[], delayMs: number): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const line of lines) {
    if (res.destroyed) return;
    res.write(`${JSON.stringify(line)}\n`);
    await sleep(delayMs);
  }
  if (!res.destroyed) res.end();
}

const prompt = { messages: [{ role: 'user' as const, content: 'Hi' }] };

describe('OllamaProvider over HTTP', () => {
  it('checks health and model availability', async () => {
    handler = (req, res) => {
      if (req.url === '/api/version') return json(res, { version: '0.40.14' });
      if (req.url === '/api/tags') return json(res, TAGS_QWEN);
      json(res, { error: 'not found' }, 404);
    };
    const ollama = makeProvider();
    await expect(ollama.checkHealth()).resolves.toMatchObject({
      status: 'ready',
      baseUrl,
      capabilities: ['completion', 'tools', 'thinking'],
    });
    await expect(ollama.checkModel('missing:1b')).resolves.toMatchObject({ available: false });
  });

  it('generates text and sends the expected body', async () => {
    let received: unknown;
    handler = (req, res, body) => {
      received = { method: req.method, url: req.url, body: JSON.parse(body) as unknown };
      json(res, chatChunk('Hello from Ollama', true));
    };
    const result = await makeProvider().generate(prompt);
    expect(result.content).toBe('Hello from Ollama');
    expect(received).toMatchObject({
      method: 'POST',
      url: '/api/chat',
      body: { model: 'qwen3:8b', stream: false, think: false },
    });
  });

  it('streams deltas incrementally', async () => {
    handler = (_req, res) =>
      void streamLines(
        res,
        [chatChunk('A'), chatChunk('B'), chatChunk('C'), chatChunk('', true)],
        40,
      );

    const started = Date.now();
    const arrivals: number[] = [];
    let text = '';
    for await (const chunk of makeProvider().generateStream(prompt)) {
      arrivals.push(Date.now() - started);
      if (chunk.type === 'delta') text += chunk.content;
      if (chunk.type === 'done') expect(chunk.result.content).toBe('ABC');
    }
    expect(text).toBe('ABC');
    // The first delta arrives well before the stream finishes.
    expect(arrivals[0]).toBeLessThan(arrivals[arrivals.length - 1] ?? 0);
  });

  it('cancels a stream mid-flight and closes the connection', async () => {
    handler = (_req, res) =>
      void streamLines(
        res,
        Array.from({ length: 100 }, (_, i) => chatChunk(`t${i} `)),
        30,
      );

    const controller = new AbortController();
    const ollama = makeProvider();
    const seen: string[] = [];
    const run = (async () => {
      for await (const chunk of ollama.generateStream(prompt, { signal: controller.signal })) {
        if (chunk.type === 'delta') seen.push(chunk.content);
        if (seen.length === 2) controller.abort();
      }
    })();

    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await expect(clientClosed).resolves.toBeUndefined();
    expect(seen.length).toBeLessThan(10);
  });

  it('aborts the request when the consumer stops early', async () => {
    handler = (_req, res) =>
      void streamLines(
        res,
        Array.from({ length: 100 }, (_, i) => chatChunk(`t${i}`)),
        20,
      );

    for await (const chunk of makeProvider().generateStream(prompt)) {
      if (chunk.type === 'delta') break;
    }
    await expect(clientClosed).resolves.toBeUndefined();
  });

  it('cancels a pending generate call', async () => {
    handler = () => undefined; // Never responds (e.g. model still loading).
    const controller = new AbortController();
    const pending = makeProvider().generate(prompt, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await expect(clientClosed).resolves.toBeUndefined();
  });

  it('times out a slow generate call', async () => {
    handler = () => undefined;
    const started = Date.now();
    await expect(makeProvider().generate(prompt, { timeoutMs: 150 })).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('150 ms'),
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('times out a stream that stalls between chunks', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(chatChunk('first'))}\n`);
      // ...then silence.
    };
    const chunks: string[] = [];
    const run = (async () => {
      for await (const chunk of makeProvider().generateStream(prompt, { idleTimeoutMs: 150 })) {
        if (chunk.type === 'delta') chunks.push(chunk.content);
      }
    })();
    await expect(run).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('No data'),
    });
    expect(chunks).toEqual(['first']);
  });

  it('times out health checks using the request timeout', async () => {
    handler = () => undefined;
    const health = await makeProvider({ OLLAMA_REQUEST_TIMEOUT_MS: '150' }).checkHealth();
    expect(health).toMatchObject({ status: 'unreachable', reason: 'timeout' });
  });

  it('maps a missing model from the real server shape', async () => {
    handler = (_req, res) => json(res, { error: "model 'nope:1b' not found" }, 404);
    await expect(makeProvider().generate({ ...prompt, model: 'nope:1b' })).rejects.toMatchObject({
      code: 'model-not-found',
      status: 404,
    });
  });

  it('reports unavailable when nothing listens on the port', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const ollama = new OllamaProvider(loadOllamaConfig({ OLLAMA_HOST: `127.0.0.1:${port}` }));
    await expect(ollama.generate(prompt)).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('ECONNREFUSED'),
    });
    await expect(ollama.checkHealth()).resolves.toMatchObject({
      status: 'unreachable',
      reason: 'unavailable',
    });
  });
});
