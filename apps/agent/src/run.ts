import { PROTOCOL_NAME, PROTOCOL_VERSION } from '@rka/agent-protocol';
import { startAgentServer, type AgentServer, type AgentServerLink } from './server.js';
import { isProcessAlive, readStateFile } from '@rka/agent-client';
import { type RequestHandlers } from './handlers.js';
import { removeStateFile, writeStateFile } from './state-file.js';
import { generateToken } from './token.js';

/** What the agent serves (e.g. the database-backed host); closed when the agent stops. */
export interface AgentServiceSet {
  readonly handlers: RequestHandlers;
  /** A client connection closed (e.g. stop the Chat stream it was receiving). */
  onDisconnect?(connectionId: number): void;
  /**
   * Called once the server listens: `broadcast` pushes events to every client
   * (research progress); `connections` lets reverse calls find a shell (secrets).
   */
  attachServer?(server: AgentServerLink): void;
  close(): void;
}

export interface RunAgentOptions {
  readonly port: number;
  readonly stateFile: string;
  readonly agentVersion: string;
  /** Called only once no other live agent owns the state file. */
  readonly openServices?: () => AgentServiceSet;
  readonly log?: (message: string) => void;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface RunningAgent {
  readonly server: AgentServer;
  readonly stateFile: string;
  /** Closes the server and services and removes the state file if it is still ours. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Starts the agent: refuses if the state file belongs to a live process, opens the
 * services, generates a fresh token, listens on 127.0.0.1 and writes the state file.
 */
export async function runAgent(options: RunAgentOptions): Promise<RunningAgent> {
  const existing = readStateFile(options.stateFile);
  const alive = options.isProcessAlive ?? isProcessAlive;
  if (existing.status === 'ok' && alive(existing.state.pid)) {
    throw new Error(
      `Another agent (pid ${existing.state.pid}) is using ${options.stateFile}. ` +
        'Stop it, or pass a different --state-file.',
    );
  }

  const services = options.openServices?.();
  const token = generateToken();
  let server: AgentServer;
  try {
    server = await startAgentServer({
      token,
      port: options.port,
      agentVersion: options.agentVersion,
      ...(services && {
        handlers: services.handlers,
        onDisconnect: (id: number) => services.onDisconnect?.(id),
      }),
      log: options.log,
    });
  } catch (error) {
    services?.close();
    throw error;
  }
  services?.attachServer?.(server);
  try {
    writeStateFile(options.stateFile, {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      host: server.host,
      port: server.port,
      token,
      pid: process.pid,
      startedAt: server.startedAt,
    });
  } catch (error) {
    await server.close();
    services?.close();
    throw error;
  }

  let stopped: Promise<void> | null = null;
  return {
    server,
    stateFile: options.stateFile,
    stop: () =>
      (stopped ??= server.close().then(() => {
        services?.close();
        removeStateFile(options.stateFile, token);
      })),
  };
}
