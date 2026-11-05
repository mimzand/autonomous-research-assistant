import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  defaultContext,
  type Database,
  type Executor,
  type StorageContext,
  type Transaction,
} from './context.js';
import { StorageError } from './errors.js';
import { createInspector } from './inspect.js';
import { runMigrations } from './migrate.js';
import { createRecovery } from './recovery.js';
import { createApprovalRepository } from './repositories/approvals.js';
import { createModelUsageRepository } from './repositories/model-usage.js';
import { createReportRepository } from './repositories/reports.js';
import { createSettingsRepository, type SecretCipher } from './repositories/settings.js';
import { createSourceRepository } from './repositories/sources.js';
import { createTaskStepRepository } from './repositories/task-steps.js';
import { createTaskRepository } from './repositories/tasks.js';
import { schema } from './schema.js';

export interface OpenStorageOptions {
  /** Database file path, or ":memory:" (tests). Parent folders are created. */
  readonly path: string;
  /** Encrypts secrets (Electron safeStorage). Without it, setSecret() refuses. */
  readonly cipher?: SecretCipher;
  /** Optional explicit path to the better-sqlite3 native binding. */
  readonly nativeBinding?: string;
  /** Injected clock/id generator for tests. */
  readonly context?: Partial<StorageContext>;
}

export interface Repositories {
  readonly tasks: ReturnType<typeof createTaskRepository>;
  readonly steps: ReturnType<typeof createTaskStepRepository>;
  readonly sources: ReturnType<typeof createSourceRepository>;
  readonly reports: ReturnType<typeof createReportRepository>;
  readonly modelUsage: ReturnType<typeof createModelUsageRepository>;
  readonly settings: ReturnType<typeof createSettingsRepository>;
  readonly approvals: ReturnType<typeof createApprovalRepository>;
  /**
   * Runs `fn` atomically: all writes commit together or none do. Nested
   * calls become savepoints. `fn` must be synchronous (better-sqlite3).
   */
  transaction<T>(fn: (repos: Repositories) => T): T;
}

export interface Storage extends Repositories {
  readonly recovery: ReturnType<typeof createRecovery>;
  /** Read-only dashboard queries, storage status, integrity check and backup. */
  readonly inspect: ReturnType<typeof createInspector>;
  readonly path: string;
  readonly db: Database;
  /** Raw better-sqlite3 handle (diagnostics, tests). Prefer the repositories. */
  readonly sqlite: BetterSqlite3.Database;
  close(): void;
}

function bindRepositories(
  db: Executor,
  ctx: StorageContext,
  cipher: SecretCipher | undefined,
): Repositories {
  const repos: Repositories = {
    tasks: createTaskRepository(db, ctx),
    steps: createTaskStepRepository(db, ctx),
    sources: createSourceRepository(db, ctx),
    reports: createReportRepository(db, ctx),
    modelUsage: createModelUsageRepository(db, ctx),
    settings: createSettingsRepository(db, ctx, cipher),
    approvals: createApprovalRepository(db, ctx),
    transaction: (fn) => runInTransaction(db, (tx) => fn(bindRepositories(tx, ctx, cipher))),
  };
  return repos;
}

function runInTransaction<T>(db: Executor, fn: (tx: Transaction) => T): T {
  return db.transaction((tx) => {
    const result = fn(tx);
    if (result instanceof Promise) {
      // better-sqlite3 transactions are synchronous; an awaited body would
      // run after COMMIT and silently lose atomicity.
      throw new StorageError('invalid-input', 'Transaction callbacks must be synchronous.');
    }
    return result;
  });
}

/** Opens (or creates) the database, applies migrations and returns typed repositories. */
export function openStorage(options: OpenStorageOptions): Storage {
  const ctx: StorageContext = { ...defaultContext, ...options.context };
  const inMemory = options.path === ':memory:';
  if (!inMemory) mkdirSync(dirname(options.path), { recursive: true });

  const sqlite = new BetterSqlite3(
    options.path,
    options.nativeBinding ? { nativeBinding: options.nativeBinding } : {},
  );
  try {
    if (!inMemory) {
      sqlite.pragma('journal_mode = WAL'); // Safe concurrent reads, crash-resilient writes.
      sqlite.pragma('synchronous = NORMAL');
    }
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    runMigrations(sqlite, undefined, ctx.now);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const db = drizzle(sqlite, { schema });
  const repos = bindRepositories(db, ctx, options.cipher);
  return {
    ...repos,
    recovery: createRecovery(db, ctx, (fn) => runInTransaction(db, fn)),
    inspect: createInspector(db, sqlite, ctx, options.path),
    path: options.path,
    db,
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
