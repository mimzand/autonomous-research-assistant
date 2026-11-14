/**
 * Research over the agent protocol (Phase 5): AgentClient → agent server → host
 * Dashboard service → research workflow → real Ollama provider against a fake
 * Ollama that answers by the prompt's "Task: …" line, with a scripted web (no
 * SearXNG, no network). Progress arrives as `ui.researchProgress` events.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgent } from '@rka/agent-client';
import { type EventPayload } from '@rka/agent-protocol';
import {
  createReconfigurableWebServices,
  loadWebConfig,
  type FetchedDocument,
  type ReconfigurableWebServices,
} from '@rka/tools';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startAgentServer } from './server.js';
import { openAgentServices, type AgentServices } from './services.js';
import { generateToken } from './token.js';

type Progress = EventPayload<'ui.researchProgress'>;

const MODEL = 'fake-model:1b';
const GOAL = 'What does the Lindholm lighthouse look like and when was it built?';
const LIMITS = { maxQuestions: 1, maxSources: 2 };
const PAGES: Record<string, { title: string; text: string }> = {
  'https://one.example/history': {
    title: 'Lindholm lighthouse history',
    text: 'The Lindholm lighthouse was built in 1872 on the northern cape. It was automated in 1968.',
  },
  'https://two.example/today': {
    title: 'Lindholm lighthouse today',
    text: 'The Lindholm lighthouse is a white tower 31 metres tall with 140 steps.',
  },
};
const URLS = Object.keys(PAGES);

/** Structured replies of the fake model, by research task. */
function reply(task: string, user: string): unknown {
  switch (task) {
    case 'create-plan':
      return {
        title: 'Lindholm lighthouse',
        objective: 'Describe the Lindholm lighthouse and when it was built.',
        questions: [
          { question: 'When was it built and how does it look?', searchQueries: ['lindholm'] },
        ],
      };
    case 'extract-evidence':
      return user.includes(`url="${URLS[0] ?? ''}"`)
        ? {
            relevant: true,
            summary: 'History.',
            claims: [
              {
                claim: 'Built in 1872.',
                quote: 'was built in 1872 on the northern cape',
                questions: ['q1'],
                confidence: 'high',
              },
            ],
          }
        : {
            relevant: true,
            summary: 'Today.',
            claims: [
              {
                claim: 'A white tower 31 metres tall.',
                quote: 'is a white tower 31 metres tall',
                questions: ['q1'],
                confidence: 'high',
              },
            ],
          };
    case 'compare-findings':
      return {
        findings: [
          {
            question: 'q1',
            statement: 'Built 1872; white 31 m tower.',
            evidence: ['E1', 'E2'],
            agreement: 'consistent',
          },
        ],
        contradictions: [],
        gaps: [],
      };
    case 'write-report':
      return {
        title: 'The Lindholm lighthouse',
        summary: [
          { text: 'The lighthouse was built in 1872.', evidence: ['E1'], certainty: 'high' },
        ],
        sections: [
          {
            heading: 'Appearance',
            paragraphs: [
              { text: 'It is a white tower 31 metres tall.', evidence: ['E2'], certainty: 'high' },
            ],
          },
        ],
      };
    case 'review-report':
      return {
        verdicts: [
          { id: 'P1', verdict: 'supported', note: 'ok' },
          { id: 'P2', verdict: 'supported', note: 'ok' },
        ],
      };
    default:
      return {};
  }
}

/** A research task whose model request is held until `release` (to pause mid-step). */
let hold: { task: string; arrived: () => void; release: Promise<void> } | null = null;

/** Holds the next model request for `task`; `arrived` resolves once it is in flight. */
function holdNext(task: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => {
    hold = { task, arrived: resolve, release: released };
  });
  return { arrived, release };
}

let ollama: Server;
let ollamaPort: number;
const json = (res: ServerResponse, value: unknown, status = 200) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

