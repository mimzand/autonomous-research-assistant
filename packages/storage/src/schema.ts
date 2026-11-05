/*
 * Database schema (source of truth). Migrations in ../drizzle are generated
 * from this file with `pnpm --filter @rka/storage db:generate`.
 * Documented in ../SCHEMA.md - update it when this file changes.
 *
 * Conventions:
 * - ids are UUID text; timestamps are ISO-8601 UTC text (sortable).
 * - every table has created_at and updated_at, set by the repositories.
 * - JSON columns hold Zod-validated, JSON-serialisable values.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};

const inList = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

export const TASK_STATUSES = [
  'pending',
  'running',
  'awaiting-approval',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
] as const;

export const STEP_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'interrupted',
  'skipped',
] as const;

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** A research task: the user's request (input), its result (output) and lifecycle. */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    input: text('input', { mode: 'json' }).$type<JsonValue>().notNull(),
    output: text('output', { mode: 'json' }).$type<JsonValue>(),
    status: text('status', { enum: TASK_STATUSES }).notNull(),
    error: text('error'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    ...timestamps,
  },
  (t) => [
    index('tasks_status_idx').on(t.status),
    index('tasks_created_at_idx').on(t.createdAt),
    check('tasks_status_check', inList(t.status, TASK_STATUSES)),
  ],
);

/** One execution step of a task, in order. Completed steps are never re-run. */
export const taskSteps = sqliteTable(
  'task_steps',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: STEP_STATUSES }).notNull(),
    input: text('input', { mode: 'json' }).$type<JsonValue>(),
    output: text('output', { mode: 'json' }).$type<JsonValue>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('task_steps_task_seq_uq').on(t.taskId, t.seq),
    index('task_steps_status_idx').on(t.status),
    check('task_steps_status_check', inList(t.status, STEP_STATUSES)),
    check('task_steps_seq_check', sql`${t.seq} >= 1`),
  ],
);

/** A web source collected for a task. Content is stored separately. */
export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    retrievedAt: text('retrieved_at'),
    metadata: text('metadata', { mode: 'json' }).$type<JsonValue>(),
    ...timestamps,
  },
  (t) => [uniqueIndex('sources_task_url_uq').on(t.taskId, t.url)],
);

/** Extracted text of a source (one row per source). Untrusted data - never instructions. */
export const sourceContents = sqliteTable('source_contents', {
  id: text('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .unique('source_contents_source_uq')
    .references(() => sources.id, { onDelete: 'cascade' }),
  contentType: text('content_type').notNull(),
  text: text('text').notNull(),
  byteLength: integer('byte_length').notNull(),
  sha256: text('sha256').notNull(),
  ...timestamps,
});

/** Generated report. Each regeneration adds a new version. */
export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    format: text('format', { enum: ['markdown'] }).notNull(),
    content: text('content').notNull(),
    /** Ids of sources cited by the report. */
    citedSourceIds: text('cited_source_ids', { mode: 'json' }).$type<string[]>().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('reports_task_version_uq').on(t.taskId, t.version)],
);

/** Token usage per model call. task/step are optional (e.g. chat playground). */
export const modelUsage = sqliteTable(
  'model_usage',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    stepId: text('step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    purpose: text('purpose').notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalDurationMs: integer('total_duration_ms'),
    loadDurationMs: integer('load_duration_ms'),
    ...timestamps,
  },
  (t) => [
    index('model_usage_task_idx').on(t.taskId),
    index('model_usage_created_at_idx').on(t.createdAt),
  ],
);

/**
 * Application settings. Secrets are stored only as ciphertext produced by
 * the OS keychain (Electron safeStorage); plaintext secrets are rejected.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON value for normal settings; base64 ciphertext for secrets. */
  value: text('value').notNull(),
  isSecret: integer('is_secret', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
});

/** Human approval for write actions requested by the agent. */
export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => taskSteps.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    summary: text('summary').notNull(),
    payload: text('payload', { mode: 'json' }).$type<JsonValue>(),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull(),
    reason: text('reason'),
    decidedAt: text('decided_at'),
    ...timestamps,
  },
  (t) => [
    index('approvals_status_idx').on(t.status),
    index('approvals_task_idx').on(t.taskId),
    check('approvals_status_check', inList(t.status, APPROVAL_STATUSES)),
  ],
);

export const schema = {
  tasks,
  taskSteps,
  sources,
  sourceContents,
  reports,
  modelUsage,
  settings,
  approvals,
};

export type TaskRecord = typeof tasks.$inferSelect;
export type TaskStepRecord = typeof taskSteps.$inferSelect;
export type SourceRecord = typeof sources.$inferSelect;
export type SourceContentRecord = typeof sourceContents.$inferSelect;
export type ReportRecord = typeof reports.$inferSelect;
export type ModelUsageRecord = typeof modelUsage.$inferSelect;
export type SettingRecord = typeof settings.$inferSelect;
export type ApprovalRecord = typeof approvals.$inferSelect;
