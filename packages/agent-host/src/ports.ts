import type { ResearchProgressEvent, SecretSettingKey, SettingsChangedEvent } from '@rka/shared';

/**
 * Pushes events to every open UI window. The Electron adapter fans out with
 * `BrowserWindow.getAllWindows()` + `webContents.send(...)`, skipping destroyed
 * windows. Implementations must not throw when no window is open.
 */
export interface HostUiPort {
  /** Electron adapter sends on `IpcEvents.researchProgress`. */
  readonly emitResearchProgress: (event: ResearchProgressEvent) => void;
  /** Electron adapter sends on `IpcEvents.settingsChanged`. */
  readonly emitSettingsChanged: (event: SettingsChangedEvent) => void;
}

/**
 * Native dialogs. Each resolves to the chosen absolute path, or `null` when the
 * user cancels. Paths never come from the renderer.
 */
export interface HostDialogPort {
  /**
   * "Save backup" dialog (Electron: `dialog.showSaveDialog`). The adapter owns the
   * overwrite confirmation and the default folder/file name.
   */
  readonly chooseBackupPath: () => Promise<string | null>;
  /** "Open file" dialog for local PDF/DOCX extraction (Electron: `dialog.showOpenDialog`). */
  readonly chooseFile: () => Promise<string | null>;
  /**
   * "Choose folder" dialog for the default backup folder (Electron:
   * `dialog.showOpenDialog` with `openDirectory`).
   * @param defaultPath Currently configured folder, or `null` for the platform default.
   */
  readonly chooseFolder: (defaultPath: string | null) => Promise<string | null>;
}

/** Hands a URL to the OS. */
export interface HostShellPort {
  /**
   * Opens a URL in the default browser (Electron: `shell.openExternal`). The adapter
   * must refuse anything that is not a safe http(s) URL, in addition to any checks
   * made by the caller.
   */
  readonly openExternal: (url: string) => Promise<void>;
}

/** OS-backed secret storage (Electron: `safeStorage`, DPAPI on Windows). */
export interface HostSecretsPort {
  /** Whether OS encryption is available (Electron: `safeStorage.isEncryptionAvailable()`). */
  readonly encryptionAvailable: () => boolean;
  /** Decrypted secret value, or `undefined` when unset or unreadable. Never logged. */
  readonly getSecret: (key: SecretSettingKey) => string | undefined;
}

/**
 * Everything the agent host needs from its embedding shell. Electron main builds
 * one implementation and passes it to the host; tests pass fakes. The host itself
 * never imports `electron`, and runs in the same process as its shell.
 */
export interface HostPorts extends HostUiPort, HostDialogPort, HostShellPort, HostSecretsPort {}
