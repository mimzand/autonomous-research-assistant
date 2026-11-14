/**
 * Tool calling over real HTTP against a local fake Ollama server: real fetch,
 * NDJSON streaming, socket aborts and timers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOllamaConfig } from '../config.js';
import { type GenerateChunk, type GenerateRequest } from '../schemas.js';
import { chatChunk } from '../testing/fixtures.js';
import { calculator, runToolLoop } from '../testing/tool-harness.js';
import { OllamaProvider } from './provider.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let handler: Handler = (_req, res) => res.writeHead(500).end();
let clientClosed: Promise<void>;
let markClosed: () => void;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('connection', 'close');
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (req.url === '/api/version') return json(res, { version: '0.40.14' });
      handler(req, res, body);
    });
    res.on('close', () => {
      if (!res.writableEnded) markClosed();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeProvider(overrides: Record<string, string> = {}) {
  clientClosed = new Promise((resolve) => (markClosed = resolve));
  return new OllamaProvider(loadOllamaConfig({ OLLAMA_HOST: baseUrl, ...overrides }), {
    allowToolCalls: true,
  });
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function streamLines(res: ServerResponse, lines: unknown[], delayMs: number): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const line of lines) {
    if (res.destroyed) return;
    res.write(`${JSON.stringify(line)}\n`);
    await sleep(delayMs);
  }
  if (!res.destroyed) res.end();
}

const callChunk = (id: string) => {
  const chunk = chatChunk('');
  return {
    ...chunk,
    message: {
      ...chunk.message,
      tool_calls: [
        {
          id,
          function: {
            index: 0,
            name: 'calculator',
            arguments: { operation: 'multiply', a: 125, b: 48 },
          },
        },
      ],
    },
  };
};

const request: GenerateRequest = {
  messages: [{ role: 'user', content: 'What is 125 multiplied by 48? Use the calculator tool.' }],
  tools: [calculator.tool.definition],
};

describe('tool calling over HTTP', () => {
  it('streams a tool call, then the tool result round trip yields 6000', async () => {
    handler = (_req, res, body) => {
      const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] })
        .messages;
      const last = messages.at(-1);
      if (last?.role === 'tool') {
        const { result } = JSON.parse(last.content) as { result: number };
        void streamLines(
          res,
          [chatChunk('The answer is '), chatChunk(`${result}.`), chatChunk('', true)],
          10,
        );
      } else {
        void streamLines(
          res,
          [chatChunk('Calling the calculator.'), callChunk('call_http'), chatChunk('', true)],
          10,
        );
      }
    };
    const run = await runToolLoop({
      provider: makeProvider(),
      messages: request.messages.slice(),
      tools: [calculator],
      stream: true,
    });
    expect(run.final.content).toBe('The answer is 6000.');
    expect(run.events).toMatchObject([
      { kind: 'executed', callId: 'call_http', detail: { output: { result: 6000 } } },
    ]);
  });

  it('cancelling after a tool call arrived delivers no tool call and closes the connection', async () => {
    handler = (_req, res) =>
      void streamLines(
        res,
        [chatChunk('Calling.'), callChunk('never'), chatChunk('still going'), chatChunk('', true)],
        150,
      );
    const controller = new AbortController();
    const seen: GenerateChunk[] = [];
    const run = (async () => {
      for await (const chunk of makeProvider().generateStream(request, {
        signal: controller.signal,
      })) {
        seen.push(chunk);
        setTimeout(() => controller.abort(), 200); // after the tool-call line was received
      }
    })();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await clientClosed;
    expect(seen.every((c) => c.type === 'delta')).toBe(true);
  });

  it('times out a stream that stalls after a tool call; nothing is delivered', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(callChunk('stalled'))}\n`);
      // ...then silence.
    };
    const seen: GenerateChunk[] = [];
    const run = (async () => {
      for await (const chunk of makeProvider().generateStream(request, { idleTimeoutMs: 150 }))
        seen.push(chunk);
    })();
    await expect(run).rejects.toMatchObject({ code: 'timeout' });
    expect(seen).toEqual([]);
  });

  it('reports a dropped connection mid-stream; nothing is delivered', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify(callChunk('dropped'))}\n`);
      setTimeout(() => res.socket?.destroy(), 30);
    };
    const seen: GenerateChunk[] = [];
    const run = (async () => {
      for await (const chunk of makeProvider().generateStream(request)) seen.push(chunk);
    })();
    await expect(run).rejects.toMatchObject({
      code: expect.stringMatching(/unavailable|invalid-response/),
    });
    expect(seen).toEqual([]);
  });

  it('times out a non-streaming tool request', async () => {
    handler = () => undefined;
    await expect(makeProvider().generate(request, { timeoutMs: 150 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});
