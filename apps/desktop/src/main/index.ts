import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  utilityProcess,
} from 'electron';
import { createAgentSupervisor } from './agent-supervisor.js';
import {
  agentStateFilePath,
  connectServiceAgent,
  resolveAgentTransport,
  type AgentTransport,
  type ServiceAgentConnection,
} from './agent-transport.js';
import { loadDevEnvFile, loadSettingsFile } from './env.js';
import { broadcast, createElectronHostPorts } from './host-ports.js';
import { installConsoleRedaction } from './log.js';
import { isAllowedSetting, isAppUrl, type AppUrlOptions } from './security.js';
import { type ServiceSettings } from './service-settings.js';
import { startServiceShell } from './service-shell.js';
import { checkStartup } from './startup.js';
import { createMainWindow, rendererIndexPath } from './window.js';

// Everything the main process prints is redacted (secrets, e-mail addresses, user names in paths).
installConsoleRedaction();

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const urlPolicy: AppUrlOptions = { devServerUrl, rendererIndexPath: rendererIndexPath() };
const windowOptions = { ...urlPolicy, allowDevTools: !app.isPackaged };

if (!app.isPackaged) {
  // apps/desktop/.env first, then the repository root .env.
  const appPath = app.getAppPath();
  loadDevEnvFile([join(appPath, '.env'), join(appPath, '..', '..', '.env')], process.env);
}
// Installed app: settings live next to the database, in %APPDATA%\<app>\settings.env.
// Real environment variables (and a development .env) take precedence.
const settingsPath = join(app.getPath('userData'), 'settings.env');
const settings = loadSettingsFile(settingsPath, process.env, isAllowedSetting);
if (settings?.ignored.length) {
  console.warn(`Ignored unsupported keys in ${settingsPath}: ${settings.ignored.join(', ')}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const isTrustedSender = (url: string) => isAppUrl(url, urlPolicy);
const getAppInfo = () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

/**
 * Production path (Phase 8): the agent service owns SQLite and Settings and serves
 * the Dashboard, Chat, research tasks, Research Tools, backup and Settings. This
 * process opens no database; it starts and supervises the agent (`service`, the
 * default and the only mode of a packaged app) or, in development, connects to an
 * agent that is already running (`external`, e.g. `pnpm agent:dev`). It answers the
 * agent's dialog and link requests and encrypts/decrypts secrets with safeStorage.
 * Startup stops if the agent cannot be started or reached.
 */
async function startAgentService(transport: Exclude<AgentTransport, 'inprocess'>): Promise<void> {
  // The backup dialog opens in the saved folder as last reported by the agent.
  const service: { settings?: ServiceSettings } = {};
  const ports = createElectronHostPorts({
    backupDirectory: () => service.settings?.backupDirectory() ?? null,
    getSecret: () => undefined,
  });
  // Quit order: close the shell's connection, then stop the agent (system.shutdown on
  // its own control connection; killed if it does not exit), then let the app quit.
  const quitListeners: (() => void)[] = [];
  let agent: ServiceAgentConnection;
  if (transport === 'service') {
    const supervisor = createAgentSupervisor({
      fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      appPath: app.getAppPath(),
      dataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
      env: process.env,
    });
    let agentStopped = false;
    // Registered before the start, so a failed start (error dialog, quit) still stops it.
    app.on('will-quit', (event) => {
      if (agentStopped) return;
      event.preventDefault();
      for (const listener of quitListeners.splice(0)) listener();
      void supervisor.stop().finally(() => {
        agentStopped = true;
        app.quit();
      });
    });
    agent = await supervisor.start();
  } else {
    app.on('will-quit', () => {
      for (const listener of quitListeners.splice(0)) listener();
    });
    agent = await connectServiceAgent({
      stateFile: agentStateFilePath({
        env: process.env,
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        userDataDir: app.getPath('userData'),
      }),
      appVersion: app.getVersion(),
    });
  }
  const started = await startServiceShell({
    agent,
    ports,
    cipher: safeStorage,
    ipc: ipcMain,
    getAppInfo,
    isTrustedSender,
    broadcast,
    onQuit: (listener) => quitListeners.push(listener),
  });
  service.settings = started.settings;

  // Startup check, as in-process: Ollama reachable and the model installed (asked of the agent).
  void Promise.all([
    agent.client.request('researchTools.status', {}).then((status) => status.search.configured),
  ])
    .then(([searchConfigured]) =>
      checkStartup(() => agent.client.request('model.health', {}), searchConfigured),
    )
    .then(
      (result) => console.info(`Startup check: ${result.summary}`),
      (error: unknown) =>
        console.warn(
          `Startup check failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
}

/** AGENT_TRANSPORT=inprocess, development only: compiled out of production builds. */
async function startInProcessForDevelopment(): Promise<void> {
  if (!import.meta.env.DEV) {
    throw new Error('AGENT_TRANSPORT=inprocess is only available in development.');
  }
  const dev = await import('./dev-inprocess.js');
  const startupCheck = dev.startInProcessAgent({ isTrustedSender, getAppInfo });
  // After the window is up (bootstrap continues synchronously after this resolves).
  setImmediate(() => {
    startupCheck();
    dev.probeAdkInProcess();
  });
}

async function bootstrap(): Promise<void> {
  const { transport, warning } = resolveAgentTransport(process.env, { isPackaged: app.isPackaged });
  if (warning) console.warn(warning);
  console.info(`Agent transport: ${transport}.`);
  if (transport === 'inprocess') await startInProcessForDevelopment();
  else await startAgentService(transport);

  // The renderer needs no browser permissions (camera, notifications, geolocation, ...).
  // Only writing to the clipboard ("Copy" buttons) is allowed; reading it is not.
  const allowed = (permission: string) => permission === 'clipboard-sanitized-write';
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(allowed(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    allowed(permission),
  );
  // No device access either (USB, HID, serial, Bluetooth).
  session.defaultSession.setDevicePermissionHandler(() => false);
  // No network access by Chromium itself: the session spellchecker would otherwise
  // download Hunspell dictionaries from Google's CDN at startup (redirector.gvt1.com),
  // even though the windows set spellcheck: false. Disabling it is not enough; with no
  // languages nothing is downloaded (checked with --log-net-log in smoke:packaged).
  session.defaultSession.setSpellCheckerEnabled(false);
  session.defaultSession.setSpellCheckerLanguages([]);

  // Packaged builds have no menu: no reload, no DevTools shortcuts.
  if (app.isPackaged) Menu.setApplicationMenu(null);

  createMainWindow(windowOptions);
}

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on('web-contents-created', (_event, contents) => {
  // Defence in depth: never allow <webview> attachment.
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // Any web contents (not only the main window) may never open windows or navigate away.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, urlPolicy)) event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow(windowOptions);
});

app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    console.error('Failed to start application:', error);
    dialog.showErrorBox(
      'Autonomous Research Assistant could not start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });
