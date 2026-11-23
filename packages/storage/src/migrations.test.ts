import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { listAppliedMigrations, runMigrations } from './migrate.js';
import { MIGRATIONS } from './migrations.generated.js';
import * as schemaModule from './schema.js';
import { openStorage } from './storage.js';
import { tempDir } from './testing.js';

const drizzleDir = join(import.meta.dirname, '..', 'drizzle');
const TABLES = [
  'adk_app_state',
  'adk_events',
  'adk_sessions',
  'adk_user_state',
  'approvals',
  'conversation_messages',
  'conversations',
  'model_usage',
  'reports',
  'settings',
  'source_contents',
  'sources',
  'task_logs',
  'task_steps',
  'tasks',
];

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function tables(sqlite: BetterSqlite3.Database): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  )
    .map((r) => r.name)
    .sort();
}

describe('migrations', () => {
  it('creates every table on a fresh database', () => {
    const sqlite = new BetterSqlite3(':memory:');
    expect(runMigrations(sqlite).applied).toEqual(MIGRATIONS.map((m) => m.tag));
    expect(tables(sqlite)).toEqual(['__migrations', ...TABLES]);
    expect(listAppliedMigrations(sqlite).map((m) => m.tag)).toEqual(MIGRATIONS.map((m) => m.tag));
  });

  it('is idempotent across restarts and keeps data', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const first = openStorage({ path: dbPath });
    first.tasks.create({ title: 'Keep me', input: { question: 'q' } });
    first.close();

    const second = openStorage({ path: dbPath });
    expect(second.tasks.list().map((t) => t.title)).toEqual(['Keep me']);
    second.close();

    const sqlite = new BetterSqlite3(dbPath);
    expect(listAppliedMigrations(sqlite)).toHaveLength(MIGRATIONS.length);
    sqlite.close();
  });

  it('upgrades a database created by the previous version (0000 → 0001) without data loss', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    // A database from the previous release: only the first migration, with data.
    mkdirSync(dirname(dbPath), { recursive: true });
    const old = new BetterSqlite3(dbPath);
    runMigrations(old, MIGRATIONS.slice(0, 1));
    old
      .prepare(
        "insert into tasks (id, title, input, status, created_at, updated_at) values ('t1', 'Old task', '{}', 'completed', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
      )
      .run();
    expect(
      old.prepare("select name from sqlite_master where name = 'task_logs'").get(),
    ).toBeUndefined();
    old.close();

    const upgraded = openStorage({ path: dbPath });
    cleanups.unshift(() => upgraded.close());
    expect(upgraded.tasks.require('t1')).toMatchObject({ title: 'Old task', status: 'completed' });
    upgraded.logs.append('t1', {
      level: 'info',
      event: 'task.note',
      message: 'Logs work after upgrade',
    });
    expect(upgraded.logs.listByTask('t1')).toHaveLength(1);
    expect(listAppliedMigrations(upgraded.sqlite).map((m) => m.tag)).toEqual([
      '0000_initial',
      '0001_task_logs',
      '0002_adk_sessions',
      '0003_conversations',
      '0004_conversation_summary',
    ]);
  });

  it('upgrades a 0001 database to 0002 (ADK sessions) without touching existing tables or data', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    mkdirSync(dirname(dbPath), { recursive: true });
    const old = new BetterSqlite3(dbPath);
    runMigrations(old, MIGRATIONS.slice(0, 2));
    old
      .prepare(
        "insert into tasks (id, title, input, status, created_at, updated_at) values ('t1', 'Old task', '{\"question\":\"q\"}', 'completed', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
      )
      .run();
    old
      .prepare(
        "insert into task_logs (id, task_id, seq, level, event, message, created_at, updated_at) values ('l1', 't1', 1, 'info', 'task.note', 'before upgrade', '2026-11-01T00:00:01Z', '2026-11-01T00:00:01Z')",
      )
      .run();
    const schemaBefore = old
      .prepare(
        "select name, sql from sqlite_master where name not like 'adk_%' and name not like 'conversation%' and name not like 'sqlite_%' and name != '__migrations' order by name",
      )
      .all();
    const dataBefore = {
      tasks: old.prepare('select * from tasks').all(),
      logs: old.prepare('select * from task_logs').all(),
    };
    old.close();

    const upgraded = openStorage({ path: dbPath });
    cleanups.unshift(() => upgraded.close());
    const sqlite = upgraded.sqlite;
    expect(
      sqlite
        .prepare(
          "select name, sql from sqlite_master where name not like 'adk_%' and name not like 'conversation%' and name not like 'sqlite_%' and name != '__migrations' order by name",
        )
        .all(),
    ).toEqual(schemaBefore);
    expect(sqlite.prepare('select * from tasks').all()).toEqual(dataBefore.tasks);
    expect(sqlite.prepare('select * from task_logs').all()).toEqual(dataBefore.logs);
    expect(tables(sqlite)).toEqual(['__migrations', ...TABLES]);
    // The new tables work after the upgrade.
    upgraded.adkSessions.create({
      key: { appName: 'app', userId: 'u', sessionId: 's' },
      nowMs: 1,
    });
    expect(upgraded.adkSessions.get({ appName: 'app', userId: 'u', sessionId: 's' })).toBeDefined();
    expect(listAppliedMigrations(sqlite).map((m) => m.tag)).toEqual([
      '0000_initial',
      '0001_task_logs',
      '0002_adk_sessions',
      '0003_conversations',
      '0004_conversation_summary',
    ]);
  });

  it('upgrades a 0002 database to conversations without touching existing tables or data', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    mkdirSync(dirname(dbPath), { recursive: true });
    const old = new BetterSqlite3(dbPath);
    runMigrations(old, MIGRATIONS.slice(0, 3));
    old
      .prepare(
        "insert into tasks (id, title, input, status, created_at, updated_at) values ('t1', 'Old task', '{\"question\":\"q\"}', 'completed', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
      )
      .run();
    const schemaBefore = old
      .prepare(
        "select name, sql from sqlite_master where name not like 'conversation%' and name not like 'sqlite_%' and name != '__migrations' order by name",
      )
      .all();
    const tasksBefore = old.prepare('select * from tasks').all();
    old.close();

    const upgraded = openStorage({ path: dbPath });
    cleanups.unshift(() => upgraded.close());
    const sqlite = upgraded.sqlite;
    expect(
      sqlite
        .prepare(
          "select name, sql from sqlite_master where name not like 'conversation%' and name not like 'sqlite_%' and name != '__migrations' order by name",
        )
        .all(),
    ).toEqual(schemaBefore);
    expect(sqlite.prepare('select * from tasks').all()).toEqual(tasksBefore);
    expect(tables(sqlite)).toEqual(['__migrations', ...TABLES]);
    expect(upgraded.conversations.list()).toEqual([]);
    const { id } = upgraded.conversations.create();
    upgraded.conversations.append({
      conversationId: id,
      role: 'user',
      content: 'Hello',
      status: 'complete',
    });
    expect(upgraded.conversations.get(id)?.title).toBe('Hello');
    expect(
      listAppliedMigrations(sqlite)
        .map((m) => m.tag)
        .at(-1),
    ).toBe('0004_conversation_summary');
  });

  it('upgrades a 0003 database: its conversation and messages stay, with no summary yet', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    mkdirSync(dirname(dbPath), { recursive: true });
    const old = new BetterSqlite3(dbPath);
    old.pragma('foreign_keys = ON');
    runMigrations(old, MIGRATIONS.slice(0, 4));
    old
      .prepare(
        "insert into conversations (id, title, model, created_at, updated_at) values ('c1', 'Old chat', 'qwen3:8b', '2026-11-01T00:00:00Z', '2026-11-01T00:00:02Z')",
      )
      .run();
    const insert = old.prepare(
      "insert into conversation_messages (id, conversation_id, seq, role, content, status, created_at, updated_at) values (?, 'c1', ?, ?, ?, 'complete', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
    );
    insert.run('m1', 1, 'user', 'Old question');
    insert.run('m2', 2, 'assistant', 'Old answer');
    old.close();

    const upgraded = openStorage({ path: dbPath });
    cleanups.unshift(() => upgraded.close());
    expect(upgraded.conversations.list()).toEqual([
      expect.objectContaining({
        id: 'c1',
        title: 'Old chat',
        model: 'qwen3:8b',
        summary: null,
        summarizedThroughSeq: null,
      }),
    ]);
    expect(upgraded.conversations.listMessages('c1').map((m) => m.content)).toEqual([
      'Old question',
      'Old answer',
    ]);
  });

  it('refuses migrations that were edited after being applied', () => {
    const sqlite = new BetterSqlite3(':memory:');
    runMigrations(sqlite);
    const tampered = MIGRATIONS.map((m) => ({ ...m, hash: 'different' }));
    expect(() => runMigrations(sqlite, tampered)).toThrow(/was modified after it was applied/);
  });

  it('refuses a database created by a newer app version', () => {
    const sqlite = new BetterSqlite3(':memory:');
    runMigrations(sqlite);
    sqlite.prepare('INSERT INTO __migrations VALUES (?, ?, ?)').run('9999_future', 'x', 'now');
    expect(() => runMigrations(sqlite)).toThrow(/newer version/);
  });

  it('rolls back a failing migration completely', () => {
    const sqlite = new BetterSqlite3(':memory:');
    const broken = [
      { tag: '0000_broken', hash: 'h', statements: ['CREATE TABLE ok (id int)', 'NOT SQL'] },
    ];
    expect(() => runMigrations(sqlite, broken)).toThrow(/0000_broken failed/);
    expect(tables(sqlite)).toEqual(['__migrations']);
    expect(listAppliedMigrations(sqlite)).toEqual([]);
  });

  it('enables foreign keys and WAL for file databases', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const storage = openStorage({ path: dbPath });
    const sqlite = new BetterSqlite3(dbPath);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    sqlite.close();
    expect(storage.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    storage.close();
  });

  it('embedded migrations match the drizzle folder (run db:embed if this fails)', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    expect(MIGRATIONS.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag));
    for (const migration of MIGRATIONS) {
      const sql = readFileSync(join(drizzleDir, `${migration.tag}.sql`), 'utf8').replace(
        /\r\n/g,
        '\n',
      );
      expect(migration.hash).toBe(createHash('sha256').update(sql).digest('hex'));
    }
  });

  it('schema.ts has no changes missing from the migrations (run db:generate if this fails)', async () => {
    const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import('drizzle-kit/api');
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number }[];
    };
    const lastIdx = String(journal.entries.at(-1)?.idx ?? 0).padStart(4, '0');
    const snapshot = JSON.parse(
      readFileSync(join(drizzleDir, 'meta', `${lastIdx}_snapshot.json`), 'utf8'),
    ) as Parameters<typeof generateSQLiteMigration>[0];
    const current = await generateSQLiteDrizzleJson(schemaModule, snapshot.id);
    expect(await generateSQLiteMigration(snapshot, current)).toEqual([]);
  });
});
