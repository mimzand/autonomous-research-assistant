import {
  AGENT_LOOPBACK_HOST,
  AgentTokenSchema,
  encodeFrame,
  FrameDecoder,
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  parseHello,
  parseRequest,
  parseResult,
  protocolError,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  UNATTRIBUTED_ERROR_METHOD,
  type Envelope,
  type HelloAck,
  type ParsedRequest,
  type ProtocolError,
  type RequestMethodName,
} from '@rka/agent-protocol';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { type RequestHandlers } from './handlers.js';
import { tokensEqual } from './token.js';

/** Frame limit before the handshake; a hello is a few hundred bytes. */
export const HANDSHAKE_MAX_FRAME_BYTES = 64 * 1024;
/** How long a rejected client gets to read the error before the socket is destroyed. */
const CLOSE_GRACE_MS = 1_000;
const MAX_CONNECTIONS = 16;

export interface AgentServerOptions {
  /** Session token clients must present (AgentTokenSchema). */
  readonly token: string;
  /** 0 (default) picks an ephemeral port. */
  readonly port?: number;
  readonly agentVersion: string;
  readonly handshakeTimeoutMs?: number;
  /** Methods served after the handshake besides `system.*`. */
  readonly handlers?: RequestHandlers;
  /** Must never receive the token. */
  readonly log?: (message: string) => void;
}

export interface AgentServer {
  readonly host: typeof AGENT_LOOPBACK_HOST;
  readonly port: number;
  readonly startedAt: string;
  close(): Promise<void>;
}

/** Starts the protocol server on 127.0.0.1 only. */
export async function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  if (!AgentTokenSchema.safeParse(options.token).success) {
    throw new Error('The agent token does not meet AgentTokenSchema.');
  }
  const log = options.log ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const sockets = new Set<Socket>();
  const ack = (): HelloAck => ({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    sessionId: randomUUID(),
    agent: { pid: process.pid, version: options.agentVersion, startedAt },
  });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, {
      token: options.token,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      handlers: options.handlers ?? {},
      ack,
      log,
    });
  });
  server.maxConnections = MAX_CONNECTIONS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: AGENT_LOOPBACK_HOST, port: options.port ?? 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('The agent server has no TCP address.');
  }

  return {
    host: AGENT_LOOPBACK_HOST,
    port: address.port,
    startedAt,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

interface ConnectionContext {
  readonly token: string;
  readonly handshakeTimeoutMs: number;
  readonly handlers: RequestHandlers;
  readonly ack: () => HelloAck;
  readonly log: (message: string) => void;
}

function serveConnection(socket: Socket, ctx: ConnectionContext): void {
  const decoder = new FrameDecoder(HANDSHAKE_MAX_FRAME_BYTES);
  let authenticated = false;
  let closing = false;

  const send = (envelope: Envelope) => {
    if (!socket.destroyed) socket.write(encodeFrame(envelope));
  };
  const sendError = (id: string, method: string, error: ProtocolError) =>
    send({ id, kind: 'error', method, payload: error });
  /** Sends a final error, then closes. Used for every handshake and framing failure. */
  const reject = (id: string, method: string, error: ProtocolError) => {
    if (closing) return;
    closing = true;
    clearTimeout(handshakeTimer);
    ctx.log(`Connection rejected: ${error.code}.`);
    if (!socket.destroyed) socket.end(encodeFrame({ id, kind: 'error', method, payload: error }));
    setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
  };

  const handshakeTimer = setTimeout(
    () =>
      reject(
        randomUUID(),
        UNATTRIBUTED_ERROR_METHOD,
        protocolError('unauthorized', 'Handshake timed out.'),
      ),
    ctx.handshakeTimeoutMs,
  );
  handshakeTimer.unref();

  const handshake = (envelope: Envelope) => {
    const hello = parseHello(envelope);
    if (!hello.ok) return reject(envelope.id, envelope.method, hello.error);
    if (!tokensEqual(hello.value.hello.token, ctx.token)) {
      return reject(envelope.id, envelope.method, protocolError('unauthorized', 'Invalid token.'));
    }
    clearTimeout(handshakeTimer);
    authenticated = true;
    decoder.maxFrameBytes = MAX_FRAME_BYTES;
    reply(hello.value.id, 'system.hello', ctx.ack());
    ctx.log(`Client authenticated (${hello.value.hello.client.kind}).`);
  };

  function reply(id: string, method: RequestMethodName, result: unknown) {
    const checked = parseResult(method, result);
    if (!checked.ok) {
      ctx.log(`Refusing to send an invalid ${method} result.`);
      return sendError(id, method, protocolError('internal', 'Invalid result.'));
    }
    send({ id, kind: 'res', method, payload: checked.value });
  }

  const dispatch = (request: ParsedRequest) => {
    switch (request.method) {
      case 'system.ping':
        return reply(request.id, request.method, {
          nonce: request.params.nonce,
          agentTime: new Date().toISOString(),
        });
      case 'system.hello':
        return sendError(
          request.id,
          request.method,
          protocolError('bad_request', 'Already authenticated.'),
        );
      default: {
        const handler = ctx.handlers[request.method] as ((params: unknown) => unknown) | undefined;
        if (!handler) {
          return sendError(
            request.id,
            request.method,
            protocolError('not_implemented', `${request.method} is not served yet.`),
          );
        }
        return void serve(request, handler);
      }
    }
  };

  /** Runs a handler; a failure is logged here and answered without its details. */
  const serve = async (request: ParsedRequest, handler: (params: unknown) => unknown) => {
    let result: unknown;
    try {
      result = await handler(request.params);
    } catch (error) {
      ctx.log(
        `${request.method} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return sendError(
        request.id,
        request.method,
        protocolError('internal', `${request.method} failed in the agent.`),
      );
    }
    reply(request.id, request.method, result);
  };

  const handle = (envelope: Envelope) => {
    if (envelope.kind === 'req') {
      const request = parseRequest(envelope, 'toAgent');
      if (!request.ok) return sendError(envelope.id, envelope.method, request.error);
      return dispatch(request.value);
    }
    if (envelope.kind === 'event') {
      return sendError(
        envelope.id,
        envelope.method,
        protocolError('unknown_method', `Unknown event: ${envelope.method}.`),
      );
    }
    // No reverse requests exist yet, so any res/error from the client is unsolicited.
    ctx.log(`Ignoring unsolicited ${envelope.kind} for ${envelope.method}.`);
  };

  socket.on('data', (chunk: Buffer) => {
    if (closing) return;
    for (const result of decoder.push(chunk)) {
      if (!result.ok) return reject(randomUUID(), UNATTRIBUTED_ERROR_METHOD, result.error);
      if (authenticated) handle(result.value);
      else handshake(result.value);
      if (closing) return;
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => clearTimeout(handshakeTimer));
}
