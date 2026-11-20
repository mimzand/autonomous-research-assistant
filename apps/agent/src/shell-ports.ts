import { type HostPorts } from '@rka/agent-host';
import { SHELL_DIALOG_TIMEOUT_MS, type RequestParamsInput } from '@rka/agent-protocol';
import { requestingConnection, ShellCallError } from './connection-context.js';
import { type AgentConnection } from './handlers.js';

/** Non-interactive reverse calls (open a link, read a secret). */
export const SHELL_CALL_TIMEOUT_MS = 30_000;

export type SecretKey = RequestParamsInput<'shell.getSecret'>['key'];

/**
 * The shell's OS key store (safeStorage). The agent keeps secrets as ciphertext
 * and asks the shell to decrypt them (Phase 7). Async because it crosses the
 * process boundary; values are never logged.
 */
export interface ShellSecrets {
  getSecret(key: SecretKey, ciphertext: string): Promise<string | null>;
  encryptionAvailable(): Promise<boolean>;
}

export type ShellDialogPorts = Pick<
  HostPorts,
  'chooseBackupPath' | 'chooseFile' | 'chooseFolder' | 'openExternal'
>;

export interface ShellPortsOptions {
  /** Open authenticated connections, oldest first (the server's `connections`). */
  readonly connections: () => readonly AgentConnection[];
  readonly dialogTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

/**
 * HostPorts served by the desktop shell over reverse RPC.
 *
 * Routing: a dialog or `openExternal` goes to the connection whose request is
 * being served (so it appears for the user who clicked), never to another client;
 * outside a request, or once that client is gone, it fails with `shell_unavailable`.
 * A secret goes to the requesting connection if it is a shell, otherwise to the
 * most recently connected shell.
 */
export function createShellPorts(options: ShellPortsOptions): {
  readonly ports: ShellDialogPorts;
  readonly secrets: ShellSecrets;
} {
  const dialogTimeoutMs = options.dialogTimeoutMs ?? SHELL_DIALOG_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? SHELL_CALL_TIMEOUT_MS;

  const requester = (): AgentConnection => {
    const connection = requestingConnection();
    if (!connection || connection.closed) {
      throw new ShellCallError('shell_unavailable', 'This needs the desktop shell that asked.');
    }
    return connection;
  };
  const secretShell = (): AgentConnection => {
    const current = requestingConnection();
    if (current && !current.closed && current.kind === 'shell') return current;
    const shell = options.connections().findLast((c) => c.kind === 'shell' && !c.closed);
    if (!shell) throw new ShellCallError('shell_unavailable', 'No desktop shell is connected.');
    return shell;
  };
  const dialog = { timeoutMs: dialogTimeoutMs };
  const call = { timeoutMs: callTimeoutMs };

  return {
    ports: {
      chooseBackupPath: async () =>
        (await requester().call('shell.chooseBackupPath', {}, dialog)).path,
      chooseFile: async () => (await requester().call('shell.chooseFile', {}, dialog)).path,
      chooseFolder: async (defaultPath) =>
        (await requester().call('shell.chooseFolder', { defaultPath }, dialog)).path,
      openExternal: async (url) => {
        await requester().call('shell.openExternal', { url }, call);
      },
    },
    secrets: {
      getSecret: async (key, ciphertext) =>
        (await secretShell().call('shell.getSecret', { key, ciphertext }, call)).value,
      encryptionAvailable: async () =>
        (await secretShell().call('shell.encryptionAvailable', {}, call)).available,
    },
  };
}
