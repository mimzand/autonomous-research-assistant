import { IpcEvents, type AppInfo } from '@rka/shared';
import { connectServiceAgent } from './agent-transport.js';
import { type IpcMainLike } from './ipc.js';
import { registerServiceIpcHandlers } from './service-ipc.js';

export interface ServiceShellDeps {
  readonly ipc: IpcMainLike;
  readonly stateFile: string;
  readonly appVersion: string;
  readonly getAppInfo: () => AppInfo;
  readonly isTrustedSender: (url: string) => boolean;
  /** Sends to every open window (Electron: the same BrowserWindow loop as in-process). */
  readonly broadcast: (channel: string, payload: unknown) => void;
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
        `Agent service disconnected: ${error.message} Dashboard, Chat and research requests fail until the app restarts.`,
      );
    }
  });
  deps.onQuit(() => {
    quitting = true;
    client.close();
  });
  // Research progress goes to every window, as in-process (already validated by parseEvent).
  client.onEvent((event) => {
    if (event.method === 'ui.researchProgress') {
      deps.broadcast(IpcEvents.researchProgress, event.payload);
    }
  });
  registerServiceIpcHandlers(deps.ipc, {
    client,
    getAppInfo: deps.getAppInfo,
    isTrustedSender: deps.isTrustedSender,
    log,
  });
  log.info(
    'Agent service: the agent owns the database and serves the Dashboard, Chat and research ' +
      'tasks. Settings, Research Tools and backup are not available in this mode yet.',
  );
}
