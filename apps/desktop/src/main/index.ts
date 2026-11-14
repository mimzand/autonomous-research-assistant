import { join } from 'node:path';
import { createAgentHost } from '@rka/agent-host';
import { createOllamaProvider, ollamaTransportOptionsFromEnv } from '@rka/model-provider';
import { SettingsChangedEventSchema } from '@rka/shared';
import { createReconfigurableWebServices } from '@rka/tools';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session } from 'electron';
import { probeAdkRuntime } from './adk-probe.js';
import { agentStateFilePath, agentTransportFromEnv } from './agent-transport.js';
import { chatUsageRecorder, openAppStorage } from './app-storage.js';
import { createRuntimeConfig } from '@rka/agent-host';
import {
  createOllamaSettingsService,
  ollamaApplier,
  toOllamaConfig,
  toResearchDefaults,
  toWebConfig,
  webApplier,
} from '@rka/agent-host';
import { createSettingsService } from '@rka/agent-host';
import { loadDevEnvFile, loadSettingsFile } from './env.js';
import { broadcast, createElectronHostPorts } from './host-ports.js';
import { registerIpcHandlers } from './ipc.js';
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
 * AGENT_TRANSPORT=service (development): the standalone agent (`pnpm agent:dev`)
 * owns SQLite and Settings and serves the Dashboard, Chat, research tasks, Research
 * Tools, backup and Settings; this process opens no database, answers the agent's
 * dialog and link requests, and encrypts/decrypts secrets with safeStorage.
 * Startup stops if the agent is unreachable.
 */
async function startServiceShellMode(): Promise<void> {
  // No database here: Settings live in the agent. The backup dialog opens in the saved
  // folder as last reported by the agent; secrets are decrypted by the agent's request.
  const service: { settings?: ServiceSettings } = {};
  const ports = createElectronHostPorts({
    backupDirectory: () => service.settings?.backupDirectory() ?? null,
    getSecret: () => undefined,
  });
  const started = await startServiceShell({
    ports,
    cipher: safeStorage,
    ipc: ipcMain,
    stateFile: agentStateFilePath({
      env: process.env,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      userDataDir: app.getPath('userData'),
    }),
    appVersion: app.getVersion(),
    getAppInfo,
    isTrustedSender,
    broadcast,
    onQuit: (listener) => app.on('will-quit', listener),
  });
  service.settings = started.settings;
}

/** Default: the agent runs in this process on the local database. Returns the startup check. */
function startInProcessAgent(): () => void {
  // Opens SQLite (runs migrations) and recovers tasks interrupted by the last shutdown.
  // Secrets are encrypted with the OS key store (DPAPI on Windows) via safeStorage.
  const { storage, recovery } = openAppStorage({
    userDataDir: app.getPath('userData'),
    cipher: safeStorage,
  });
  if (recovery.interruptedTaskIds.length) {
    console.info(
      `Marked ${recovery.interruptedTaskIds.length} task(s) as interrupted after an unexpected shutdown.`,
    );
  }
  app.on('will-quit', () => storage.close());

  // Runtime Configuration Manager: built-in defaults < environment (.env,
  // settings.env, process environment; an invalid value stops startup) <
  // values saved in Settings (SQLite). Changes apply without a restart.
  const config = createRuntimeConfig({
    storage,
    env: process.env,
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  });

  // Ollama: one live provider that follows the settings. The access token is
  // read per request in the main process only; Disconnect is session-only.
  let ollamaConnected = true;
  // Trusted ngrok tunnels (OLLAMA_NGROK_BYPASS_HOSTS, main process only): only these
  // hosts, over HTTPS, get ngrok's browser-warning bypass header.
  const transport = ollamaTransportOptionsFromEnv(process.env);
  if (transport.invalid.length > 0) {
    console.warn(
      `Ignored ${String(transport.invalid.length)} invalid OLLAMA_NGROK_BYPASS_HOSTS entr(y/ies): use exact host names, comma-separated.`,
    );
  }
  if (transport.ngrokBypassHosts.length > 0) {
    console.info(
      `ngrok browser-warning bypass enabled for ${String(transport.ngrokBypassHosts.length)} trusted host(s).`,
    );
  }
  const modelProvider = createOllamaProvider(toOllamaConfig(config.getSettings()), {
    getAuthToken: () => config.getSecret('ollama.authToken'),
    isConnected: () => ollamaConnected,
    ngrokBypassHosts: transport.ngrokBypassHosts,
  });
  config.register(ollamaApplier(modelProvider));

  // Web research services. fetch_source can only reach public addresses; web_search
  // needs a SearXNG URL (Settings → Research & Web Search).
  const webServices = createReconfigurableWebServices(toWebConfig(config.getSettings()));
  config.register(webApplier(webServices));
  if (!webServices.isSearchConfigured()) {
    console.info('Web search is off: set the SearXNG URL in Settings to enable it.');
  }

  // OS capabilities (windows, dialogs, browser, key store) for the host and Settings.
  const ports = createElectronHostPorts({
    backupDirectory: () => config.getSetting('backup.defaultDirectory'),
    getSecret: (key) => config.getSecret(key),
  });

  // The agent: tools, runtime, Chat/Research engines, Chat, Dashboard and Research Tools.
  const host = createAgentHost({
    storage,
    modelProvider,
    webServices,
    settings: {
      researchDefaults: () => toResearchDefaults(config.getSettings()),
      chatEngine: () => config.getSettings()['engine.chat'],
      researchEngine: () => config.getSettings()['engine.research'],
      chatWebSearch: () => config.getSettings()['chat.webSearch'],
    },
    ports,
    onChatUsage: chatUsageRecorder(storage),
  });

  const ollamaSettings = createOllamaSettingsService({
    config,
    provider: modelProvider,
    connection: {
      get: () => ollamaConnected,
      set: (connected) => {
        ollamaConnected = connected;
      },
    },
    recordUsage: (usage) =>
      storage.modelUsage.record({ provider: 'ollama', purpose: 'settings:test-model', ...usage }),
  });
  const settingsService = createSettingsService({
    config,
    ollama: ollamaSettings,
    chooseFolder: ports.chooseFolder,
  });
  // Typed change events: every window gets the new state (validated against the contract).
  config.onChange(({ changed }) => {
    const event = SettingsChangedEventSchema.parse({ changed, view: config.view() });
    console.info(`Settings changed: ${changed.join(', ')}`);
    ports.emitSettingsChanged(event);
  });

  registerIpcHandlers(ipcMain, {
    runtime: host.runtime,
    chat: host.chat,
    dashboard: host.dashboard,
    researchTools: host.researchTools,
    settings: settingsService,
    isTrustedSender,
    getAppInfo,
  });

  // Startup check: Ollama reachable and the model installed. Never downloads a model;
  // the window shows the exact command to run when something is missing.
  return () =>
    void checkStartup(() => host.runtime.getModelHealth(), webServices.isSearchConfigured()).then(
      (result) => console.info(`Startup check: ${result.summary}`),
    );
}

async function bootstrap(): Promise<void> {
  let startupCheck: (() => void) | undefined;
  if (agentTransportFromEnv(process.env) === 'service') await startServiceShellMode();
  else startupCheck = startInProcessAgent();

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

  startupCheck?.();

  // ADK migration (phase 1): load ADK after the window is up and run its offline
  // self-check. Chat and Research use it only when their engine is set to Google ADK.
  void probeAdkRuntime().then(({ ok, summary }) =>
    ok ? console.info(`ADK runtime: ${summary}`) : console.warn(`ADK runtime: ${summary}`),
  );
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
