import {
  AGENT_LOOPBACK_HOST,
  encodeFrame,
  FrameDecoder,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  parseEvent,
  parseResult,
  type ClientKind,
  type HelloAck,
  type ParsedEvent,
  type ProtocolErrorCode,
  type RequestMethodName,
  type RequestParamsInput,
  type RequestResult,
} from '@rka/agent-protocol';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;

export type AgentClientErrorCode =
  | ProtocolErrorCode
  /** No state file, or it names a process that is not running. */
  | 'not_running'
  /** The state file exists but does not match AgentStateFileSchema (e.g. a non-loopback host). */
  | 'state_file_invalid'
  /** The TCP connection to 127.0.0.1 could not be opened. */
  | 'connect_failed'
  | 'connection_closed';

/** An `error` envelope from the agent, or a local connection failure. Never carries the token. */
export class AgentClientError extends Error {
  constructor(
    readonly code: AgentClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentClientError';
  }
}

export interface AgentClientOptions {
  readonly port: number;
  readonly token: string;
  readonly client?: { readonly kind: ClientKind; readonly version: string };
  /** Limit for the TCP connect, the handshake and each request (default 10 s). */
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  /** Overrides the client's `timeoutMs` for this request. */
  readonly timeoutMs?: number;
}

export interface AgentClient {
  readonly ack: HelloAck;
  request<M extends RequestMethodName>(
    method: M,
    params: RequestParamsInput<M>,
    options?: RequestOptions,
  ): Promise<RequestResult<M>>;
  /**
   * Subscribes to events the agent pushes (e.g. `chat.event`). Each event is
   * validated with `parseEvent`; invalid ones are dropped. Returns an unsubscribe function.
   */
  onEvent(listener: (event: ParsedEvent) => void): () => void;
  /** Called once when the connection ends for any reason (including `close()`). */
  onClose(listener: (error: AgentClientError) => void): void;
  close(): void;
}

interface Pending {
  readonly method: RequestMethodName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function openSocket(port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: AGENT_LOOPBACK_HOST, port });
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new AgentClientError('connect_failed', message));
    };
    const timer = setTimeout(
      () => fail(`Connecting to ${AGENT_LOOPBACK_HOST}:${port} timed out.`),
      timeoutMs,
    );
    socket.once('error', (error: NodeJS.ErrnoException) =>
      fail(`Cannot connect to ${AGENT_LOOPBACK_HOST}:${port} (${error.code ?? error.message}).`),
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
}

/** A failing listener must not break the connection or the other listeners. */
function notify(listener: (event: ParsedEvent) => void, event: ParsedEvent): void {
  try {
    listener(event);
  } catch (error) {
    console.error('Agent event listener failed:', error);
  }
}

/** Connects to the agent on 127.0.0.1 and completes the `system.hello` handshake. */
export async function connectAgent(options: AgentClientOptions): Promise<AgentClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await openSocket(options.port, timeoutMs);

  const decoder = new FrameDecoder();
  const pending = new Map<string, Pending>();
  const closeListeners: ((error: AgentClientError) => void)[] = [];
  const eventListeners = new Set<(event: ParsedEvent) => void>();
  let closeReason: AgentClientError | null = null;
  const failAll = (error: AgentClientError) => {
    closeReason ??= error;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  socket.on('data', (chunk: Buffer) => {
    for (const result of decoder.push(chunk)) {
      if (!result.ok) {
        failAll(new AgentClientError(result.error.code, result.error.message));
        socket.destroy();
        return;
      }
      const envelope = result.value;
      if (envelope.kind === 'event') {
        const event = parseEvent(envelope, 'toShell');
        if (event.ok) for (const listener of [...eventListeners]) notify(listener, event.value);
        continue;
      }
      if (envelope.kind !== 'res' && envelope.kind !== 'error') continue;
      const p = pending.get(envelope.id);
      if (!p) {
        if (envelope.kind === 'error') {
          failAll(new AgentClientError(envelope.payload.code, envelope.payload.message));
        }
        continue;
      }
      pending.delete(envelope.id);
      clearTimeout(p.timer);
      if (envelope.kind === 'error') {
        p.reject(new AgentClientError(envelope.payload.code, envelope.payload.message));
        continue;
      }
      const checked = parseResult(p.method, envelope.payload);
      if (checked.ok) p.resolve(checked.value);
      else p.reject(new AgentClientError(checked.error.code, checked.error.message));
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    failAll(new AgentClientError('connection_closed', 'The agent closed the connection.'));
    const reason = closeReason ?? new AgentClientError('connection_closed', 'Closed.');
    for (const listener of closeListeners.splice(0)) listener(reason);
  });

  const request = <M extends RequestMethodName>(
    method: M,
    params: RequestParamsInput<M>,
    requestOptions: RequestOptions = {},
  ): Promise<RequestResult<M>> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new AgentClientError('connection_closed', 'The connection is closed.'));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AgentClientError('timeout', `${method} timed out.`));
      }, requestOptions.timeoutMs ?? timeoutMs);
      pending.set(id, {
        method,
        resolve: (value) => resolve(value as RequestResult<M>),
        reject,
        timer,
      });
      socket.write(encodeFrame({ id, kind: 'req', method, payload: params }));
    });

  try {
    const ack = await request('system.hello', {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      token: options.token,
      client: options.client ?? { kind: 'cli', version: '0.0.0' },
    });
    return {
      ack,
      request,
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => void eventListeners.delete(listener);
      },
      onClose: (listener) => {
        if (socket.destroyed)
          listener(closeReason ?? new AgentClientError('connection_closed', 'Closed.'));
        else closeListeners.push(listener);
      },
      close: () => {
        closeReason ??= new AgentClientError('connection_closed', 'Closed by the client.');
        socket.destroy();
      },
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
