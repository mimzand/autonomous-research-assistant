import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type Envelope,
} from '@rka/agent-protocol';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAgent } from '@rka/agent-client';
import { startAgentServer, type AgentServer } from './server.js';
import { generateToken } from './token.js';

const token = generateToken();
const servers: AgentServer[] = [];

async function start(options: { handshakeTimeoutMs?: number } = {}) {
  const server = await startAgentServer({ token, agentVersion: '9.9.9', ...options });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const hello = (overrides: Record<string, unknown> = {}): Envelope => ({
  id: 'h1',
  kind: 'req',
  method: 'system.hello',
  payload: {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    token,
    client: { kind: 'test', version: '0' },
    ...overrides,
  },
});
const req = (id: string, method: string, payload: unknown = {}): Envelope => ({
  id,
  kind: 'req',
  method,
  payload,
});

/**
 * Raw client: sends `frames` (Envelopes are encoded; Uint8Arrays are sent as-is) and
 * collects envelopes until the server closes or `expected` envelopes arrived.
 */
function exchange(
  port: number,
  frames: (Envelope | Uint8Array)[],
  expected = Infinity,
): Promise<{ envelopes: Envelope[]; closedByServer: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const decoder = new FrameDecoder();
    const envelopes: Envelope[] = [];
    let done = false;
    const finish = (closedByServer: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ envelopes, closedByServer });
    };
    socket.on('connect', () => {
      for (const f of frames) socket.write(f instanceof Uint8Array ? f : encodeFrame(f));
    });
    socket.on('data', (chunk: Buffer) => {
      for (const r of decoder.push(chunk)) if (r.ok) envelopes.push(r.value);
      if (envelopes.length >= expected) finish(false);
    });
    socket.on('end', () => finish(true));
    socket.on('close', () => finish(true));
    socket.on('error', reject);
  });
}

