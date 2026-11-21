/**
 * Phase 7 Definition of Done, end to end: a desktop shell (AgentClient, kind
 * `shell`, with a fake key store) changes Settings in the agent service and the
 * next Chat request uses them without a restart: model, Ollama URL, web search
 * and the Ollama token (stored as ciphertext, decrypted by the shell on request).
 * Two scripted fake Ollama servers; no live model.
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
import { openAgentServices } from './services.js';
import { generateToken } from './token.js';

type ChatEvent = EventPayload<'chat.event'>;
interface Seen {
  readonly model: string;
  readonly authorization: string | undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (res: ServerResponse, value: unknown) =>
  void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));

/** A fake Ollama that records every /api/chat call and answers with its own name. */
async function fakeOllama(name: string) {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    res.setHeader('connection', 'close');
    let body = '';
    req.on('data', (part: Buffer) => (body += part.toString()));
    req.on('end', () => {
      if (req.url === '/api/version') return json(res, { version: '0.40.14' });
      if (req.url === '/api/tags') return json(res, { models: [] });
      if (req.url === '/api/show') {
        return json(res, { capabilities: ['completion'], model_info: {}, details: {} });
      }
      if (req.url !== '/api/chat') return void res.writeHead(404).end();
      const model = (JSON.parse(body) as { model: string }).model;
      seen.push({ model, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(
        `${JSON.stringify({ model, message: { role: 'assistant', content: name }, done: true, done_reason: 'stop' })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let first: Awaited<ReturnType<typeof fakeOllama>>;
let second: Awaited<ReturnType<typeof fakeOllama>>;
beforeAll(async () => {
  first = await fakeOllama('first');
  second = await fakeOllama('second');
});
afterAll(async () => {
  await first.close();
  await second.close();
});

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The shell's key store: "encrypts" to base64('enc:' + value). */
const encrypt = (value: string) => Buffer.from(`enc:${value}`).toString('base64');
const decrypt = (ciphertext: string) => {
  const text = Buffer.from(ciphertext, 'base64').toString();
  return text.startsWith('enc:') ? text.slice(4) : null;
};

async function setup(seed?: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-settings-'));
  dirs.push(dir);
  seed?.(dir);
  const services = openAgentServices({ dataDir: dir, env: {} });
  cleanups.push(() => services.close());
  cleanups.push(() => services.whenChatIdle());
  const token = generateToken();
  const server = await startAgentServer({
    token,
    agentVersion: '1.0.0',
    handlers: services.handlers,
    onDisconnect: (id) => services.onDisconnect(id),
  });
  services.attachServer(server);
  cleanups.push(() => server.close());
  const decrypted: string[] = [];
  const client = await connectAgent({
    port: server.port,
    token,
    client: { kind: 'shell', version: '1.0.0' },
  });
  cleanups.push(() => client.close());
  client.serve({
    'shell.getSecret': ({ ciphertext }) => {
      decrypted.push(ciphertext);
      return { value: decrypt(ciphertext) };
    },
    'shell.encryptionAvailable': () => ({ available: true }),
  });
  const events: ChatEvent[] = [];
  const changed: string[][] = [];
  client.onEvent((event) => {
    if (event.method === 'chat.event') events.push(event.payload);
    if (event.method === 'ui.settingsChanged') changed.push([...event.payload.changed]);
  });
  return { dir, client, events, changed, decrypted };
}

/** Runs one Chat turn and returns the assistant text (the fake server's name). */
async function chat(client: AgentClient, events: ChatEvent[]): Promise<string> {
  const started = await client.request('chat.start', { text: 'Hi' });
  if (started.status !== 'started') throw new Error(`not started: ${JSON.stringify(started)}`);
  for (let i = 0; i < 300; i++) {
    const end = events.find(
      (e) => e.streamId === started.streamId && ['done', 'error', 'cancelled'].includes(e.type),
    );
    if (end) {
      if (end.type !== 'done') throw new Error(`chat ended: ${JSON.stringify(end)}`);
      return events
        .filter((e) => e.streamId === started.streamId)
        .map((e) => (e.type === 'delta' ? e.content : ''))
        .join('');
    }
    await sleep(10);
  }
  throw new Error('no terminal event');
}

describe('Settings in the agent service (Phase 7)', () => {
  it('applies model, Ollama URL, web search and the token on the next chat, without restart', async () => {
    const { client, events, changed, decrypted } = await setup();
    const saved = await client.request('settings.update', {
      'ollama.baseUrl': first.url,
      'model.name': 'one:1b',
    });
    expect(saved).toMatchObject({ status: 'saved' });
    expect(await chat(client, events)).toBe('first');
    expect(first.seen.at(-1)).toEqual({ model: 'one:1b', authorization: undefined });

    await client.request('settings.update', {
      'ollama.baseUrl': second.url,
      'model.name': 'two:3b',
    });
    expect(await chat(client, events)).toBe('second');
    expect(second.seen.at(-1)?.model).toBe('two:3b');

    // The shell sends only ciphertext; the agent asks the shell to decrypt it.
    const stored = await client.request('settings.storeSecret', {
      key: 'ollama.authToken',
      ciphertext: encrypt('tok-123'),
    });
    expect(stored).toMatchObject({ status: 'saved', changed: ['ollama.authToken'] });
    expect(decrypted).toContain(encrypt('tok-123'));
    expect(await chat(client, events)).toBe('second');
    expect(second.seen.at(-1)).toEqual({ model: 'two:3b', authorization: 'Bearer tok-123' });

    // Web search and SearXNG apply live too.
    await client.request('settings.update', {
      'chat.webSearch': true,
      'searxng.url': 'http://127.0.0.1:8888',
    });
    const view = await client.request('settings.get', {});
    expect(view.values['chat.webSearch']).toBe(true);
    expect(view.secrets['ollama.authToken']).toMatchObject({ set: true });
    const status = await client.request('researchTools.status', {});
    expect(status.search).toMatchObject({ configured: true, endpoint: 'http://127.0.0.1:8888' });

    // Removing the token stops sending it.
    await client.request('settings.storeSecret', { key: 'ollama.authToken', ciphertext: null });
    await chat(client, events);
    expect(second.seen.at(-1)?.authorization).toBeUndefined();

    await sleep(20);
    expect(changed).toContainEqual(expect.arrayContaining(['ollama.baseUrl', 'model.name']));
    expect(changed).toContainEqual(['ollama.authToken']);
  });

  it('decrypts a token stored by an earlier run through the connected shell', async () => {
    const { client, events, decrypted } = await setup((dir) => {
      const storage = openStorage({ path: appDatabasePath(dir) });
      storage.settings.setSecretCiphertext('secret.ollama.authToken', encrypt('from-disk'));
      storage.close();
    });
    await client.request('settings.update', {
      'ollama.baseUrl': first.url,
      'model.name': 'one:1b',
    });
    expect(decrypted).toEqual([encrypt('from-disk')]);
    await chat(client, events);
    expect(first.seen.at(-1)?.authorization).toBe('Bearer from-disk');
  });

  it('keeps Ollama disconnect and connect for the session', async () => {
    const { client, events } = await setup();
    await client.request('settings.update', {
      'ollama.baseUrl': first.url,
      'model.name': 'one:1b',
    });
    await client.request('model.disconnect', {});
    expect(await client.request('model.connectionState', {})).toMatchObject({ connected: false });
    await expect(chat(client, events)).rejects.toThrow(/Disconnected from Ollama/);
    await client.request('model.connect', {});
    expect(await chat(client, events)).toBe('first');
  });
});
