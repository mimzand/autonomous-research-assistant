import { StorageError } from './errors.js';

/** Maps SQLite constraint errors (from better-sqlite3) to StorageError. Rethrows anything else. */
export function mapSqliteError(error: unknown, what: string): never {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    throw new StorageError('not-found', `${what}: a referenced record does not exist.`, {
      cause: error,
    });
  }
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    throw new StorageError('conflict', `${what}: a record with the same key already exists.`, {
      cause: error,
    });
  }
  if (code === 'SQLITE_CONSTRAINT_CHECK') {
    throw new StorageError('invalid-input', `${what}: value violates a database constraint.`, {
      cause: error,
    });
  }
  throw error;
}

/** Runs a write and maps constraint violations. */
export function guarded<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    return mapSqliteError(error, what);
  }
}
