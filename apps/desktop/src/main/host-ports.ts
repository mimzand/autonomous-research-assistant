import { existsSync, statSync } from 'node:fs';
import { type HostPorts } from '@rka/agent-host';
import { IpcEvents } from '@rka/shared';
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { backupDialogOptions } from './backup-dialog.js';
import { type RuntimeConfig } from './config/runtime-config.js';
import { isSafeExternalUrl } from './security.js';

/** The saved backup folder when it still exists, otherwise Documents. */
function backupDirectory(saved: string | null, documents: string): string {
  try {
    return saved && existsSync(saved) && statSync(saved).isDirectory() ? saved : documents;
  } catch {
    return documents;
  }
}

const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

/** Pushes an event to every open window. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function openDialog(options: Electron.OpenDialogOptions): Promise<string | null> {
  const parent = focusedWindow();
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** The Electron implementation of every capability the agent host and settings use. */
export function createElectronHostPorts(
  config: Pick<RuntimeConfig, 'getSetting' | 'getSecret'>,
): HostPorts {
  return {
    emitResearchProgress: (event) => broadcast(IpcEvents.researchProgress, event),
    emitSettingsChanged: (event) => broadcast(IpcEvents.settingsChanged, event),

    chooseBackupPath: async () => {
      const parent = focusedWindow();
      const options = backupDialogOptions(
        backupDirectory(config.getSetting('backup.defaultDirectory'), app.getPath('documents')),
        new Date(),
      );
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    // The only way a local file reaches the tools: the user picks it here.
    chooseFile: () =>
      openDialog({
        title: 'Choose a PDF or Word document',
        properties: ['openFile'],
        filters: [{ name: 'PDF or Word documents', extensions: ['pdf', 'docx'] }],
      }),
    chooseFolder: (current) =>
      openDialog({
        title: 'Choose the default backup folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: backupDirectory(current, app.getPath('documents')),
      }),

    // Defence in depth: the Research Tools service already allows only public http(s) URLs it has seen.
    openExternal: async (url) => {
      if (!isSafeExternalUrl(url)) throw new Error('Refused to open a non-http(s) link.');
      await shell.openExternal(url);
    },

    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    getSecret: (key) => config.getSecret(key),
  };
}
