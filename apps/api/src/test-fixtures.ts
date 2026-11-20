/**
 * Test helper (not shipped): a real agent service (apps/agent: protocol server,
 * SQLite, ChatController) on a temporary data folder, reachable through its state
 * file, with a scripted fake Ollama on 127.0.0.1. No live model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, type RunningAgent } from '../../agent/src/run.js';
import { openAgentServices } from '../../agent/src/services.js';

export const MODEL = 'fake-model:1b';

const json = (res: ServerResponse, value: unknown) =>
  void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));

/** A fake Ollama (version/tags/show, /api/chat streams "Hello " + "API") and SearXNG (/search). */
export async function fakeOllama(): Promise<{ readonly host: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
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
      // Fake SearXNG on the same server: no results (research then fails at a later step).
      if (req.url?.startsWith('/search')) return json(res, { query: '', results: [] });
      if (req.url !== '/api/chat') return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const line = (content: string, done: boolean) =>
        `${JSON.stringify({ model: MODEL, message: { role: 'assistant', content }, done, ...(done && { done_reason: 'stop', eval_count: 2 }) })}\n`;
      res.end(line('Hello ', false) + line('API', false) + line('', true));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface TestAgent {
  readonly stateFile: string;
  readonly agent: RunningAgent;
  close(): Promise<void>;
}

export async function startTestAgent(ollamaHost: string): Promise<TestAgent> {
  const dir = mkdtempSync(join(tmpdir(), 'rka-api-agent-'));
  const stateFile = join(dir, 'agent-state.json');
  let services: ReturnType<typeof openAgentServices> | undefined;
  const agent = await runAgent({
    port: 0,
    stateFile,
    agentVersion: '0.1.0',
    openServices: () => {
      services = openAgentServices({
        dataDir: dir,
        env: { OLLAMA_HOST: ollamaHost, OLLAMA_MODEL: MODEL, SEARXNG_URL: `http://${ollamaHost}` },
      });
      return services;
    },
  });
  return {
    stateFile,
    agent,
    async close() {
      await services?.whenChatIdle();
      await services?.whenTasksIdle();
      await agent.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
