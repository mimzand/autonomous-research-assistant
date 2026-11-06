import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';
import { isAppUrl, isSafeExternalUrl, type AppUrlOptions } from './security.js';

export interface WindowOptions extends AppUrlOptions {
  readonly devServerUrl: string | undefined;
  /** Packaged builds: no DevTools. */
  readonly allowDevTools: boolean;
}

/** Packaged renderer entry. */
export const rendererIndexPath = (): string => join(import.meta.dirname, '../renderer/index.html');

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const { devServerUrl } = options;
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'Autonomous Research & Knowledge Assistant',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      // Renderer isolation: no Node.js, sandboxed, isolated preload world.
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: options.allowDevTools,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Never open new Electron windows. http(s) links open in the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Block navigation (including redirects and sub-frames) away from the app.
  const block = (event: { preventDefault(): void }, url: string) => {
    if (!isAppUrl(url, options)) event.preventDefault();
  };
  window.webContents.on('will-navigate', block);
  window.webContents.on('will-redirect', block);
  window.webContents.on('will-frame-navigate', (event) => block(event, event.url));

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererIndexPath());
  }

  return window;
}
