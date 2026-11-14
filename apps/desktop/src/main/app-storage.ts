import { type ChatUsage } from '@rka/agent-host';
import {
  appDatabasePath,
  openStorage,
  type RecoveryReport,
  type SecretCipher,
  type Storage,
} from '@rka/storage';
import { agentTransportFromEnv } from './agent-transport.js';

/** `%APPDATA%/<app>/data/research.db` on Windows (Electron userData). */
export function databasePath(userDataDir: string): string {
  return appDatabasePath(userDataDir);
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
 *
 * Refuses with AGENT_TRANSPORT=service: the agent process is then the only
 * SQLite writer.
 */
export function openAppStorage(options: {
  readonly userDataDir: string;
  /** Electron safeStorage in production. */
  readonly cipher?: SecretCipher;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}): AppStorage {
  if (agentTransportFromEnv(options.env ?? process.env) === 'service') {
    throw new Error(
      'AGENT_TRANSPORT=service: the agent service owns the database; Electron must not open it.',
    );
  }
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
