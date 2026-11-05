import type BetterSqlite3 from 'better-sqlite3';
import { StorageError } from './errors.js';
import { MIGRATIONS, type EmbeddedMigration } from './migrations.generated.js';

export interface AppliedMigration {
  readonly tag: string;
  readonly hash: string;
  readonly appliedAt: string;
}

/**
 * Applies pending migrations, each in its own transaction, and records them
 * in `__migrations`. Refuses to run if an already-applied migration was
 * edited (hash mismatch) or if the database is newer than this app.
 */
export function runMigrations(
  sqlite: BetterSqlite3.Database,
  migrations: readonly EmbeddedMigration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): { applied: string[] } {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __migrations (
    tag TEXT PRIMARY KEY NOT NULL,
    hash TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const done = new Map(
    (
      sqlite.prepare('SELECT tag, hash FROM __migrations').all() as { tag: string; hash: string }[]
    ).map((row) => [row.tag, row.hash]),
  );

  const known = new Set(migrations.map((m) => m.tag));
  const unknown = [...done.keys()].filter((tag) => !known.has(tag));
  if (unknown.length) {
    throw new StorageError(
      'migration-failed',
      `Database was created by a newer version of the app (unknown migrations: ${unknown.join(', ')}).`,
    );
  }

  const applied: string[] = [];
  const insert = sqlite.prepare(
    'INSERT INTO __migrations (tag, hash, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of migrations) {
    const recorded = done.get(migration.tag);
    if (recorded !== undefined) {
      if (recorded !== migration.hash) {
        throw new StorageError(
          'migration-failed',
          `Migration ${migration.tag} was modified after it was applied. Create a new migration instead.`,
        );
      }
      continue;
    }
    try {
      sqlite.transaction(() => {
        for (const statement of migration.statements) sqlite.exec(statement);
        insert.run(migration.tag, migration.hash, now());
      })();
    } catch (cause) {
      throw new StorageError('migration-failed', `Migration ${migration.tag} failed.`, { cause });
    }
    applied.push(migration.tag);
  }
  return { applied };
}

export function listAppliedMigrations(sqlite: BetterSqlite3.Database): AppliedMigration[] {
  return sqlite
    .prepare('SELECT tag, hash, applied_at AS appliedAt FROM __migrations ORDER BY tag')
    .all() as AppliedMigration[];
}
