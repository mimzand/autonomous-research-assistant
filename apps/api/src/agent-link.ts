import {
  AgentClientError,
  connectFromStateFile,
  type AgentClient,
  type ConnectFromStateFileOptions,
  type StateFileConnection,
} from '@rka/agent-client';
import {
  type ParsedEvent,
  type RequestMethodName,
  type RequestParamsInput,
  type RequestResult,
} from '@rka/agent-protocol';

/*
 * The API's one connection to the agent service. Connects lazily through the state
 * file (so `pnpm api:up` may start the API before the agent is listening) and again
 * after the connection is lost (the agent was restarted). It connects as a `cli`
 * client: the agent never asks it for dialogs or secrets (those are reverse calls to
 * a `shell`, i.e. the desktop app), and a `cli` client cannot stop the agent.
 */

export const AGENT_CONNECT_TIMEOUT_MS = 5_000;
export const AGENT_REQUEST_TIMEOUT_MS = 60_000;

export interface AgentInfo {
  readonly pid: number;
  readonly version: string;
  readonly protocol: number;
}

export interface AgentLink {
  request<M extends RequestMethodName>(
    method: M,
    params: RequestParamsInput<M>,
    options?: { readonly timeoutMs?: number },
  ): Promise<RequestResult<M>>;
  /** Connects now if needed. Rejects with an `AgentClientError` when the agent is not reachable. */
  ensure(): Promise<AgentInfo>;
  /** Agent events (chat replies, research progress) from the current and later connections. */
  onEvent(listener: (event: ParsedEvent) => void): () => void;
  /** Called when the current connection ends (streams tied to it should end). */
  onDisconnect(listener: () => void): () => void;
  /** The connected agent, or null. */
  info(): AgentInfo | null;
  close(): void;
}

export function createAgentLink(options: {
  readonly stateFile: string;
  readonly version: string;
  readonly connect?: (
    path: string,
    options: ConnectFromStateFileOptions,
  ) => Promise<StateFileConnection>;
  readonly log?: (message: string) => void;
}): AgentLink {
  const connect = options.connect ?? connectFromStateFile;
  const log = options.log ?? (() => undefined);
  const eventListeners = new Set<(event: ParsedEvent) => void>();
  const disconnectListeners = new Set<() => void>();
  let client: AgentClient | undefined;
  let connecting: Promise<AgentClient> | undefined;
  let closed = false;

  const infoOf = (c: AgentClient): AgentInfo => ({
    pid: c.ack.agent.pid,
    version: c.ack.agent.version,
    protocol: c.ack.version,
  });

  async function open(): Promise<AgentClient> {
    if (closed) throw new AgentClientError('connection_closed', 'The API is shutting down.');
    const connection = await connect(options.stateFile, {
      client: { kind: 'cli', version: options.version },
      timeoutMs: AGENT_CONNECT_TIMEOUT_MS,
    });
    const next = connection.client;
    next.onEvent((event) => {
      for (const listener of eventListeners) listener(event);
    });
    next.onClose((error) => {
      if (client === next) client = undefined;
      if (!closed) log(`Agent connection closed: ${error.message}`);
      for (const listener of disconnectListeners) listener();
    });
    client = next;
    const info = infoOf(next);
    log(
      `Connected to the agent on ${connection.state.host}:${connection.state.port} (pid ${info.pid}, v${info.version}, protocol ${info.protocol}).`,
    );
    return next;
  }

  async function current(): Promise<AgentClient> {
    if (client) return client;
    connecting ??= open().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }

  return {
    async request(method, params, requestOptions) {
      const c = await current();
      return c.request(method, params, {
        timeoutMs: requestOptions?.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS,
      });
    },
    ensure: async () => infoOf(await current()),
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    info: () => (client ? infoOf(client) : null),
    close() {
      closed = true;
      client?.close();
      client = undefined;
    },
  };
}
