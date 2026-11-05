import { z } from 'zod';
import { StepStatusSchema, TaskStatusSchema } from './domain.js';

/*
 * Read-only dashboard contract. Storage uses the query schemas, main
 * validates requests and responses, the preload validates responses again.
 */

const Timestamp = z.iso.datetime();
const NullableTimestamp = Timestamp.nullable();
const Json = z.json();
const Id = z.string().min(1).max(100);
const Search = z.string().trim().max(200).optional();
const Limit = z.int().min(1).max(200).default(50);
const Offset = z.int().min(0).max(1_000_000).default(0);

// --- Tasks ------------------------------------------------------------------

export const TaskListQuerySchema = z.strictObject({
  status: z.array(TaskStatusSchema).max(7).optional(),
  search: Search,
  limit: Limit,
  offset: Offset,
});
export type TaskListQuery = z.input<typeof TaskListQuerySchema>;

export const TaskSummarySchema = z.object({
  id: Id,
  title: z.string(),
  /** Short text form of the input (e.g. the question). */
  inputPreview: z.string(),
  status: TaskStatusSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
  stepCount: z.int().nonnegative(),
  completedStepCount: z.int().nonnegative(),
  sourceCount: z.int().nonnegative(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskListResultSchema = z.object({
  items: z.array(TaskSummarySchema),
  total: z.int().nonnegative(),
});
export type TaskListResult = z.infer<typeof TaskListResultSchema>;

export const TaskStatusCountsSchema = z.object({
  total: z.int().nonnegative(),
  byStatus: z.record(TaskStatusSchema, z.int().nonnegative()),
});
export type TaskStatusCounts = z.infer<typeof TaskStatusCountsSchema>;

export const TaskViewSchema = z.object({
  id: Id,
  title: z.string(),
  input: Json,
  output: Json.nullable(),
  status: TaskStatusSchema,
  error: z.string().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const TaskStepViewSchema = z.object({
  id: Id,
  seq: z.int().positive(),
  kind: z.string(),
  name: z.string(),
  status: StepStatusSchema,
  input: Json.nullable(),
  output: Json.nullable(),
  error: z.string().nullable(),
  attempts: z.int().nonnegative(),
  startedAt: NullableTimestamp,
  finishedAt: NullableTimestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TaskStepView = z.infer<typeof TaskStepViewSchema>;

export const ModelUsageTotalSchema = z.object({
  provider: z.string(),
  model: z.string(),
  calls: z.int().nonnegative(),
  promptTokens: z.int().nonnegative(),
  completionTokens: z.int().nonnegative(),
});

export const TaskRecoveryInfoSchema = z.object({
  /** True only if the task is interrupted AND an executor exists to continue it. */
  resumable: z.boolean(),
  /** Why it cannot be resumed (null when resumable or not applicable). */
  reason: z.string().nullable(),
  /** Interrupted because the user paused it (not a crash). */
  paused: z.boolean(),
  /** A running research task that can be paused now. */
  pausable: z.boolean(),
  cancellable: z.boolean(),
  completedSteps: z.int().nonnegative(),
  totalSteps: z.int().nonnegative(),
  nextStep: z.object({ seq: z.int().positive(), name: z.string() }).nullable(),
});
export type TaskRecoveryInfo = z.infer<typeof TaskRecoveryInfoSchema>;

export const TaskProgressSchema = z.object({
  completed: z.int().nonnegative(),
  total: z.int().nonnegative(),
  /** The total grows once sources are chosen. */
  estimated: z.boolean(),
  current: z.object({ seq: z.int().positive(), name: z.string(), kind: z.string() }).nullable(),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

export const TaskDetailsSchema = z.object({
  task: TaskViewSchema,
  /** Step progress for research tasks; null for other task types. */
  progress: TaskProgressSchema.nullable(),
  steps: z.array(TaskStepViewSchema),
  sourceCount: z.int().nonnegative(),
  reportCount: z.int().nonnegative(),
  pendingApprovalCount: z.int().nonnegative(),
  usage: z.array(ModelUsageTotalSchema),
  recovery: TaskRecoveryInfoSchema,
});
export type TaskDetails = z.infer<typeof TaskDetailsSchema>;

export const TaskIdRequestSchema = z.strictObject({ id: Id });

/** Starts an autonomous research task (validated again by the runtime). */
export const StartResearchRequestSchema = z.strictObject({
  goal: z.string().trim().min(10).max(2000),
  maxQuestions: z.int().min(1).max(6).optional(),
  maxSources: z.int().min(1).max(12).optional(),
});
export type StartResearchRequest = z.input<typeof StartResearchRequestSchema>;

/** Pushed to the window while research tasks run (the UI also polls). */
export const ResearchProgressEventSchema = z.object({
  type: z.enum(['task', 'step-started', 'step-completed', 'step-failed', 'source']),
  taskId: Id,
  taskStatus: TaskStatusSchema,
  progress: TaskProgressSchema,
  message: z.string().max(500).optional(),
});
export type ResearchProgressEvent = z.infer<typeof ResearchProgressEventSchema>;

export const TaskActionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), taskId: Id }),
  z.object({ status: z.literal('rejected'), message: z.string() }),
]);
export type TaskActionResult = z.infer<typeof TaskActionResultSchema>;

// --- Knowledge base -----------------------------------------------------------

export const SourceListQuerySchema = z.strictObject({
  taskId: Id.optional(),
  search: Search,
  content: z.enum(['all', 'extracted', 'missing']).default('all'),
  limit: Limit,
  offset: Offset,
});
export type SourceListQuery = z.input<typeof SourceListQuerySchema>;

export const SourceSummarySchema = z.object({
  id: Id,
  taskId: Id,
  taskTitle: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  retrievedAt: NullableTimestamp,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  hasContent: z.boolean(),
  contentType: z.string().nullable(),
  byteLength: z.int().nonnegative().nullable(),
  sha256: z.string().nullable(),
});
export type SourceSummary = z.infer<typeof SourceSummarySchema>;

export const SourceListResultSchema = z.object({
  items: z.array(SourceSummarySchema),
  total: z.int().nonnegative(),
  /** Totals across all sources (ignores filters). */
  totals: z.object({
    sources: z.int().nonnegative(),
    withContent: z.int().nonnegative(),
    contentBytes: z.int().nonnegative(),
    tasksWithSources: z.int().nonnegative(),
  }),
});
export type SourceListResult = z.infer<typeof SourceListResultSchema>;

export const SourceDetailsSchema = z.object({
  source: SourceSummarySchema.extend({ metadata: Json.nullable() }),
  /** Extracted text (untrusted data), or null if not extracted yet. */
  content: z
    .object({
      contentType: z.string(),
      text: z.string(),
      byteLength: z.int().nonnegative(),
      sha256: z.string(),
      createdAt: Timestamp,
      updatedAt: Timestamp,
    })
    .nullable(),
});
export type SourceDetails = z.infer<typeof SourceDetailsSchema>;

export const SourceIdRequestSchema = z.strictObject({ id: Id });

// --- Reports -------------------------------------------------------------------

export const ReportListQuerySchema = z.strictObject({
  taskId: Id.optional(),
  search: Search,
  limit: Limit,
  offset: Offset,
});
export type ReportListQuery = z.input<typeof ReportListQuerySchema>;

export const ReportSummarySchema = z.object({
  id: Id,
  taskId: Id,
  taskTitle: z.string(),
  title: z.string(),
  version: z.int().positive(),
  format: z.literal('markdown'),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  citedCount: z.int().nonnegative(),
  contentLength: z.int().nonnegative(),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

export const ReportListResultSchema = z.object({
  items: z.array(ReportSummarySchema),
  total: z.int().nonnegative(),
});
export type ReportListResult = z.infer<typeof ReportListResultSchema>;

export const ReportDetailsSchema = z.object({
  report: ReportSummarySchema.extend({ content: z.string() }),
  citedSources: z.array(z.object({ id: Id, url: z.string(), title: z.string().nullable() })),
});
export type ReportDetails = z.infer<typeof ReportDetailsSchema>;

export const ReportIdRequestSchema = z.strictObject({ id: Id });

// --- Storage -------------------------------------------------------------------

export const IntegrityCheckResultSchema = z.object({
  ok: z.boolean(),
  /** "ok", or the problems SQLite reported (capped). */
  messages: z.array(z.string()),
  checkedAt: Timestamp,
  durationMs: z.int().nonnegative(),
});
export type IntegrityCheckResult = z.infer<typeof IntegrityCheckResultSchema>;

export const StorageStatusSchema = z.object({
  connected: z.boolean(),
  path: z.string(),
  files: z.object({
    databaseBytes: z.int().nonnegative(),
    walBytes: z.int().nonnegative(),
    shmBytes: z.int().nonnegative(),
  }),
  sqliteVersion: z.string(),
  journalMode: z.string(),
  foreignKeys: z.boolean(),
  pageSize: z.int().nonnegative(),
  pageCount: z.int().nonnegative(),
  freePages: z.int().nonnegative(),
  migrations: z.array(z.object({ tag: z.string(), appliedAt: Timestamp })),
  tables: z.array(z.object({ name: z.string(), rows: z.int().nonnegative() })),
  lastIntegrityCheck: IntegrityCheckResultSchema.nullable(),
  lastSuccessfulIntegrityCheckAt: NullableTimestamp,
});
export type StorageStatus = z.infer<typeof StorageStatusSchema>;

export const BackupResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    path: z.string(),
    bytes: z.int().nonnegative(),
    verified: z.boolean(),
  }),
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('failed'), message: z.string() }),
]);
export type BackupResult = z.infer<typeof BackupResultSchema>;