describe('agent server over 127.0.0.1 TCP', () => {
  it('binds the loopback address on an ephemeral port', async () => {
    const server = await start();
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
  });

  it('refuses to start with a weak token', async () => {
    await expect(startAgentServer({ token: 'short', agentVersion: '1' })).rejects.toThrow(
      /AgentTokenSchema/,
    );
  });

  it('completes the handshake and answers system.ping', async () => {
    const server = await start();
    const client = await connectAgent({ port: server.port, token });
    try {
      expect(client.ack).toMatchObject({
        protocol: PROTOCOL_NAME,
        version: PROTOCOL_VERSION,
        agent: { pid: process.pid, version: '9.9.9', startedAt: server.startedAt },
      });
      const pong = await client.request('system.ping', { nonce: 'n-1' });
      expect(pong.nonce).toBe('n-1');
      expect(Date.parse(pong.agentTime)).not.toBeNaN();
      // The connection stays usable.
      await expect(client.request('system.ping', {})).resolves.toHaveProperty('agentTime');
    } finally {
      client.close();
    }
  });

  it('gives each connection its own session id', async () => {
    const server = await start();
    const a = await connectAgent({ port: server.port, token });
    const b = await connectAgent({ port: server.port, token });
    expect(a.ack.sessionId).not.toBe(b.ack.sessionId);
    a.close();
    b.close();
  });

  it('rejects a wrong token and closes the connection', async () => {
    const server = await start();
    await expect(connectAgent({ port: server.port, token: generateToken() })).rejects.toMatchObject(
      { code: 'unauthorized' },
    );
    const { envelopes, closedByServer } = await exchange(server.port, [
      hello({ token: generateToken() }),
      req('p1', 'system.ping'),
    ]);
    expect(closedByServer).toBe(true);
    expect(envelopes).toEqual([
      {
        id: 'h1',
        kind: 'error',
        method: 'system.hello',
        payload: { code: 'unauthorized', message: 'Invalid token.' },
      },
    ]);
  });

  it('rejects a token of a different length without leaking it', async () => {
    const server = await start();
    const { envelopes, closedByServer } = await exchange(server.port, [
      hello({ token: `${token}x` }),
    ]);
    expect(closedByServer).toBe(true);
    expect(envelopes[0]?.payload).toEqual({ code: 'unauthorized', message: 'Invalid token.' });
    expect(JSON.stringify(envelopes)).not.toContain(token);
  });

  it('rejects requests before the handshake', async () => {
    const server = await start();
    const { envelopes, closedByServer } = await exchange(server.port, [req('p1', 'system.ping')]);
    expect(closedByServer).toBe(true);
    expect(envelopes).toMatchObject([
      { id: 'p1', kind: 'error', payload: { code: 'unauthorized' } },
    ]);
  });

  it('reports an unsupported protocol version', async () => {
    const server = await start();
    const { envelopes, closedByServer } = await exchange(server.port, [
      hello({ version: PROTOCOL_VERSION + 1 }),
    ]);
    expect(closedByServer).toBe(true);
    expect(envelopes).toMatchObject([{ kind: 'error', payload: { code: 'unsupported_version' } }]);
  });

  it('disconnects a client that never says hello', async () => {
    const server = await start({ handshakeTimeoutMs: 50 });
    const { envelopes, closedByServer } = await exchange(server.port, []);
    expect(closedByServer).toBe(true);
    expect(envelopes).toMatchObject([
      {
        kind: 'error',
        method: 'system.error',
        payload: { code: 'unauthorized', message: 'Handshake timed out.' },
      },
    ]);
  });

  it('caps frames before the handshake and drops HTTP requests', async () => {
    const server = await start();
    const big = new Uint8Array(4);
    new DataView(big.buffer).setUint32(0, 1024 * 1024, false);
    const oversized = await exchange(server.port, [big]);
    expect(oversized.closedByServer).toBe(true);
    expect(oversized.envelopes).toMatchObject([{ payload: { code: 'bad_frame' } }]);

    const http = new TextEncoder().encode('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    const browser = await exchange(server.port, [http]);
    expect(browser.closedByServer).toBe(true);
    expect(browser.envelopes).toMatchObject([{ payload: { code: 'bad_frame' } }]);
  });

  it('answers bad requests after the handshake without closing', async () => {
    const server = await start();
    const { envelopes } = await exchange(
      server.port,
      [
        hello(),
        req('u1', 'system.exec'),
        req('d1', 'shell.chooseFile'),
        req('b1', 'system.ping', { nonce: 7 }),
        req('n1', 'tasks.counts'),
        req('h2', 'system.hello', hello().payload),
        { id: 'e1', kind: 'event', method: 'chat.event', payload: {} },
        req('p1', 'system.ping', { nonce: 'still-open' }),
      ],
      8,
    );
    const byId = Object.fromEntries(envelopes.map((e) => [e.id, e]));
    expect(byId['h1']).toMatchObject({ kind: 'res', method: 'system.hello' });
    expect(byId['u1']).toMatchObject({ kind: 'error', payload: { code: 'unknown_method' } });
    expect(byId['d1']).toMatchObject({ kind: 'error', payload: { code: 'unknown_method' } });
    expect(byId['b1']).toMatchObject({ kind: 'error', payload: { code: 'bad_request' } });
    expect(byId['n1']).toMatchObject({ kind: 'error', payload: { code: 'not_implemented' } });
    expect(byId['h2']).toMatchObject({ kind: 'error', payload: { code: 'bad_request' } });
    expect(byId['e1']).toMatchObject({ kind: 'error', payload: { code: 'unknown_method' } });
    expect(byId['p1']).toMatchObject({ kind: 'res', payload: { nonce: 'still-open' } });
  });

  it('closes on a malformed frame after the handshake', async () => {
    const server = await start();
    const empty = new Uint8Array(4); // zero-length body: not JSON
    const { envelopes, closedByServer } = await exchange(server.port, [hello(), empty]);
    expect(closedByServer).toBe(true);
    expect(envelopes.at(-1)).toMatchObject({
      kind: 'error',
      method: 'system.error',
      payload: { code: 'bad_frame' },
    });
  });

  it('disconnects clients on close', async () => {
    const server = await start();
    const client = await connectAgent({ port: server.port, token });
    await server.close();
    await expect(client.request('system.ping', {})).rejects.toMatchObject({
      code: 'connection_closed',
    });
  });
});
