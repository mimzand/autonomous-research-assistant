import { AsyncLocalStorage } from 'node:async_hooks';
import { type ProtocolErrorCode } from '@rka/agent-protocol';
import { type AgentConnection } from './handlers.js';

/**
 * A reverse call (`shell.*`) that failed: the shell's own error, `timeout`, or
 * `shell_unavailable` when no shell is connected or it went away mid-call.
 */
export class ShellCallError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShellCallError';
  }
}

const current = new AsyncLocalStorage<AgentConnection>();

/**
 * Runs a request handler with `connection` as the requesting client, so a shell
 * port used anywhere in its async work (e.g. a file dialog inside Research Tools)
 * asks the shell that made the request.
 */
export function runWithConnection<T>(connection: AgentConnection, work: () => T): T {
  return current.run(connection, work);
}

/** The client whose request is being served, or undefined outside a request. */
export function requestingConnection(): AgentConnection | undefined {
  return current.getStore();
}
