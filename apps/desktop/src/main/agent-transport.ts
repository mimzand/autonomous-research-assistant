import { join, resolve } from 'node:path';
import {
  AgentClientError,
  connectFromStateFile,
  type AgentClient,
  type ConnectFromStateFileOptions,
  type StateFileConnection,
} from '@rka/agent-client';
import { toErrorMessage } from '@rka/shared';
import { z } from 'zod';

/**
 * How Electron main reaches the agent. `inprocess` (default): createAgentHost in
 * this process, as before. `service`: additionally connect to the standalone agent
 * (`pnpm agent:dev`) and fail startup if it is unreachable. Until the storage
 * cutover (Phase 3) the app itself still runs in-process in both modes.
 */
export const AGENT_TRANSPORTS = ['inprocess', 'service'] as const;
export type AgentTransport = (typeof AGENT_TRANSPORTS)[number];
const AgentTransportSchema = z.enum(AGENT_TRANSPORTS);

export const AGENT_STATE_FILE_NAME = 'agent-state.json';
/** Upper bound for connect + handshake + ping, so startup never hangs. */
export const SERVICE_CONNECT_TIMEOUT_MS = 5_000;

/** `AGENT_TRANSPORT`, case-insensitive. Unset or empty: `inprocess`. Anything else stops startup. */
export function agentTransportFromEnv(env: NodeJS.ProcessEnv): AgentTransport {
  const raw = env['AGENT_TRANSPORT']?.trim().toLowerCase();
  if (!raw) return 'inprocess';
  const parsed = AgentTransportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `AGENT_TRANSPORT must be "inprocess" or "service" (got "${env['AGENT_TRANSPORT'] ?? ''}").`,
    );
  }
  return parsed.data;
}

/**
 * `AGENT_STATE_FILE` if set; otherwise in development the file `pnpm agent:dev`
 * writes (apps/agent/.agent-data), and in a packaged app `<userData>/agent-state.json`.
 */
export function agentStateFilePath(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly userDataDir: string;
}): string {
  const override = options.env['AGENT_STATE_FILE']?.trim();
  if (override) return resolve(override);
  return options.isPackaged
    ? join(options.userDataDir, AGENT_STATE_FILE_NAME)
    : join(options.appPath, '..', 'agent', '.agent-data', AGENT_STATE_FILE_NAME);
}

export interface ServiceAgentConnection {
  readonly client: AgentClient;
  /** One line for the log; never contains the token. */
  readonly summary: string;
}

/**
 * Connects to the agent service through its state file, authenticates and sends
 * `system.ping`. Throws an Error whose message says what to do; never hangs longer
 * than `timeoutMs` per step.
 */
export async function connectServiceAgent(options: {
  readonly stateFile: string;
  readonly appVersion: string;
  readonly timeoutMs?: number;
  readonly connect?: (
    path: string,
    options: ConnectFromStateFileOptions,
  ) => Promise<StateFileConnection>;
}): Promise<ServiceAgentConnection> {
  const connect = options.connect ?? connectFromStateFile;
  const started = performance.now();
  let connection: StateFileConnection | undefined;
  try {
    connection = await connect(options.stateFile, {
      client: { kind: 'shell', version: options.appVersion },
      timeoutMs: options.timeoutMs ?? SERVICE_CONNECT_TIMEOUT_MS,
    });
    await connection.client.request('system.ping', {});
  } catch (error) {
    connection?.client.close();
    const reason = error instanceof AgentClientError ? error.message : toErrorMessage(error);
    throw new Error(
      `AGENT_TRANSPORT=service, but the agent service is not reachable. ${reason} ` +
        'Start it with "pnpm agent:dev", or unset AGENT_TRANSPORT to run in-process.',
      { cause: error },
    );
  }
  const { client, state } = connection;
  const ms = Math.round(performance.now() - started);
  return {
    client,
    summary:
      `connected to ${state.host}:${state.port} (agent pid ${client.ack.agent.pid}, ` +
      `v${client.ack.agent.version}, protocol ${client.ack.version}); handshake + ping ${ms} ms.`,
  };
}
