/*
 * Test-only fake Ollama HTTP server. Not exported from the package.
 * Answers /api/version, /api/tags and /api/show, and serves /api/chat from a
 * per-test handler. Records every chat request body and notices when the
 * client closes a connection early (an aborted request).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

export interface ChatBody {
  model: string;
  stream: boolean;
  think: boolean;
  messages: Record<string, unknown>[];
  tools?: {
    type: string;
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }[];
  format?: unknown;
  options: Record<string, unknown>;
}

export type ChatHandler = (
  body: ChatBody,
  res: ServerResponse,
  call: number,
) => void | Promise<void>;

export interface FakeOllama {
  readonly baseUrl: string;
  readonly chats: ChatBody[];
  /** Resolves when the client closes a chat response before it ended. */
  clientAborted(): Promise<void>;
  setChat(handler: ChatHandler): void;
  close(): Promise<void>;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function chunk(content: string, done = false, extra: Record<string, unknown> = {}) {
  return {
    model: 'qwen3:8b',
    created_at: '2026-11-12T12:00:00Z',
    message: { role: 'assistant', content, ...(extra['message'] as object | undefined) },
    done,
    ...(done && {
      done_reason: 'stop',
      prompt_eval_count: 21,
      eval_count: 9,
      total_duration: 1_500_000_000,
      load_duration: 200_000_000,
    }),
  };
}

/** A chunk carrying one tool call, shaped like Ollama 0.40.14 sends it (id, index, object arguments). */
export function toolCallChunk(id: string, name: string, args: unknown, done = false) {
  return chunk('', done, {
    message: { tool_calls: [{ id, function: { index: 0, name, arguments: args } }] },
  });
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export async function streamLines(
  res: ServerResponse,
  lines: unknown[],
  delayMs = 5,
): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const line of lines) {
    if (res.destroyed) return;
    res.write(`${JSON.stringify(line)}\n`);
    await sleep(delayMs);
  }
  if (!res.destroyed) res.end();
}

/** Replies like Ollama: one JSON object, or NDJSON when the request streams. */
export function reply(
  body: ChatBody,
  res: ServerResponse,
  lines: unknown[],
  delayMs = 5,
): Promise<void> | void {
  if (body.stream) return streamLines(res, lines, delayMs);
  // Non-streaming: merge the lines into one final message.
  const last = lines.at(-1) as ReturnType<typeof chunk>;
  const content = lines.map((l) => (l as ReturnType<typeof chunk>).message.content).join('');
  const toolCalls = lines.flatMap(
    (l) => (l as { message: { tool_calls?: unknown[] } }).message.tool_calls ?? [],
  );
  json(res, {
    ...last,
    message: { role: 'assistant', content, ...(toolCalls.length && { tool_calls: toolCalls }) },
  });
}

export async function startFakeOllama(
  options: { capabilities?: string[] } = {},
): Promise<FakeOllama> {
  const chats: ChatBody[] = [];
  let handler: ChatHandler = (_b, res) => json(res, { error: 'no handler' }, 500);
  let markAborted: () => void = () => undefined;
  let aborted = new Promise<void>((resolve) => (markAborted = resolve));

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('connection', 'close');
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.url === '/api/version') return json(res, { version: '0.40.14' });
      if (req.url === '/api/tags') {
        return json(res, {
          models: [
            { name: 'qwen3:8b', capabilities: options.capabilities ?? ['completion', 'tools'] },
          ],
        });
      }
      if (req.url === '/api/show')
        return json(res, { capabilities: options.capabilities ?? ['completion', 'tools'] });
      if (req.url === '/api/chat') {
        const body = JSON.parse(raw) as ChatBody;
        chats.push(body);
        res.on('close', () => {
          if (!res.writableEnded) markAborted();
        });
        void handler(body, res, chats.length);
        return;
      }
      json(res, { error: 'not found' }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    chats,
    clientAborted: () => aborted,
    setChat(next) {
      handler = next;
      chats.length = 0;
      aborted = new Promise<void>((resolve) => (markAborted = resolve));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
