import { IpcEvents, type AppInfo } from '@rka/shared';
import { connectServiceAgent } from './agent-transport.js';
import { type IpcMainLike } from './ipc.js';
import { registerServiceIpcHandlers, SERVICE_REQUEST_TIMEOUT_MS } from './service-ipc.js';
import {
  createServiceSettings,
  type ServiceSettings,
  type ShellSecretCipher,
} from './service-settings.js';
import { shellRequestHandlers, type ShellPortsSource } from './service-shell-ports.js';

export interface ServiceShellDeps {
  readonly ipc: IpcMainLike;
  readonly stateFile: string;
  readonly appVersion: string;
  readonly getAppInfo: () => AppInfo;
  readonly isTrustedSender: (url: string) => boolean;
  /** Sends to every open window (Electron: the same BrowserWindow loop as in-process). */
  readonly broadcast: (channel: string, payload: unknown) => void;
  /** Dialogs and links the agent asks for (Electron: `createElectronHostPorts`). */
  readonly ports: ShellPortsSource;
  /** The OS key store (Electron: safeStorage): encrypts new secrets, decrypts stored ones. */
  readonly cipher: ShellSecretCipher;
  /** Electron: `app.on('will-quit', …)`. */
  readonly onQuit: (listener: () => void) => void;
  readonly connect?: Parameters<typeof connectServiceAgent>[0]['connect'];
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * AGENT_TRANSPORT=service: connects to the agent service (which owns SQLite) and
 * serves the renderer through it. Opens no database and builds no local agent host.
 * One long-lived connection, closed on quit; a lost connection is logged and is not
 * re-established (restart the app). Returns the Settings client state (the saved
 * backup folder for the backup dialog).
 */
export async function startServiceShell(
  deps: ServiceShellDeps,
): Promise<{ readonly settings: ServiceSettings }> {
  const log = deps.log ?? console;
  const { client, summary } = await connectServiceAgent({
    stateFile: deps.stateFile,
    appVersion: deps.appVersion,
    ...(deps.connect && { connect: deps.connect }),
  });
  log.info(`Agent service: ${summary}`);
  const settings = createServiceSettings({
    client,
    cipher: deps.cipher,
    timeoutMs: SERVICE_REQUEST_TIMEOUT_MS,
  });
  client.serve(
    shellRequestHandlers(deps.ports, { cipher: deps.cipher, decrypt: settings.decrypt }),
  );
  let quitting = false;
  client.onClose((error) => {
    if (!quitting) {
      log.warn(
        `Agent service disconnected: ${error.message} Requests to the agent fail until the app restarts.`,
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
    } else if (event.method === 'ui.settingsChanged') {
      // Settings changed in the agent (from any window): every window gets the new state.
      deps.broadcast(IpcEvents.settingsChanged, settings.changedEvent(event.payload));
    }
  });
  registerServiceIpcHandlers(deps.ipc, {
    client,
    getAppInfo: deps.getAppInfo,
    isTrustedSender: deps.isTrustedSender,
    settings,
    log,
  });
  // The saved backup folder lives in the agent: learn it now, and from every view after.
  // This is also the shell's first request, so the agent decrypts the stored token now.
  await client
    .request('settings.get', {}, { timeoutMs: SERVICE_REQUEST_TIMEOUT_MS })
    .then((view) => settings.patchResult('settings.get', view))
    .catch((error: unknown) =>
      log.warn(
        `Agent service: could not read Settings: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  log.info(
    'Agent service: the agent owns the database and Settings and serves the Dashboard, ' +
      'Chat, research tasks, Research Tools, backup and Settings. Secrets are encrypted here.',
  );
  return { settings };
}
