import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ReportListQuerySchema,
  SourceListQuerySchema,
  TaskListQuerySchema,
  TaskStatusSchema,
  type IntegrityCheckResult,
  type ReportDetails,
  type ReportListQuery,
  type ReportListResult,
  type SourceDetails,
  type SourceListQuery,
  type SourceListResult,
  type SourceSummary,
  type StorageStatus,
  type TaskListQuery,
  type TaskListResult,
  type TaskStatus,
  type TaskStatusCounts,
} from '@rka/shared';
import BetterSqlite3 from 'better-sqlite3';
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { type Database, type StorageContext } from './context.js';
import { StorageError } from './errors.js';
import { listAppliedMigrations } from './migrate.js';
import { createModelUsageRepository } from './repositories/model-usage.js';
import { createSettingsRepository } from './repositories/settings.js';
import {
  approvals,
  reports,
  sourceContents,
  sources,
  taskSteps,
  tasks,
  type JsonValue,
  type TaskRecord,
  type TaskStepRecord,
} from './schema.js';
import { parseInput } from './validation.js';

/** Every table, for row counts. Fixed list: never built from user input. */
export const TABLE_NAMES = [
  'tasks',
  'task_steps',
  'sources',
  'source_contents',
  'reports',
  'model_usage',
  'settings',
  'approvals',
] as const;

const INTEGRITY_KEY = 'storage.integrity.last';
const INTEGRITY_SUCCESS_KEY = 'storage.integrity.lastSuccessAt';
const MAX_INTEGRITY_MESSAGES = 50;

/** `%term%` for LIKE, with LIKE wildcards in the term escaped. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const like = (column: SQL | Parameters<typeof eq>[0], term: string) =>
  sql`${column} LIKE ${likePattern(term)} ESCAPE '\\'`;

/** Short text form of a task input, e.g. its question. */
export function inputPreview(input: JsonValue, max = 200): string {
  let text: string;
  if (typeof input === 'string') text = input;
  else if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    typeof input['question'] === 'string'
  )
    text = input['question'];
  else text = JSON.stringify(input);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface TaskDetailsRecord {
  readonly task: TaskRecord;
  readonly steps: TaskStepRecord[];
  readonly sourceCount: number;
  readonly reportCount: number;
  readonly pendingApprovalCount: number;
  readonly usage: ReturnType<ReturnType<typeof createModelUsageRepository>['totals']>;
}

/**
 * Read-only queries for the dashboard. Everything comes straight from SQLite;
 * listings are paginated and filtered in SQL so large datasets stay fast.
 */
