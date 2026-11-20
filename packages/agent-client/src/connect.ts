import { type AgentStateFile } from '@rka/agent-protocol';
import {
  AgentClientError,
  connectAgent,
  type AgentClient,
  type AgentClientOptions,
} from './client.js';
import { isProcessAlive, readStateFile } from './state-file.js';

export interface ConnectFromStateFileOptions extends Pick<
  AgentClientOptions,
  'client' | 'timeoutMs'
> {
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface StateFileConnection {
  readonly client: AgentClient;
  readonly state: Omit<AgentStateFile, 'token'>;
}

/**
 * Locates the agent through its state file and connects. Fails with a clear
 * `AgentClientError` when the file is missing, invalid (including a non-loopback
 * host), stale (its pid is not running), or the agent does not answer. Error
 * messages never include the token.
 */
export async function connectFromStateFile(
  path: string,
  options: ConnectFromStateFileOptions = {},
): Promise<StateFileConnection> {
  const read = readStateFile(path);
  if (read.status === 'missing') {
    throw new AgentClientError('not_running', `No agent state file at ${path}.`);
  }
  if (read.status === 'invalid') {
    throw new AgentClientError(
      'state_file_invalid',
      `${path} is not a valid agent state file (it must name 127.0.0.1, a port and a token).`,
    );
  }
  const { token, ...state } = read.state;
  const alive = options.isProcessAlive ?? isProcessAlive;
  if (!alive(state.pid)) {
    throw new AgentClientError(
      'not_running',
      `The agent state file ${path} is stale: process ${state.pid} is not running.`,
    );
  }
  const client = await connectAgent({
    port: state.port,
    token,
    client: options.client,
    timeoutMs: options.timeoutMs,
  });
  return { client, state };
}
