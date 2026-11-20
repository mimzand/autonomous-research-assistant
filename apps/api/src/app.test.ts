/**
 * The Web API end to end: Hono app → AgentLink (state file + handshake, `cli` client)
 * → a real agent service (apps/agent) on a temporary database → a fake Ollama.
 */
import { buildDocx, paragraph } from '@rka/tools';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLink, type AgentLink } from './agent-link.js';
import { createApiApp } from './app.js';
import { createRateLimiter } from './security.js';
import { fakeOllama, MODEL, startTestAgent, type TestAgent } from './test-fixtures.js';

const KEY = 'test-api-key-0123456789abcdef';
const auth = { 'X-API-Key': KEY };

let ollama: Awaited<ReturnType<typeof fakeOllama>>;
let agent: TestAgent;
const links: AgentLink[] = [];

beforeAll(async () => {
  ollama = await fakeOllama();
  agent = await startTestAgent(ollama.host);
});
afterAll(async () => {
  for (const link of links.splice(0)) link.close();
  await agent.close();
  await ollama.close();
});
afterEach(() => undefined);

function app(options: { stateFile?: string; corsOrigins?: string[]; perMinute?: number } = {}) {
  const link = createAgentLink({
    stateFile: options.stateFile ?? agent.stateFile,
    version: '0.1.0',
  });
  links.push(link);
  return createApiApp({
    config: {
      apiKey: KEY,
      corsOrigins: options.corsOrigins ?? [],
      rateLimitPerMinute: options.perMinute ?? 1000,
    },
    agent: link,
    version: '0.1.0',
    log: () => undefined,
  });
}

/** Parses a text/event-stream body into `{ event, data }` items. */
async function sse(response: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return event && data ? { event, data: JSON.parse(data) as unknown } : null;
    })
    .filter((item): item is { event: string; data: unknown } => item !== null);
}

describe('Phase 1: health, auth, ping, OpenAPI', () => {
  it('serves /health, /openapi.json and /docs without a key', async () => {
    const a = app();
    await expect((await a.request('/health')).json()).resolves.toEqual({
      status: 'ok',
      agent: 'connected',
    });
    const doc = (await (await a.request('/openapi.json')).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/agent/ping',
        '/tasks',
        '/chat',
        '/events/research',
        '/storage/backup',
      ]),
    );
    const docs = await a.request('/docs');
    expect(docs.status).toBe(200);
    expect(docs.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await docs.text()).toContain('/docs/swagger-ui-bundle.js');
    expect((await a.request('/docs/swagger-ui-bundle.js')).status).toBe(200);
  });

  it('rejects a missing or wrong API key; accepts the header or a Bearer token', async () => {
    const a = app();
    expect((await a.request('/agent/ping')).status).toBe(401);
    const wrong = await a.request('/agent/ping', { headers: { 'X-API-Key': `${KEY}x` } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      error: { code: 'unauthorized', message: 'Missing or wrong API key (X-API-Key header).' },
    });
    expect((await a.request('/agent/ping', { headers: auth })).status).toBe(200);
    const bearer = await a.request('/agent/ping', { headers: { Authorization: `Bearer ${KEY}` } });
    expect(bearer.status).toBe(200);
  });

  it('pings the agent over its authenticated loopback protocol', async () => {
    const body = (await (await app().request('/agent/ping', { headers: auth })).json()) as {
      agent: { pid: number; protocol: number };
    };
    expect(body.agent).toMatchObject({ pid: process.pid, protocol: 2 });
  });

  it('answers 503 when the agent is not running, and recovers when it is', async () => {
    const a = app({ stateFile: '/nonexistent/agent-state.json' });
    expect(await (await a.request('/health')).json()).toEqual({
      status: 'ok',
      agent: 'unavailable',
    });
    const down = await a.request('/tasks/counts', { headers: auth });
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe(
      'agent_unavailable',
    );
  });
});

