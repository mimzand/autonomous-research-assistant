import { join } from 'node:path';
import { openStorage, type RecoveryReport, type SecretCipher, type Storage } from '@rka/storage';
import { type ChatUsage } from './chat.js';

/** `%APPDATA%/<app>/data/research.db` on Windows (Electron userData). */
export function databasePath(userDataDir: string): string {
  return join(userDataDir, 'data', 'research.db');
}

export interface AppStorage {
  readonly storage: Storage;
  /** What startup recovery changed (tasks that were running when the app stopped). */
  readonly recovery: RecoveryReport;
}

/**
 * Opens the database (applying migrations) and runs recovery before any
 * task can start: tasks left `running` by a crash or forced quit become
 * `interrupted`. Nothing is re-executed automatically.
 */
export function openAppStorage(options: {
  readonly userDataDir: string;
  /** Electron safeStorage in production. */
  readonly cipher?: SecretCipher;
}): AppStorage {
  const storage = openStorage({
    path: databasePath(options.userDataDir),
    ...(options.cipher && { cipher: options.cipher }),
  });
  try {
    return { storage, recovery: storage.recovery.recoverInterruptedTasks() };
  } catch (error) {
    storage.close();
    throw error;
  }
}

/** Persists token usage of chat playground replies. */
export function chatUsageRecorder(storage: Storage): (usage: ChatUsage) => void {
  return (usage) => {
    storage.modelUsage.record({ provider: 'ollama', purpose: 'chat', ...usage });
  };
}