beforeAll(async () => {
  ollama = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.url === '/api/version') return json(res, { version: '0.40.14' });
      if (req.url === '/api/tags') {
        return json(res, { models: [{ name: MODEL, model: MODEL, size: 1, details: {} }] });
      }
      if (req.url === '/api/show') {
        return json(res, { capabilities: ['completion'], model_info: {}, details: {} });
      }
      if (req.url !== '/api/chat') return json(res, { error: 'not found' }, 404);
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      const task = /^Task: ([a-z-]+)/m.exec(user)?.[1] ?? 'unknown';
      const answer = () =>
        json(res, {
          model: MODEL,
          created_at: '2026-11-14T10:00:00Z',
          message: { role: 'assistant', content: JSON.stringify(reply(task, user)) },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 5,
          total_duration: 1_000_000,
        });
      if (hold?.task === task) {
        const { arrived, release } = hold;
        hold = null;
        arrived();
        void release.then(() => !res.destroyed && answer());
        return;
      }
      answer();
    });
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  ollamaPort = (ollama.address() as AddressInfo).port;
});

afterAll(async () => {
  ollama.closeAllConnections();
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
});

/** Search returns both fixture pages; fetching serves them from memory. */
function scriptedWeb(): ReconfigurableWebServices {
  const base = createReconfigurableWebServices(
    loadWebConfig({ SEARXNG_URL: 'http://127.0.0.1:9' }),
  );
  return {
    ...base,
    searchProvider: {
      id: 'searxng',
      checkHealth: () => Promise.reject(new Error('unused')),
      search: () =>
        Promise.resolve(
          URLS.map((url) => ({
            title: PAGES[url]?.title ?? url,
            url,
            snippet: 'snippet',
            engines: ['fixture'],
            publishedAt: null,
          })),
        ),
    },
    fetcher: {
      fetch(url): Promise<FetchedDocument> {
        const page = PAGES[url];
        if (!page) return Promise.reject(new Error('not a fixture page'));
        return Promise.resolve({
          requestedUrl: url,
          finalUrl: url,
          canonicalUrl: url,
          redirects: [],
          status: 200,
          kind: 'html',
          contentType: 'text/html',
          byteLength: page.text.length,
          sha256: 'c'.repeat(64),
          retrievedAt: '2026-11-14T10:00:00.000Z',
          title: page.title,
          text: page.text,
          truncated: false,
          metadata: {},
          timings: { downloadMs: 1, extractMs: 1 },
        });
      },
    },
  };
}

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  hold = null;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Agent services on a fresh data dir, served over TCP, with research progress broadcast. */
async function setup(web: ReconfigurableWebServices | null = scriptedWeb()) {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-research-'));
  dirs.push(dir);
  const services: AgentServices = openAgentServices({
    dataDir: dir,
    env: { OLLAMA_HOST: `127.0.0.1:${ollamaPort}`, OLLAMA_MODEL: MODEL },
    ...(web && { webServices: web }),
  });
  cleanups.push(() => services.close());
  cleanups.push(() => services.whenTasksIdle());
  const token = generateToken();
  const server = await startAgentServer({
    token,
    agentVersion: '1.0.0',
    handlers: services.handlers,
    onDisconnect: (id) => services.onDisconnect(id),
  });
  services.attachEvents(server.broadcast);
  cleanups.push(() => server.close());
  const connect = async () => {
    const client = await connectAgent({ port: server.port, token });
    cleanups.push(() => client.close());
    const events: Progress[] = [];
    client.onEvent((event) => {
      if (event.method === 'ui.researchProgress') events.push(event.payload);
    });
    return { client, events };
  };
  return { services, connect, ...(await connect()) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const lastStatus = (events: Progress[], taskId: string) =>
  events.filter((e) => e.taskId === taskId).at(-1)?.taskStatus;

describe('research over the agent protocol', () => {
  it('starts a task and broadcasts its progress to every shell until it completes', async () => {
    const { client, events, connect, services } = await setup();
    const other = await connect();

    const started = await client.request('tasks.startResearch', { goal: GOAL, ...LIMITS });
    expect(started.status).toBe('ok');
    if (started.status !== 'ok') return;
    const { taskId } = started;

    await services.whenTasksIdle();
    await until(() => lastStatus(events, taskId) === 'completed', 'completed');

    const types = new Set(events.map((e) => e.type));
    expect(types).toContain('step-started');
    expect(types).toContain('step-completed');
    expect(events.every((e) => e.taskId === taskId)).toBe(true);
    const final = events.at(-1)?.progress;
    expect(final?.total).toBeGreaterThan(0);
    expect(final?.completed).toBe(final?.total);
    // Broadcast, not per-connection: the other shell saw the same progress.
    await until(() => other.events.length === events.length, 'second shell');
    expect(other.events).toEqual(events);

    await expect(client.request('tasks.get', { id: taskId })).resolves.toMatchObject({
      task: { id: taskId, status: 'completed' },
    });
    const reports = await client.request('reports.list', { taskId });
    expect(reports.items).toHaveLength(1);
  });

  it('pauses mid-step, resumes to completion, and rejects actions a status does not allow', async () => {
    const { arrived, release } = holdNext('compare-findings');
    const { client, events, services } = await setup();
    const started = await client.request('tasks.startResearch', { goal: GOAL, ...LIMITS });
    if (started.status !== 'ok') throw new Error(JSON.stringify(started));
    const { taskId } = started;

    await arrived;
    await expect(client.request('tasks.pause', { id: taskId })).resolves.toEqual({
      status: 'ok',
      taskId,
    });
    release();
    await services.whenTasksIdle();
    await until(() => lastStatus(events, taskId) === 'interrupted', 'paused (interrupted)');

    await expect(client.request('tasks.pause', { id: taskId })).resolves.toMatchObject({
      status: 'rejected',
    });
    await expect(client.request('tasks.retry', { id: taskId })).resolves.toMatchObject({
      status: 'rejected',
    });

    await expect(client.request('tasks.resume', { id: taskId })).resolves.toEqual({
      status: 'ok',
      taskId,
    });
    await services.whenTasksIdle();
    await until(() => lastStatus(events, taskId) === 'completed', 'completed after resume');
    await expect(client.request('reports.list', { taskId })).resolves.toMatchObject({
      items: [expect.anything()],
    });
  });

  it('cancels a running task', async () => {
    const { arrived, release } = holdNext('extract-evidence');
    const { client, events, services } = await setup();
    const started = await client.request('tasks.startResearch', { goal: GOAL, ...LIMITS });
    if (started.status !== 'ok') throw new Error(JSON.stringify(started));
    await arrived;
    await expect(client.request('tasks.cancel', { id: started.taskId })).resolves.toMatchObject({
      status: 'ok',
    });
    release();
    await services.whenTasksIdle();
    await until(() => lastStatus(events, started.taskId) === 'cancelled', 'cancelled');
    await expect(client.request('tasks.get', { id: started.taskId })).resolves.toMatchObject({
      task: { status: 'cancelled' },
    });
  });

  it('rejects a start the runtime refuses, and invalid params at the protocol', async () => {
    const { client, events } = await setup(null); // env has no SEARXNG_URL
    await expect(
      client.request('tasks.startResearch', { goal: GOAL, ...LIMITS }),
    ).resolves.toMatchObject({
      status: 'rejected',
      message: expect.stringContaining('Web search'),
    });
    await expect(client.request('tasks.startResearch', { goal: 'short' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(client.request('tasks.cancel', { id: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(events).toEqual([]);
  });

  it('drops progress before a server is attached (no clients yet)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rka-agent-research-'));
    dirs.push(dir);
    const services = openAgentServices({
      dataDir: dir,
      env: { OLLAMA_HOST: `127.0.0.1:${ollamaPort}`, OLLAMA_MODEL: MODEL },
      webServices: scriptedWeb(),
    });
    cleanups.push(() => services.close());
    cleanups.push(() => services.whenTasksIdle());
    const handler = services.handlers['tasks.startResearch'];
    if (!handler) throw new Error('not served');
    const result = await handler({ goal: GOAL, ...LIMITS } as never, {
      id: 1,
      closed: false,
      emit: () => undefined,
    });
    expect(result.status).toBe('ok');
    await services.whenTasksIdle();
  });
});
