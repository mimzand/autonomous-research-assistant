import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createAgentRuntime, createSourceStore } from '@rka/agent-runtime';
import { createOllamaProvider } from '@rka/model-provider';
import { IpcEvents, ResearchProgressEventSchema, SettingsChangedEventSchema } from '@rka/shared';
import { createReconfigurableWebServices, createToolRegistry, createWebTools } from '@rka/tools';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron';
import { chatUsageRecorder, openAppStorage } from './app-storage.js';
import { ChatController } from './chat.js';
import { createRuntimeConfig } from './config/runtime-config.js';
import {
  createOllamaSettingsService,
  ollamaApplier,
  taskModelsFor,
  toOllamaConfig,
  toResearchDefaults,
  toWebConfig,
  webApplier,
} from './config/services.js';
import { createSettingsService } from './config/settings-service.js';
import { createDashboardService } from './dashboard.js';
import { backupDialogOptions } from './backup-dialog.js';
import { loadDevEnvFile, loadSettingsFile } from './env.js';
import { registerIpcHandlers } from './ipc.js';
import { createResearchToolsService } from './research-tools.js';
import { installConsoleRedaction } from './log.js';
import { isAllowedSetting, isAppUrl, isSafeExternalUrl, type AppUrlOptions } from './security.js';
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

/** The saved backup folder when it still exists, otherwise Documents. */
function backupDirectory(saved: string | null, documents: string): string {
  try {
    return saved && existsSync(saved) && statSync(saved).isDirectory() ? saved : documents;
  } catch {
    return documents;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function bootstrap(): void {
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
  const modelProvider = createOllamaProvider(toOllamaConfig(config.getSettings()), {
    getAuthToken: () => config.getSecret('ollama.authToken'),
    isConnected: () => ollamaConnected,
  });
  config.register(ollamaApplier(modelProvider));

  // Web research tools. fetch_source can only reach public addresses; web_search
  // needs a SearXNG URL (Settings → Research & Web Search).
  const webServices = createReconfigurableWebServices(toWebConfig(config.getSettings()));
  config.register(webApplier(webServices));
  const sourceStore = createSourceStore(storage);
  const tools = createToolRegistry(createWebTools({ ...webServices, store: sourceStore }));
  if (!webServices.isSearchConfigured()) {
    console.info('Web search is off: set the SearXNG URL in Settings to enable it.');
  }

  const runtime = createAgentRuntime({
    modelProvider,
    tools,
    storage,
    // Read when each task starts, so Settings changes apply to new tasks.
    researchDefaults: () => toResearchDefaults(config.getSettings()),
    // A running task keeps the model configuration it started with.
    taskModels: taskModelsFor(modelProvider),
    searchConfigured: () => webServices.isSearchConfigured(),
    // Research progress is pushed to every window (validated against the shared contract).
    onResearchEvent: (event) => {
      const parsed = ResearchProgressEventSchema.safeParse(event);
      if (!parsed.success) return;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcEvents.researchProgress, parsed.data);
      }
    },
  });

  const dashboard = createDashboardService({
    storage,
    runtime,
    chooseBackupPath: async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = backupDialogOptions(
        backupDirectory(config.getSetting('backup.defaultDirectory'), app.getPath('documents')),
        new Date(),
      );
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  });

  const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const researchTools = createResearchToolsService({
    config: () => webServices.config(),
    services: webServices,
    tools,
    storage,
    sourceStore,
    chooseFile: async () => {
      // The only way a local file reaches the tools: the user picks it here.
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a PDF or Word document',
        properties: ['openFile'],
        filters: [{ name: 'PDF or Word documents', extensions: ['pdf', 'docx'] }],
      };
      const parent = focusedWindow();
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    // Defence in depth: the service already allows only public http(s) URLs it has seen.
    openExternal: async (url) => {
      if (!isSafeExternalUrl(url)) throw new Error('Refused to open a non-http(s) link.');
      await shell.openExternal(url);
    },
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
    chooseFolder: async (current) => {
      const options: Electron.OpenDialogOptions = {
        title: 'Choose the default backup folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: backupDirectory(current, app.getPath('documents')),
      };
      const parent = focusedWindow();
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  // Typed change events: every window gets the new state (validated against the contract).
  config.onChange(({ changed }) => {
    const event = SettingsChangedEventSchema.parse({ changed, view: config.view() });
    console.info(`Settings changed: ${changed.join(', ')}`);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IpcEvents.settingsChanged, event);
    }
  });

  registerIpcHandlers(ipcMain, {
    runtime,
    chat: new ChatController({ runtime, onUsage: chatUsageRecorder(storage) }),
    dashboard,
    researchTools,
    settings: settingsService,
    isTrustedSender: (url) => isAppUrl(url, urlPolicy),
    getAppInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }),
  });

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

  // Packaged builds have no menu: no reload, no DevTools shortcuts.
  if (app.isPackaged) Menu.setApplicationMenu(null);

  createMainWindow(windowOptions);

  // Startup check: Ollama reachable and the model installed. Never downloads a model;
  // the window shows the exact command to run when something is missing.
  void checkStartup(() => runtime.getModelHealth(), webServices.isSearchConfigured()).then(
    (result) => console.info(`Startup check: ${result.summary}`),
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
