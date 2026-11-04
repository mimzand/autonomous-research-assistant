import { join } from 'node:path';
import { createAgentRuntime } from '@rka/agent-runtime';
import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { createInMemoryTaskRepository } from '@rka/storage';
import { createToolRegistry } from '@rka/tools';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { ChatController } from './chat.js';
import { loadDevEnvFile } from './env.js';
import { registerIpcHandlers } from './ipc.js';
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

  const runtime = createAgentRuntime({
    modelProvider: createOllamaProvider(ollamaConfig),
    tools: createToolRegistry([]),
    // Replaced by the SQLite/Drizzle repository in a later step.
    tasks: createInMemoryTaskRepository(),
  });

  registerIpcHandlers(ipcMain, {
    runtime,
    chat: new ChatController({ runtime }),
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
    app.quit();
  });
