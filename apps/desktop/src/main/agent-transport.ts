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
 * How Electron main reaches the agent (Phase 8 defaults):
 *
 * - `service` (default, and the only mode of a packaged app): Electron starts and
 *   supervises the agent service (`agent-supervisor.ts`) on this app's data folder.
 * - `external` (development only): connect to an agent that is already running,
 *   e.g. `pnpm agent:dev`, through its state file; fail startup if unreachable.
 * - `inprocess` (development and tests only): the pre-Phase 8 path, createAgentHost
 *   in the Electron main process (`dev-inprocess.ts`, not part of a production build).
 */
export const AGENT_TRANSPORTS = ['service', 'external', 'inprocess'] as const;
export type AgentTransport = (typeof AGENT_TRANSPORTS)[number];
const AgentTransportSchema = z.enum(AGENT_TRANSPORTS);

export const AGENT_STATE_FILE_NAME = 'agent-state.json';
/** Upper bound for connect + handshake + ping, so startup never hangs. */
export const SERVICE_CONNECT_TIMEOUT_MS = 5_000;

/** `AGENT_TRANSPORT`, case-insensitive. Unset or empty: `service`. Anything else stops startup. */
export function agentTransportFromEnv(env: NodeJS.ProcessEnv): AgentTransport {
  const raw = env['AGENT_TRANSPORT']?.trim().toLowerCase();
  if (!raw) return 'service';
  const parsed = AgentTransportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `AGENT_TRANSPORT must be "service", "external" or "inprocess" (got "${env['AGENT_TRANSPORT'] ?? ''}").`,
    );
  }
  return parsed.data;
}

/**
 * The transport this run uses. A packaged app always supervises its own agent:
 * `external` and `inprocess` are development modes and are ignored there (with a
 * warning to log), so a leftover variable can neither stop the installed app nor
 * point it at another agent.
 */
export function resolveAgentTransport(
  env: NodeJS.ProcessEnv,
  options: { readonly isPackaged: boolean },
): { readonly transport: AgentTransport; readonly warning?: string } {
  const requested = agentTransportFromEnv(env);
  if (!options.isPackaged || requested === 'service') return { transport: requested };
  return {
    transport: 'service',
    warning: `Ignored AGENT_TRANSPORT=${requested}: the installed app always runs its own agent service.`,
  };
}

/**
 * State file of an `external` agent: `AGENT_STATE_FILE` if set; otherwise in
 * development the file `pnpm agent:dev` writes (apps/agent/.agent-data), and in a
 * packaged app `<userData>/agent-state.json` (the supervised agent's file).
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

const EXTERNAL_AGENT_HINT =
  'AGENT_TRANSPORT=external: start it with "pnpm agent:dev", or unset AGENT_TRANSPORT to let the app start its own agent.';

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
  /** What to do when it fails (default: start `pnpm agent:dev`, for `external`). */
  readonly hint?: string;
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
      `The agent service is not reachable. ${reason} ${options.hint ?? EXTERNAL_AGENT_HINT}`,
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
