import { PROTOCOL_NAME, PROTOCOL_VERSION } from '@rka/agent-protocol';
import { startAgentServer, type AgentServer } from './server.js';
import { isProcessAlive, readStateFile } from '@rka/agent-client';
import { removeStateFile, writeStateFile } from './state-file.js';
import { generateToken } from './token.js';

export interface RunAgentOptions {
  readonly port: number;
  readonly stateFile: string;
  readonly agentVersion: string;
  readonly log?: (message: string) => void;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface RunningAgent {
  readonly server: AgentServer;
  readonly stateFile: string;
  /** Closes the server and removes the state file if it is still ours. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Starts the agent: refuses if the state file belongs to a live process, generates a
 * fresh token, listens on 127.0.0.1 and writes the state file.
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

  const token = generateToken();
  const server = await startAgentServer({
    token,
    port: options.port,
    agentVersion: options.agentVersion,
    log: options.log,
  });
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
    throw error;
  }

  let stopped: Promise<void> | null = null;
  return {
    server,
    stateFile: options.stateFile,
    stop: () =>
      (stopped ??= server.close().then(() => {
        removeStateFile(options.stateFile, token);
      })),
  };
}
