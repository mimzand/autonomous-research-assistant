import {
  AGENT_LOOPBACK_HOST,
  AgentTokenSchema,
  encodeFrame,
  FrameDecoder,
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  parseEvent,
  parseHello,
  parseRequest,
  parseResult,
  protocolError,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  UNATTRIBUTED_ERROR_METHOD,
  type Envelope,
  type EventEnvelope,
  type EventName,
  type EventPayload,
  type ClientKind,
  type HelloAck,
  type ParsedRequest,
  type ProtocolError,
  type RequestEnvelope,
  type RequestMethodName,
  type ShellMethodName,
} from '@rka/agent-protocol';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { runWithConnection, ShellCallError } from './connection-context.js';
import { type AgentConnection, type RequestHandlers } from './handlers.js';
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
  /** Called once when an authenticated connection closes (e.g. to stop its Chat stream). */
  readonly onDisconnect?: (connectionId: number) => void;
  /** Must never receive the token. */
  readonly log?: (message: string) => void;
  /**
   * `system.shutdown` (Phase 8): called after the reply is sent, for a `shell`
   * connection only. Without it the method answers `not_implemented`.
   */
  readonly onShutdown?: () => void;
}

/** Pushes one event to every authenticated client (e.g. research progress). */
export type AgentBroadcast = <E extends EventName>(method: E, payload: EventPayload<E>) => void;

export interface AgentServer {
  readonly host: typeof AGENT_LOOPBACK_HOST;
  readonly port: number;
  readonly startedAt: string;
  /** Each connection validates the event (`parseEvent`) and drops it if invalid. */
  readonly broadcast: AgentBroadcast;
  /** Open authenticated connections, oldest first. */
  connections(): readonly AgentConnection[];
  close(): Promise<void>;
}

/** What services need from a running server: events out, and who is connected. */
export type AgentServerLink = Pick<AgentServer, 'broadcast' | 'connections'>;

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

  let nextConnectionId = 1;
  const clients = new Set<AgentConnection>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serveConnection(socket, {
      id: nextConnectionId++,
      token: options.token,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      handlers: options.handlers ?? {},
      onAuthenticated: (connection) => clients.add(connection),
      onDisconnect: (connection) => {
        clients.delete(connection);
        options.onDisconnect?.(connection.id);
      },
      ack,
      log,
      ...(options.onShutdown && { onShutdown: options.onShutdown }),
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
    broadcast: (method, payload) => {
      for (const connection of [...clients]) connection.emit(method, payload);
    },
    connections: () => [...clients].filter((connection) => !connection.closed),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

interface ConnectionContext {
  readonly id: number;
  readonly token: string;
  readonly handshakeTimeoutMs: number;
  readonly handlers: RequestHandlers;
  readonly onAuthenticated: (connection: AgentConnection) => void;
  readonly onDisconnect: (connection: AgentConnection) => void;
  readonly ack: () => HelloAck;
  readonly log: (message: string) => void;
  readonly onShutdown?: () => void;
}

function serveConnection(socket: Socket, ctx: ConnectionContext): void {
  const decoder = new FrameDecoder(HANDSHAKE_MAX_FRAME_BYTES);
  let authenticated = false;
  let closing = false;
  let clientKind: ClientKind = 'cli';
  /** Reverse calls waiting for the client's answer, by request id. */
  const calls = new Map<string, PendingCall>();

  const send = (envelope: Envelope) => {
    if (!socket.destroyed) socket.write(encodeFrame(envelope));
  };
  const settleCall = (id: string): PendingCall | undefined => {
    const pending = calls.get(id);
    if (!pending) return undefined;
    calls.delete(id);
    clearTimeout(pending.timer);
    return pending;
  };

  const connection: AgentConnection = {
    id: ctx.id,
    get kind() {
      return clientKind;
    },
    get closed() {
      return socket.destroyed;
    },
    call(method, params, { timeoutMs }) {
      const envelope: RequestEnvelope = { id: randomUUID(), kind: 'req', method, payload: params };
      const checked = parseRequest(envelope, 'toShell');
      if (!checked.ok) {
        return Promise.reject(new ShellCallError(checked.error.code, checked.error.message));
      }
      if (socket.destroyed || closing) {
        return Promise.reject(
          new ShellCallError('shell_unavailable', `The shell disconnected before ${method}.`),
        );
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settleCall(envelope.id);
          reject(new ShellCallError('timeout', `${method} got no answer from the shell in time.`));
        }, timeoutMs);
        timer.unref();
        calls.set(envelope.id, {
          method,
          timer,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        send({ ...envelope, payload: checked.value.params });
      });
    },
    emit(method, payload) {
      if (socket.destroyed) return;
      const envelope: EventEnvelope = { id: randomUUID(), kind: 'event', method, payload };
      const checked = parseEvent(envelope, 'toShell');
      if (!checked.ok) {
        ctx.log(`Refusing to send an invalid ${method} event.`);
        return;
      }
      send({ ...envelope, payload: checked.value.payload });
    },
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
    clientKind = hello.value.hello.client.kind;
    decoder.maxFrameBytes = MAX_FRAME_BYTES;
    reply(hello.value.id, 'system.hello', ctx.ack());
    ctx.onAuthenticated(connection);
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
      case 'system.shutdown': {
        const stop = ctx.onShutdown;
        if (!stop) {
          return sendError(
            request.id,
            request.method,
            protocolError('not_implemented', 'system.shutdown is not served by this agent.'),
          );
        }
        // Only the desktop shell that supervises the agent may stop it.
        if (clientKind !== 'shell') {
          return sendError(
            request.id,
            request.method,
            protocolError('bad_request', 'Only the desktop shell can stop the agent.'),
          );
        }
        ctx.log('Shutdown requested by the desktop shell.');
        reply(request.id, request.method, null);
        setImmediate(stop);
        return;
      }
      default: {
        const handler = ctx.handlers[request.method] as Handler | undefined;
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
  const serve = async (request: ParsedRequest, handler: Handler) => {
    let result: unknown;
    try {
      result = await runWithConnection(connection, () => handler(request.params, connection));
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
    answerCall(envelope);
  };

  /** Settles a reverse call with the client's res/error; anything unmatched is ignored. */
  const answerCall = (envelope: Envelope) => {
    const pending = calls.get(envelope.id);
    if (!pending || envelope.method !== pending.method) {
      ctx.log(`Ignoring unsolicited ${envelope.kind} for ${envelope.method}.`);
      return;
    }
    settleCall(envelope.id);
    if (envelope.kind === 'error') {
      return pending.reject(new ShellCallError(envelope.payload.code, envelope.payload.message));
    }
    const result = parseResult(pending.method, envelope.payload);
    if (!result.ok) {
      ctx.log(`Rejecting an invalid ${pending.method} result from the shell.`);
      return pending.reject(new ShellCallError(result.error.code, result.error.message));
    }
    pending.resolve(result.value);
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
  socket.on('close', () => {
    clearTimeout(handshakeTimer);
    for (const id of [...calls.keys()]) {
      const pending = settleCall(id);
      pending?.reject(
        new ShellCallError('shell_unavailable', `The shell disconnected during ${pending.method}.`),
      );
    }
    if (!authenticated) return;
    try {
      ctx.onDisconnect(connection);
    } catch (error) {
      ctx.log(
        `Disconnect handling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

type Handler = (params: unknown, connection: AgentConnection) => unknown;

interface PendingCall {
  readonly method: ShellMethodName;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: ShellCallError) => void;
}
