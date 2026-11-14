import { type AppInfo } from '@rka/shared';
import { connectServiceAgent } from './agent-transport.js';
import { type IpcMainLike } from './ipc.js';
import { registerServiceIpcHandlers } from './service-ipc.js';

export interface ServiceShellDeps {
  readonly ipc: IpcMainLike;
  readonly stateFile: string;
  readonly appVersion: string;
  readonly getAppInfo: () => AppInfo;
  readonly isTrustedSender: (url: string) => boolean;
  /** Electron: `app.on('will-quit', …)`. */
  readonly onQuit: (listener: () => void) => void;
  readonly connect?: Parameters<typeof connectServiceAgent>[0]['connect'];
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * AGENT_TRANSPORT=service: connects to the agent service (which owns SQLite) and
 * serves the renderer through it. Opens no database and builds no local agent host.
 * One long-lived connection, closed on quit; a lost connection is logged and is not
 * re-established (restart the app).
 */
export async function startServiceShell(deps: ServiceShellDeps): Promise<void> {
  const log = deps.log ?? console;
  const { client, summary } = await connectServiceAgent({
    stateFile: deps.stateFile,
    appVersion: deps.appVersion,
    ...(deps.connect && { connect: deps.connect }),
  });
  log.info(`Agent service: ${summary}`);
  let quitting = false;
  client.onClose((error) => {
    if (!quitting) {
      log.warn(
        `Agent service disconnected: ${error.message} Dashboard requests fail until the app restarts.`,
      );
    }
  });
  deps.onQuit(() => {
    quitting = true;
    client.close();
  });
  registerServiceIpcHandlers(deps.ipc, {
    client,
    getAppInfo: deps.getAppInfo,
    isTrustedSender: deps.isTrustedSender,
  });
  log.info(
    'Agent service: the agent owns the database and serves the Dashboard. Chat, Settings, ' +
      'Research Tools, research actions and backup are not available in this mode yet.',
  );
}