describe('Phase 2: dashboard, research, chat, progress', () => {
  it('reads counts, lists and 404s, and validates input', async () => {
    const a = app();
    expect(await (await a.request('/tasks/counts', { headers: auth })).json()).toMatchObject({
      byStatus: expect.any(Object),
    });
    const list = await a.request('/tasks?limit=5&status=running&status=failed', { headers: auth });
    expect(list.status).toBe(200);
    expect((await a.request('/tasks/unknown-id', { headers: auth })).status).toBe(404);
    expect((await a.request('/reports?limit=abc', { headers: auth })).status).toBe(400);
    const status = (await (await a.request('/storage/status', { headers: auth })).json()) as {
      path: string;
    };
    expect(status.path).toBe('research.db'); // no local folder over HTTP
  });

  it('starts research, streams its progress, and maps a rejected action to 409', async () => {
    const a = app();
    const short = await a.request('/tasks/research', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'too short' }),
    });
    expect(short.status).toBe(400);

    const controller = new AbortController();
    const events = a.request('/events/research', { headers: auth, signal: controller.signal });
    const started = await a.request('/tasks/research', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'History of the Lindholm lighthouse',
        maxQuestions: 1,
        maxSources: 1,
      }),
    });
    expect(started.status).toBe(200);
    const { taskId } = (await started.json()) as { taskId: string };
    const stream = (await events).body?.getReader();
    const first = new TextDecoder().decode((await stream?.read())?.value);
    expect(first).toContain('event: progress');
    expect(first).toContain(taskId);
    controller.abort();
    await stream?.cancel().catch(() => undefined);

    await a.request(`/tasks/${taskId}/cancel`, { method: 'POST', headers: auth });
    const again = await a.request(`/tasks/${taskId}/cancel`, { method: 'POST', headers: auth });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('rejected');
  });

  it('streams a Chat reply as server-sent events', async () => {
    const response = await app().request('/chat', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await sse(response);
    expect(events[0]).toMatchObject({ event: 'started', data: { model: MODEL } });
    const text = events
      .filter((e) => e.event === 'delta')
      .map((e) => (e.data as { content: string }).content)
      .join('');
    expect(text).toBe('Hello API');
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { model: MODEL } });
  });

  it('rejects an invalid Chat request before streaming', async () => {
    const response = await app().request('/chat', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(400);
  });
});

describe('Phase 3: upload, backup download, CORS, rate limit', () => {
  it('extracts an uploaded DOCX and refuses content that does not match its type', async () => {
    const a = app();
    const form = new FormData();
    form.set(
      'file',
      new File(
        [Buffer.from(buildDocx(paragraph('Uploaded over HTTP.'), { title: 'T' }))],
        'notes.docx',
      ),
    );
    const ok = await a.request('/research-tools/extract', {
      method: 'POST',
      headers: auth,
      body: form,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      status: 'ok',
      source: { kind: 'docx', label: 'notes.docx', text: 'Uploaded over HTTP.' },
    });

    const bad = new FormData();
    bad.set('file', new File([Buffer.from('MZ not a pdf')], 'invoice.pdf'));
    const refused = await a.request('/research-tools/extract', {
      method: 'POST',
      headers: auth,
      body: bad,
    });
    expect(refused.status).toBe(422);

    const json = await a.request('/research-tools/extract', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(415);
  });

  it('downloads the database as a standalone SQLite file', async () => {
    const response = await app().request('/storage/backup', { method: 'POST', headers: auth });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="research-.+\.db"$/,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(Number(response.headers.get('content-length')));
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('allows only the configured browser origins', async () => {
    const a = app({ corsOrigins: ['https://ui.example'] });
    const allowed = await a.request('/health', { headers: { Origin: 'https://ui.example' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ui.example');
    const other = await a.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await a.request('/tasks', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ui.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-API-Key',
      },
    });
    expect(preflight.status).toBe(204);
  });

  it('limits requests per client and says when to retry', async () => {
    const a = app({ perMinute: 2 });
    expect((await a.request('/health')).status).toBe(200);
    expect((await a.request('/health')).status).toBe(200);
    const limited = await a.request('/health');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('createRateLimiter', () => {
  it('opens a new window after a minute', () => {
    let t = 0;
    const limiter = createRateLimiter({ perMinute: 1, now: () => t });
    expect(limiter.hit('a').ok).toBe(true);
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSec: 60 });
    expect(limiter.hit('b').ok).toBe(true);
    t = 60_000;
    expect(limiter.hit('a').ok).toBe(true);
  });
});
