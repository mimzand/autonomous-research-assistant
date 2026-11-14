import {
  AGENT_LOOPBACK_HOST,
  encodeFrame,
  FrameDecoder,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  parseResult,
  type ClientKind,
  type HelloAck,
  type ProtocolErrorCode,
  type RequestMethodName,
  type RequestParamsInput,
  type RequestResult,
} from '@rka/agent-protocol';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

const DEFAULT_TIMEOUT_MS = 10_000;

/** An `error` envelope from the agent, or a local protocol failure. */
export class AgentProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode | 'connection_closed',
    message: string,
  ) {
    super(message);
    this.name = 'AgentProtocolError';
  }
}

export interface AgentClientOptions {
  readonly port: number;
  readonly token: string;
  readonly client?: { readonly kind: ClientKind; readonly version: string };
  readonly timeoutMs?: number;
}

export interface AgentClient {
  readonly ack: HelloAck;
  request<M extends RequestMethodName>(
    method: M,
    params: RequestParamsInput<M>,
  ): Promise<RequestResult<M>>;
  close(): void;
}

interface Pending {
  readonly method: RequestMethodName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Connects to the agent on 127.0.0.1 and completes the `system.hello` handshake. */
export async function connectAgent(options: AgentClientOptions): Promise<AgentClient> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ host: AGENT_LOOPBACK_HOST, port: options.port }, () => {
      s.off('error', reject);
      resolve(s);
    });
    s.once('error', reject);
  });

  const decoder = new FrameDecoder();
  const pending = new Map<string, Pending>();
  const failAll = (error: AgentProtocolError) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  socket.on('data', (chunk: Buffer) => {
    for (const result of decoder.push(chunk)) {
      if (!result.ok) {
        failAll(new AgentProtocolError(result.error.code, result.error.message));
        socket.destroy();
        return;
      }
      const envelope = result.value;
      if (envelope.kind !== 'res' && envelope.kind !== 'error') continue;
      const p = pending.get(envelope.id);
      if (!p) {
        if (envelope.kind === 'error') {
          failAll(new AgentProtocolError(envelope.payload.code, envelope.payload.message));
        }
        continue;
      }
      pending.delete(envelope.id);
      clearTimeout(p.timer);
      if (envelope.kind === 'error') {
        p.reject(new AgentProtocolError(envelope.payload.code, envelope.payload.message));
        continue;
      }
      const checked = parseResult(p.method, envelope.payload);
      if (checked.ok) p.resolve(checked.value);
      else p.reject(new AgentProtocolError(checked.error.code, checked.error.message));
    }
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () =>
    failAll(new AgentProtocolError('connection_closed', 'The agent closed the connection.')),
  );

  const request = <M extends RequestMethodName>(
    method: M,
    params: RequestParamsInput<M>,
  ): Promise<RequestResult<M>> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new AgentProtocolError('connection_closed', 'The connection is closed.'));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AgentProtocolError('timeout', `${method} timed out.`));
      }, timeoutMs);
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
    return { ack, request, close: () => socket.destroy() };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
