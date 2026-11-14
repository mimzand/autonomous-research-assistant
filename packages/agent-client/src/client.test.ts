import { encodeFrame } from '@rka/agent-protocol';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectAgent } from './client.js';
import { fakeAck, pingHandler, startFakeAgent, type FakeHandler } from './test-fixtures.js';

const token = 'T'.repeat(43);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function fake(handle: FakeHandler) {
  const server = await startFakeAgent(handle);
  closers.push(server.close);
  return server;
}

describe('connectAgent', () => {
  it('sends a hello with the token and client, then makes typed requests', async () => {
    const server = await fake(pingHandler);
    const client = await connectAgent({
      port: server.port,
      token,
      client: { kind: 'shell', version: '1.2.3' },
    });
    expect(client.ack).toEqual(fakeAck());
    expect(server.received[0]).toMatchObject({
      kind: 'req',
      method: 'system.hello',
      payload: { protocol: 'rka-agent', version: 1, token, client: { kind: 'shell' } },
    });
    await expect(client.request('system.ping', { nonce: 'n' })).resolves.toEqual({
      agentTime: '2026-11-14T12:00:01.000Z',
    });
    client.close();
  });

  it('handles replies delivered one byte at a time', async () => {
    const server = await fake((envelope, socket) => {
      const reply = pingHandler(envelope, socket);
      if (reply === 'ignore' || reply === 'close' || reply instanceof Uint8Array) return reply;
      const bytes = encodeFrame(reply);
      bytes.forEach((_, i) => socket.write(bytes.subarray(i, i + 1)));
      return 'ignore';
    });
    const client = await connectAgent({ port: server.port, token });
    await expect(client.request('system.ping', {})).resolves.toHaveProperty('agentTime');
    client.close();
  });

  it('rejects with the agent error code when the handshake is refused', async () => {
    const server = await fake((envelope) => ({
      id: envelope.id,
      kind: 'error',
      method: envelope.method,
      payload: { code: 'unauthorized', message: 'Invalid token.' },
    }));
    await expect(connectAgent({ port: server.port, token })).rejects.toMatchObject({
      name: 'AgentClientError',
      code: 'unauthorized',
      message: 'Invalid token.',
    });
  });

  it('rejects an ack that does not match HelloAckSchema', async () => {
    const server = await fake((envelope) => ({
      id: envelope.id,
      kind: 'res',
      method: envelope.method,
      payload: { ...fakeAck(), version: 2 },
    }));
    await expect(connectAgent({ port: server.port, token })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('rejects invalid results and error replies but keeps the connection', async () => {
    let pings = 0;
    const server = await fake((envelope, socket) => {
      if (envelope.method !== 'system.ping') return pingHandler(envelope, socket);
      pings++;
      if (pings === 1) {
        return { id: envelope.id, kind: 'res', method: envelope.method, payload: { agentTime: 1 } };
      }
      if (pings === 2) {
        return {
          id: envelope.id,
          kind: 'error',
          method: envelope.method,
          payload: { code: 'busy', message: 'busy' },
        };
      }
      return pingHandler(envelope, socket);
    });
    const client = await connectAgent({ port: server.port, token });
    await expect(client.request('system.ping', {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(client.request('system.ping', {})).rejects.toMatchObject({ code: 'busy' });
    await expect(client.request('system.ping', {})).resolves.toHaveProperty('agentTime');
    client.close();
  });

  it('times out instead of hanging when the agent never answers', async () => {
    const server = await fake(() => 'ignore');
    await expect(connectAgent({ port: server.port, token, timeoutMs: 100 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('fails on a malformed frame from the agent', async () => {
    const server = await fake(() => new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]));
    await expect(connectAgent({ port: server.port, token })).rejects.toMatchObject({
      code: 'bad_frame',
    });
  });

  it('fails clearly when nothing listens on the port', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen({ host: '127.0.0.1', port: 0 }, r));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(connectAgent({ port: address.port, token })).rejects.toMatchObject({
      code: 'connect_failed',
      message: expect.stringContaining(`127.0.0.1:${address.port}`) as unknown,
    });
  });

  it('reports a closed connection to onClose and to pending requests', async () => {
    let socketRef: Socket | undefined;
    const server = await fake((envelope, socket) => {
      socketRef = socket;
      return envelope.method === 'system.ping' ? 'ignore' : pingHandler(envelope, socket);
    });
    const client = await connectAgent({ port: server.port, token });
    const closed = new Promise((resolve) => client.onClose(resolve));
    const pending = client.request('system.ping', {});
    await new Promise((r) => setTimeout(r, 20));
    socketRef?.destroy();
    await expect(pending).rejects.toMatchObject({ code: 'connection_closed' });
    await expect(closed).resolves.toMatchObject({ code: 'connection_closed' });
    await expect(client.request('system.ping', {})).rejects.toMatchObject({
      code: 'connection_closed',
    });
  });
});
