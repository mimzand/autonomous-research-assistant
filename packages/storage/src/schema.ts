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
  foreignKey,
  index,
  integer,
  primaryKey,
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

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export const CONVERSATION_ROLES = ['user', 'assistant'] as const;
export const CONVERSATION_MESSAGE_STATUSES = ['complete', 'cancelled', 'error'] as const;

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

/**
 * Execution log of a task: lifecycle changes, step attempts, retries, failures
 * and recovery decisions. Append-only; ordered by `seq` within a task.
 */
export const taskLogs = sqliteTable(
  'task_logs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => taskSteps.id, { onDelete: 'set null' }),
    seq: integer('seq').notNull(),
    level: text('level', { enum: LOG_LEVELS }).notNull(),
    /** Machine-readable event name, e.g. `step.retry` or `task.paused`. */
    event: text('event').notNull(),
    message: text('message').notNull(),
    data: text('data', { mode: 'json' }).$type<JsonValue>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('task_logs_task_seq_uq').on(t.taskId, t.seq),
    index('task_logs_step_idx').on(t.stepId),
    check('task_logs_level_check', inList(t.level, LOG_LEVELS)),
    check('task_logs_seq_check', sql`${t.seq} >= 1`),
  ],
);

// -----------------------------------------------------------------------------
// Google ADK sessions (migration 0002). Infrastructure only: no production
// feature writes these tables yet. Rows are keyed exactly like ADK keys them
// (app name, user id, session id), so a session is only reachable with all
// three. The JSON columns hold ADK's own plain-data session state and events;
// the adk-runtime package validates and (de)serialises them.
// -----------------------------------------------------------------------------

/** An ADK session: its own (session-scoped) state and its update clock. */
export const adkSessions = sqliteTable(
  'adk_sessions',
  {
    appName: text('app_name').notNull(),
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    /** Session-scoped state only (no `app:`, `user:` or `temp:` keys). */
    state: text('state', { mode: 'json' }).$type<Record<string, JsonValue>>().notNull(),
    /** ADK `lastUpdateTime` (epoch ms): the timestamp of the last appended event. */
    updateTimeMs: integer('update_time_ms').notNull(),
    /** Number of stored events; the next event gets `event_count + 1` as its seq. */
    eventCount: integer('event_count').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'adk_sessions_pk', columns: [t.appName, t.userId, t.id] }),
    index('adk_sessions_user_update_idx').on(t.appName, t.userId, t.updateTimeMs),
    check('adk_sessions_event_count_check', sql`${t.eventCount} >= 0`),
  ],
);

/** One non-partial ADK event, in append order (`seq`) within its session. */
export const adkEvents = sqliteTable(
  'adk_events',
  {
    appName: text('app_name').notNull(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    id: text('id').notNull(),
    seq: integer('seq').notNull(),
    invocationId: text('invocation_id').notNull(),
    author: text('author'),
    /** ADK event timestamp (epoch ms). */
    timestampMs: integer('timestamp_ms').notNull(),
    /** The serialised ADK event (plain JSON data). */
    event: text('event', { mode: 'json' }).$type<Record<string, JsonValue>>().notNull(),
    byteLength: integer('byte_length').notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ name: 'adk_events_pk', columns: [t.appName, t.userId, t.sessionId, t.id] }),
    foreignKey({
      name: 'adk_events_session_fk',
      columns: [t.appName, t.userId, t.sessionId],
      foreignColumns: [adkSessions.appName, adkSessions.userId, adkSessions.id],
    }).onDelete('cascade'),
    uniqueIndex('adk_events_session_seq_uq').on(t.appName, t.userId, t.sessionId, t.seq),
    index('adk_events_invocation_idx').on(t.appName, t.userId, t.sessionId, t.invocationId),
    check('adk_events_seq_check', sql`${t.seq} >= 1`),
  ],
);

/** ADK `app:` state, shared by all users and sessions of an app. */
export const adkAppState = sqliteTable('adk_app_state', {
  appName: text('app_name').primaryKey(),
  state: text('state', { mode: 'json' }).$type<Record<string, JsonValue>>().notNull(),
  ...timestamps,
});

/** ADK `user:` state, shared by all sessions of one user in an app. */
export const adkUserState = sqliteTable(
  'adk_user_state',
  {
    appName: text('app_name').notNull(),
    userId: text('user_id').notNull(),
    state: text('state', { mode: 'json' }).$type<Record<string, JsonValue>>().notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ name: 'adk_user_state_pk', columns: [t.appName, t.userId] })],
);

/**
 * One Chat conversation (the app keeps several; the renderer picks one). `model` is
 * null until the first reply names one; `title` is `New chat` until the first user
 * message, then that message, trimmed, at most 80 characters.
 *
 * `summary` is a model-written digest of the turns that fell out of the 8-turn
 * window, and `summarized_through_seq` the highest message `seq` folded into it.
 * Both are null until the first summary is accepted (`seq` starts at 1, so 0 would
 * be ambiguous).
 */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    model: text('model'),
    summary: text('summary'),
    summarizedThroughSeq: integer('summarized_through_seq'),
    ...timestamps,
  },
  // No CHECK on the summary pair: adding one would rebuild the table (and its
  // cascading messages). The repository writes both columns together, cursor >= 1.
  (t) => [index('conversations_updated_idx').on(t.updatedAt)],
);

/** One Chat bubble, in `seq` order (1, 2, 3… per conversation). Tool steps are not stored. */
export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: CONVERSATION_ROLES }).notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: CONVERSATION_MESSAGE_STATUSES }).notNull(),
    model: text('model'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('conversation_messages_seq_uq').on(t.conversationId, t.seq),
    check('conversation_messages_role_check', inList(t.role, CONVERSATION_ROLES)),
    check('conversation_messages_status_check', inList(t.status, CONVERSATION_MESSAGE_STATUSES)),
    check('conversation_messages_seq_check', sql`${t.seq} >= 1`),
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
  taskLogs,
  adkSessions,
  adkEvents,
  adkAppState,
  adkUserState,
  conversations,
  conversationMessages,
};

export type TaskRecord = typeof tasks.$inferSelect;
export type TaskStepRecord = typeof taskSteps.$inferSelect;
export type SourceRecord = typeof sources.$inferSelect;
export type SourceContentRecord = typeof sourceContents.$inferSelect;
export type ReportRecord = typeof reports.$inferSelect;
export type ModelUsageRecord = typeof modelUsage.$inferSelect;
export type SettingRecord = typeof settings.$inferSelect;
export type ApprovalRecord = typeof approvals.$inferSelect;
export type TaskLogRecord = typeof taskLogs.$inferSelect;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type AdkSessionRecord = typeof adkSessions.$inferSelect;
export type AdkEventRecord = typeof adkEvents.$inferSelect;
export type ConversationRecord = typeof conversations.$inferSelect;
export type ConversationMessageRecord = typeof conversationMessages.$inferSelect;
