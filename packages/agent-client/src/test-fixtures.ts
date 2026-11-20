import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type Envelope,
  type HelloAck,
} from '@rka/agent-protocol';
import { createServer, type Server, type Socket } from 'node:net';

export const fakeAck = (): HelloAck => ({
  protocol: PROTOCOL_NAME,
  version: PROTOCOL_VERSION,
  sessionId: '7d3b2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  agent: { pid: 4242, version: 'fake', startedAt: '2026-11-14T12:00:00.000Z' },
});

/** What the fake server does with one incoming request envelope. */
export type FakeHandler = (
  envelope: Envelope,
  socket: Socket,
) => Envelope | Uint8Array | 'ignore' | 'close';

/** Loopback server that speaks the frame codec; `handle` decides every reply. */
export async function startFakeAgent(
  handle: FakeHandler,
): Promise<{ port: number; received: Envelope[]; close(): Promise<void> }> {
  const received: Envelope[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const result of decoder.push(chunk)) {
        if (result.ok) received.push(result.value);
        const reply = result.ok ? handle(result.value, socket) : 'close';
        if (reply === 'ignore') continue;
        if (reply === 'close') {
          socket.destroy();
          return;
        }
        socket.write(reply instanceof Uint8Array ? reply : encodeFrame(reply));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    port: address.port,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Accepts the hello and answers system.ping; anything else gets `not_implemented`. */
export const pingHandler: FakeHandler = (envelope) => {
  if (envelope.method === 'system.hello') {
    return { id: envelope.id, kind: 'res', method: envelope.method, payload: fakeAck() };
  }
  if (envelope.method === 'system.ping') {
    return {
      id: envelope.id,
      kind: 'res',
      method: envelope.method,
      payload: { agentTime: '2026-11-14T12:00:01.000Z' },
    };
  }
  return {
    id: envelope.id,
    kind: 'error',
    method: envelope.method,
    payload: { code: 'not_implemented', message: 'later' },
  };
};
