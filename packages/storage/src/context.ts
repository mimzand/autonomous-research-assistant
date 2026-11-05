import { randomUUID } from 'node:crypto';
import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { type SQLiteTransaction } from 'drizzle-orm/sqlite-core';
import { type ExtractTablesWithRelations } from 'drizzle-orm';
import { type RunResult } from 'better-sqlite3';
import { type schema } from './schema.js';

type Schema = typeof schema;

export type Database = BetterSQLite3Database<Schema>;
export type Transaction = SQLiteTransaction<
  'sync',
  RunResult,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
/** A database handle or an open transaction; repositories work with either. */
export type Executor = Database | Transaction;

/** Injectable clock and id generator (deterministic tests). */
export interface StorageContext {
  readonly now: () => string;
  readonly newId: () => string;
}

export const defaultContext: StorageContext = {
  now: () => new Date().toISOString(),
  newId: () => randomUUID(),
};
