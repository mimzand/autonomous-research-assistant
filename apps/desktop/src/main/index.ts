import { join } from 'node:path';
import { createAgentRuntime, createSourceStore, loadResearchConfig } from '@rka/agent-runtime';
import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { IpcEvents, ResearchProgressEventSchema } from '@rka/shared';
import {
  createToolRegistry,
  createWebServices,
  createWebToolsFromConfig,
  loadWebConfig,
} from '@rka/tools';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { chatUsageRecorder, openAppStorage } from './app-storage.js';
import { ChatController } from './chat.js';
import { createDashboardService } from './dashboard.js';
import { backupDialogOptions } from './backup-dialog.js';
import { loadDevEnvFile } from './env.js';
import { registerIpcHandlers } from './ipc.js';
import { createResearchToolsService } from './research-tools.js';
import { isAppUrl } from './security.js';
import { createMainWindow } from './window.js';

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];

if (!app.isPackaged) {
  // apps/desktop/.env first, then the repository root .env.
  const appPath = app.getAppPath();
  loadDevEnvFile([join(appPath, '.env'), join(appPath, '..', '..', '.env')], process.env);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function bootstrap(): void {
  const ollamaConfig = loadOllamaConfig(process.env);
  const webConfig = loadWebConfig(process.env);
  // RESEARCH_* retry limits and timeouts; an invalid value stops startup with a clear error.
  const researchDefaults = loadResearchConfig(process.env);

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

  // Web research tools. fetch_source can only reach public addresses; web_search
  // is offered only when SEARXNG_URL points at a SearXNG instance.
  const webServices = createWebServices(webConfig);
  const sourceStore = createSourceStore(storage);
  const tools = createToolRegistry(createWebToolsFromConfig(webConfig, sourceStore, webServices));
  if (!webConfig.searxngUrl) {
    console.info('Web search is off: set SEARXNG_URL to a SearXNG instance to enable it.');
  }

  const runtime = createAgentRuntime({
    modelProvider: createOllamaProvider(ollamaConfig),
    tools,
    storage,
    researchDefaults,
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
      const options = backupDialogOptions(app.getPath('documents'), new Date());
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  });

  const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const researchTools = createResearchToolsService({
    config: webConfig,
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
    openExternal: (url) => shell.openExternal(url),
  });

  registerIpcHandlers(ipcMain, {
    runtime,
    chat: new ChatController({ runtime, onUsage: chatUsageRecorder(storage) }),
    dashboard,
    researchTools,
    isTrustedSender: (url) => isAppUrl(url, devServerUrl),
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

  // The renderer needs no browser permissions (camera, notifications, ...).
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  createMainWindow({ devServerUrl });
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow({ devServerUrl });
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
