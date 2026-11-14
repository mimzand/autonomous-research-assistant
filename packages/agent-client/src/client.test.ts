import { encodeFrame, PROTOCOL_VERSION } from '@rka/agent-protocol';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      payload: {
        protocol: 'rka-agent',
        version: PROTOCOL_VERSION,
        token,
        client: { kind: 'shell' },
      },
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
      payload: { ...fakeAck(), version: PROTOCOL_VERSION + 1 },
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

  it('lets a request override the timeout', async () => {
    const server = await fake((envelope, socket) =>
      envelope.method === 'system.hello' ? pingHandler(envelope, socket) : 'ignore',
    );
    const client = await connectAgent({ port: server.port, token, timeoutMs: 5_000 });
    const started = performance.now();
    await expect(client.request('system.ping', {}, { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    client.close();
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

  it('delivers valid pushed events to subscribers and drops invalid ones', async () => {
    const streamId = '3b241101-e2bb-4255-8caf-4136c566a962';
    const server = await fake((envelope, socket) => {
      if (envelope.method === 'system.ping') {
        let n = 0;
        const event = (method: string, payload: unknown) =>
          socket.write(encodeFrame({ id: `e${++n}`, kind: 'event', method, payload }));
        event('chat.event', { type: 'delta', streamId, content: 'Hel' });
        event('chat.event', { type: 'eval', streamId }); // not a ChatEvent
        event('tasks.mystery', {}); // not a registered event
        event('chat.event', { type: 'cancelled', streamId });
      }
      return pingHandler(envelope, socket);
    });
    const client = await connectAgent({ port: server.port, token });
    const seen: unknown[] = [];
    const removed: unknown[] = [];
    client.onEvent(() => {
      throw new Error('a broken listener');
    });
    client.onEvent((event) => seen.push(event));
    const unsubscribe = client.onEvent((event) => removed.push(event));
    unsubscribe();

    await expect(client.request('system.ping', {})).resolves.toBeTruthy();
    expect(seen).toEqual([
      { id: 'e1', method: 'chat.event', payload: { type: 'delta', streamId, content: 'Hel' } },
      { id: 'e4', method: 'chat.event', payload: { type: 'cancelled', streamId } },
    ]);
    expect(removed).toEqual([]);
    client.close();
  });

  it('serves validated reverse requests and never echoes handler errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await fake((envelope, socket) => {
      if (envelope.method === 'system.ping') {
        const ask = (id: string, method: string, payload: unknown) =>
          socket.write(encodeFrame({ id, kind: 'req', method, payload }));
        ask('r1', 'shell.chooseFile', {});
        ask('r2', 'shell.getSecret', { key: 'ollama.authToken', ciphertext: 'c2VjcmV0' });
        ask('r3', 'shell.chooseFolder', { defaultPath: 5 });
        ask('r4', 'tasks.counts', {});
        ask('r5', 'shell.encryptionAvailable', {});
        ask('r6', 'shell.chooseBackupPath', {});
      }
      return envelope.kind === 'req' ? pingHandler(envelope, socket) : 'ignore';
    });
    const client = await connectAgent({ port: server.port, token });
    client.serve({
      'shell.chooseFile': () => ({ path: 'C:\\docs\\a.pdf' }),
      'shell.getSecret': () => {
        throw new Error('secret-value-xyz');
      },
      'shell.chooseFolder': () => ({ path: null }),
      'shell.chooseBackupPath': () => ({ path: 3 }) as never,
    });
    await client.request('system.ping', {});
    const answers = () => server.received.filter((e) => e.kind === 'res' || e.kind === 'error');
    await vi.waitFor(() => expect(answers()).toHaveLength(6));
    const byId = Object.fromEntries(answers().map((e) => [e.id, e]));
    expect(byId['r1']).toMatchObject({ kind: 'res', payload: { path: 'C:\\docs\\a.pdf' } });
    expect(byId['r2']).toEqual({
      id: 'r2',
      kind: 'error',
      method: 'shell.getSecret',
      payload: { code: 'internal', message: 'shell.getSecret failed in the shell.' },
    });
    expect(byId['r3']).toMatchObject({ kind: 'error', payload: { code: 'bad_request' } });
    expect(byId['r4']).toMatchObject({ kind: 'error', payload: { code: 'unknown_method' } });
    expect(byId['r5']).toMatchObject({ kind: 'error', payload: { code: 'not_implemented' } });
    expect(byId['r6']).toMatchObject({ kind: 'error', payload: { code: 'internal' } });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value-xyz');
    warn.mockRestore();
    client.close();
  });
});