export function createInspector(
  db: Database,
  sqlite: BetterSqlite3.Database,
  ctx: StorageContext,
  path: string,
) {
  // Correlated subqueries must reference the outer table explicitly: a bare
  // "id" would resolve to the inner table's id and count nothing.
  const outerTaskId = sql.raw('"tasks"."id"');
  const stepCount = sql<number>`(SELECT count(*) FROM task_steps s WHERE s.task_id = ${outerTaskId})`;
  const completedStepCount = sql<number>`(SELECT count(*) FROM task_steps s WHERE s.task_id = ${outerTaskId} AND s.status = 'completed')`;
  const sourceCount = sql<number>`(SELECT count(*) FROM sources src WHERE src.task_id = ${outerTaskId})`;
  const settingsRepo = createSettingsRepository(db, ctx, undefined);

  function countWhere(table: typeof tasks | typeof sources | typeof reports, where?: SQL) {
    return db.select({ n: count() }).from(table).where(where).get()?.n ?? 0;
  }

  return {
    // --- Tasks ---------------------------------------------------------------

    taskStatusCounts(): TaskStatusCounts {
      const rows = db
        .select({ status: tasks.status, n: count() })
        .from(tasks)
        .groupBy(tasks.status)
        .all();
      const byStatus = Object.fromEntries(TaskStatusSchema.options.map((s) => [s, 0])) as Record<
        TaskStatus,
        number
      >;
      for (const row of rows) byStatus[row.status] = row.n;
      return { total: rows.reduce((sum, r) => sum + r.n, 0), byStatus };
    },

    listTasks(query: TaskListQuery = {}): TaskListResult {
      const q = parseInput(TaskListQuerySchema, query, 'task query');
      const where = and(
        q.status?.length ? inArray(tasks.status, q.status) : undefined,
        q.search ? or(like(tasks.title, q.search), like(tasks.input, q.search)) : undefined,
      );
      const rows = db
        .select({
          id: tasks.id,
          title: tasks.title,
          input: tasks.input,
          status: tasks.status,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
          startedAt: tasks.startedAt,
          finishedAt: tasks.finishedAt,
          stepCount,
          completedStepCount,
          sourceCount,
        })
        .from(tasks)
        .where(where)
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(q.limit)
        .offset(q.offset)
        .all();
      return {
        items: rows.map(({ input, ...row }) => ({ ...row, inputPreview: inputPreview(input) })),
        total: countWhere(tasks, where),
      };
    },

    getTaskDetails(id: string): TaskDetailsRecord | undefined {
      const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
      if (!task) return undefined;
      return {
        task,
        steps: db
          .select()
          .from(taskSteps)
          .where(eq(taskSteps.taskId, id))
          .orderBy(asc(taskSteps.seq))
          .all(),
        sourceCount: countWhere(sources, eq(sources.taskId, id)),
        reportCount: countWhere(reports, eq(reports.taskId, id)),
        pendingApprovalCount:
          db
            .select({ n: count() })
            .from(approvals)
            .where(and(eq(approvals.taskId, id), eq(approvals.status, 'pending')))
            .get()?.n ?? 0,
        usage: createModelUsageRepository(db, ctx).totals(id),
      };
    },

    // --- Knowledge base -------------------------------------------------------

    listSources(query: SourceListQuery = {}): SourceListResult {
      const q = parseInput(SourceListQuerySchema, query, 'source query');
      const where = and(
        q.taskId ? eq(sources.taskId, q.taskId) : undefined,
        q.search
          ? or(
              like(sources.url, q.search),
              like(sources.title, q.search),
              like(tasks.title, q.search),
            )
          : undefined,
        q.content === 'extracted' ? sql`${sourceContents.id} IS NOT NULL` : undefined,
        q.content === 'missing' ? sql`${sourceContents.id} IS NULL` : undefined,
      );
      const base = () =>
        db
          .select({
            id: sources.id,
            taskId: sources.taskId,
            taskTitle: tasks.title,
            url: sources.url,
            title: sources.title,
            retrievedAt: sources.retrievedAt,
            createdAt: sources.createdAt,
            updatedAt: sources.updatedAt,
            contentType: sourceContents.contentType,
            byteLength: sourceContents.byteLength,
            sha256: sourceContents.sha256,
          })
          .from(sources)
          .innerJoin(tasks, eq(tasks.id, sources.taskId))
          .leftJoin(sourceContents, eq(sourceContents.sourceId, sources.id));

      // Grouped by task in the UI: order by task (newest first), then source.
      const rows = base()
        .where(where)
        .orderBy(desc(tasks.createdAt), asc(tasks.id), asc(sources.createdAt), asc(sources.id))
        .limit(q.limit)
        .offset(q.offset)
        .all();

      const total =
        db
          .select({ n: count() })
          .from(sources)
          .innerJoin(tasks, eq(tasks.id, sources.taskId))
          .leftJoin(sourceContents, eq(sourceContents.sourceId, sources.id))
          .where(where)
          .get()?.n ?? 0;

      const totals = db
        .select({
          sources: count(),
          withContent: count(sourceContents.id),
          contentBytes: sql<number>`coalesce(sum(${sourceContents.byteLength}), 0)`,
          tasksWithSources: sql<number>`count(DISTINCT ${sources.taskId})`,
        })
        .from(sources)
        .leftJoin(sourceContents, eq(sourceContents.sourceId, sources.id))
        .get() ?? { sources: 0, withContent: 0, contentBytes: 0, tasksWithSources: 0 };

      return {
        items: rows.map((row): SourceSummary => ({ ...row, hasContent: row.sha256 !== null })),
        total,
        totals: {
          sources: totals.sources,
          withContent: totals.withContent,
          contentBytes: Number(totals.contentBytes),
          tasksWithSources: Number(totals.tasksWithSources),
        },
      };
    },

    getSource(id: string): SourceDetails | undefined {
      const row = db
        .select({ source: sources, taskTitle: tasks.title, content: sourceContents })
        .from(sources)
        .innerJoin(tasks, eq(tasks.id, sources.taskId))
        .leftJoin(sourceContents, eq(sourceContents.sourceId, sources.id))
        .where(eq(sources.id, id))
        .get();
      if (!row) return undefined;
      const { source, content } = row;
      return {
        source: {
          id: source.id,
          taskId: source.taskId,
          taskTitle: row.taskTitle,
          url: source.url,
          title: source.title,
          retrievedAt: source.retrievedAt,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
          metadata: source.metadata ?? null,
          hasContent: content !== null,
          contentType: content?.contentType ?? null,
          byteLength: content?.byteLength ?? null,
          sha256: content?.sha256 ?? null,
        },
        content: content
          ? {
              contentType: content.contentType,
              text: content.text,
              byteLength: content.byteLength,
              sha256: content.sha256,
              createdAt: content.createdAt,
              updatedAt: content.updatedAt,
            }
          : null,
      };
    },

    // --- Reports --------------------------------------------------------------

    listReports(query: ReportListQuery = {}): ReportListResult {
      const q = parseInput(ReportListQuerySchema, query, 'report query');
      const where = and(
        q.taskId ? eq(reports.taskId, q.taskId) : undefined,
        q.search ? or(like(reports.title, q.search), like(tasks.title, q.search)) : undefined,
      );
      const rows = db
        .select({
          id: reports.id,
          taskId: reports.taskId,
          taskTitle: tasks.title,
          title: reports.title,
          version: reports.version,
          format: reports.format,
          createdAt: reports.createdAt,
          updatedAt: reports.updatedAt,
          citedCount: sql<number>`json_array_length(${reports.citedSourceIds})`,
          contentLength: sql<number>`length(${reports.content})`,
        })
        .from(reports)
        .innerJoin(tasks, eq(tasks.id, reports.taskId))
        .where(where)
        .orderBy(desc(reports.createdAt), desc(reports.version))
        .limit(q.limit)
        .offset(q.offset)
        .all();
      const total =
        db
          .select({ n: count() })
          .from(reports)
          .innerJoin(tasks, eq(tasks.id, reports.taskId))
          .where(where)
          .get()?.n ?? 0;
      return { items: rows, total };
    },

    getReport(id: string): ReportDetails | undefined {
      const row = db
        .select({ report: reports, taskTitle: tasks.title })
        .from(reports)
        .innerJoin(tasks, eq(tasks.id, reports.taskId))
        .where(eq(reports.id, id))
        .get();
      if (!row) return undefined;
      const { report } = row;
      const cited = report.citedSourceIds.length
        ? db
            .select({ id: sources.id, url: sources.url, title: sources.title })
            .from(sources)
            .where(inArray(sources.id, report.citedSourceIds))
            .all()
        : [];
      // Keep the report's citation order.
      const byId = new Map(cited.map((s) => [s.id, s]));
      return {
        report: {
          id: report.id,
          taskId: report.taskId,
          taskTitle: row.taskTitle,
          title: report.title,
          version: report.version,
          format: report.format,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
          citedCount: report.citedSourceIds.length,
          contentLength: report.content.length,
          content: report.content,
        },
        citedSources: report.citedSourceIds.flatMap((sid) => {
          const source = byId.get(sid);
          return source ? [source] : [];
        }),
      };
    },

    // --- Storage --------------------------------------------------------------

    status(): StorageStatus {
      const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);
      const inMemory = path === ':memory:';
      const pragma = (name: string) => sqlite.pragma(name, { simple: true }) as unknown;
      return {
        connected: sqlite.open,
        path,
        files: {
          databaseBytes: inMemory ? 0 : fileSize(path),
          walBytes: inMemory ? 0 : fileSize(`${path}-wal`),
          shmBytes: inMemory ? 0 : fileSize(`${path}-shm`),
        },
        sqliteVersion: String(
          (sqlite.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
        ),
        journalMode: String(pragma('journal_mode')),
        foreignKeys: Number(pragma('foreign_keys')) === 1,
        pageSize: Number(pragma('page_size')),
        pageCount: Number(pragma('page_count')),
        freePages: Number(pragma('freelist_count')),
        migrations: listAppliedMigrations(sqlite).map(({ tag, appliedAt }) => ({ tag, appliedAt })),
        tables: TABLE_NAMES.map((name) => ({
          name,
          rows: (sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n,
        })),
        lastIntegrityCheck:
          (settingsRepo.get(INTEGRITY_KEY) as IntegrityCheckResult | undefined) ?? null,
        lastSuccessfulIntegrityCheckAt:
          (settingsRepo.get(INTEGRITY_SUCCESS_KEY) as string | undefined) ?? null,
      };
    },

    /** Runs `PRAGMA integrity_check` and records the result (and last success) in settings. */
    integrityCheck(): IntegrityCheckResult {
      const started = Date.now();
      const rows = sqlite.pragma('integrity_check') as { integrity_check: string }[];
      const messages = rows.map((r) => r.integrity_check).slice(0, MAX_INTEGRITY_MESSAGES);
      const result: IntegrityCheckResult = {
        ok: messages.length === 1 && messages[0] === 'ok',
        messages,
        checkedAt: ctx.now(),
        durationMs: Date.now() - started,
      };
      settingsRepo.set(INTEGRITY_KEY, { ...result, messages: [...result.messages] });
      if (result.ok) settingsRepo.set(INTEGRITY_SUCCESS_KEY, result.checkedAt);
      return result;
    },

    /**
     * Writes a consistent online backup (safe while the app runs, WAL included)
     * to `destination`. Writes to a temporary file first and renames it into
     * place, so a failed backup never damages an existing file. The caller
     * must have confirmed overwriting an existing destination.
     */
    async backupTo(
      destination: string,
    ): Promise<{ path: string; bytes: number; verified: boolean }> {
      if (path === ':memory:') {
        throw new StorageError('invalid-input', 'In-memory databases cannot be backed up.');
      }
      const target = resolve(destination);
      const live = resolve(path);
      if (
        [live, `${live}-wal`, `${live}-shm`].some((p) => p.toLowerCase() === target.toLowerCase())
      ) {
        throw new StorageError('invalid-input', 'A backup cannot replace the live database.');
      }
      const temp = `${target}.partial-${process.pid}`;
      try {
        await sqlite.backup(temp);
        const copy = new BetterSqlite3(temp, { readonly: true, fileMustExist: true });
        let verified: boolean;
        try {
          verified = copy.pragma('quick_check', { simple: true }) === 'ok';
        } finally {
          copy.close();
        }
        renameSync(temp, target);
        return { path: target, bytes: statSync(target).size, verified };
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    },
  };
}

export type Inspector = ReturnType<typeof createInspector>;
