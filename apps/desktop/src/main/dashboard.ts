import { type AgentRuntime } from '@rka/agent-runtime';
import {
  BackupResultSchema,
  IntegrityCheckResultSchema,
  ReportDetailsSchema,
  ReportIdRequestSchema,
  ReportListQuerySchema,
  ReportListResultSchema,
  SourceDetailsSchema,
  SourceIdRequestSchema,
  SourceListQuerySchema,
  SourceListResultSchema,
  StorageStatusSchema,
  StartResearchRequestSchema,
  TaskActionResultSchema,
  TaskDetailsSchema,
  TaskIdRequestSchema,
  TaskListQuerySchema,
  TaskListResultSchema,
  TaskLogListSchema,
  TaskLogsRequestSchema,
  TaskStatusCountsSchema,
  type BackupResult,
  type IntegrityCheckResult,
  type ReportDetails,
  type ReportListResult,
  type SourceDetails,
  type SourceListResult,
  type StorageStatus,
  type TaskActionResult,
  type TaskDetails,
  type TaskListResult,
  type TaskLogList,
  type TaskStatusCounts,
} from '@rka/shared';
import { type Storage } from '@rka/storage';

export interface DashboardDeps {
  readonly storage: Storage;
  readonly runtime: AgentRuntime;
  /**
   * Asks the user where to save a backup. Must use a dialog that confirms
   * overwriting an existing file. Returns null when cancelled.
   */
  readonly chooseBackupPath: () => Promise<string | null>;
}

/**
 * Dashboard queries and actions for the renderer. Every request is parsed
 * with the shared Zod schema and every response is validated before it
 * leaves the main process. All data comes from SQLite via @rka/storage.
 */
export function createDashboardService({ storage, runtime, chooseBackupPath }: DashboardDeps) {
  const actionResult = (outcome: ReturnType<AgentRuntime['tasks']['resume']>): TaskActionResult =>
    TaskActionResultSchema.parse(
      outcome.ok
        ? { status: 'ok', taskId: outcome.task.id }
        : { status: 'rejected', message: outcome.message },
    );

  return {
    taskCounts(): TaskStatusCounts {
      return TaskStatusCountsSchema.parse(storage.inspect.taskStatusCounts());
    },

    listTasks(payload: unknown): TaskListResult {
      const query = TaskListQuerySchema.parse(payload ?? {});
      return TaskListResultSchema.parse(storage.inspect.listTasks(query));
    },

    getTask(payload: unknown): TaskDetails | null {
      const { id } = TaskIdRequestSchema.parse(payload);
      const details = storage.inspect.getTaskDetails(id);
      if (!details) return null;
      return TaskDetailsSchema.parse({
        ...details,
        recovery: runtime.tasks.recoveryInfo(details.task, details.steps),
        progress: runtime.tasks.progress(details.task, details.steps),
      });
    },

    runPersistenceCheck(): TaskActionResult {
      try {
        const task = runtime.tasks.runPersistenceCheck();
        return TaskActionResultSchema.parse({ status: 'ok', taskId: task.id });
      } catch (error) {
        return {
          status: 'rejected',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    /** Async: checks that Ollama and the model are ready before creating the task. */
    async startResearch(payload: unknown): Promise<TaskActionResult> {
      const request = StartResearchRequestSchema.parse(payload);
      return actionResult(
        await runtime.tasks.startResearch({
          goal: request.goal,
          limits: {
            ...(request.maxQuestions !== undefined && { maxQuestions: request.maxQuestions }),
            ...(request.maxSources !== undefined && { maxSources: request.maxSources }),
          },
        }),
      );
    },

    pauseTask(payload: unknown): TaskActionResult {
      return actionResult(runtime.tasks.pause(TaskIdRequestSchema.parse(payload).id));
    },

    resumeTask(payload: unknown): TaskActionResult {
      return actionResult(runtime.tasks.resume(TaskIdRequestSchema.parse(payload).id));
    },

    cancelTask(payload: unknown): TaskActionResult {
      return actionResult(runtime.tasks.cancel(TaskIdRequestSchema.parse(payload).id));
    },

    /** Runs the failed step(s) of a failed research task again (never completed ones). */
    retryTask(payload: unknown): TaskActionResult {
      return actionResult(runtime.tasks.retry(TaskIdRequestSchema.parse(payload).id));
    },

    /** Execution log of a task, oldest first; `afterSeq` fetches only newer entries. */
    taskLogs(payload: unknown): TaskLogList {
      const { id, afterSeq } = TaskLogsRequestSchema.parse(payload);
      const stepSeq = new Map(storage.steps.listByTask(id).map((s) => [s.id, s.seq]));
      const items = storage.logs.listByTask(id, { afterSeq, limit: 500 }).map((l) => ({
        seq: l.seq,
        level: l.level,
        event: l.event,
        message: l.message,
        stepSeq: l.stepId ? (stepSeq.get(l.stepId) ?? null) : null,
        data: l.data ?? null,
        createdAt: l.createdAt,
      }));
      return TaskLogListSchema.parse({ items, lastSeq: items.at(-1)?.seq ?? afterSeq });
    },

    listSources(payload: unknown): SourceListResult {
      const query = SourceListQuerySchema.parse(payload ?? {});
      return SourceListResultSchema.parse(storage.inspect.listSources(query));
    },

    getSource(payload: unknown): SourceDetails | null {
      const details = storage.inspect.getSource(SourceIdRequestSchema.parse(payload).id);
      return details ? SourceDetailsSchema.parse(details) : null;
    },

    listReports(payload: unknown): ReportListResult {
      const query = ReportListQuerySchema.parse(payload ?? {});
      return ReportListResultSchema.parse(storage.inspect.listReports(query));
    },

    getReport(payload: unknown): ReportDetails | null {
      const details = storage.inspect.getReport(ReportIdRequestSchema.parse(payload).id);
      return details ? ReportDetailsSchema.parse(details) : null;
    },

    /** Counts and metadata only: no setting values, so secrets are never exposed. */
    storageStatus(): StorageStatus {
      return StorageStatusSchema.parse(storage.inspect.status());
    },

    integrityCheck(): IntegrityCheckResult {
      return IntegrityCheckResultSchema.parse(storage.inspect.integrityCheck());
    },

    async backup(): Promise<BackupResult> {
      const target = await chooseBackupPath();
      if (!target) return { status: 'cancelled' };
      try {
        const result = await storage.inspect.backupTo(target);
        return BackupResultSchema.parse({ status: 'saved', ...result });
      } catch (error) {
        return {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export type DashboardService = ReturnType<typeof createDashboardService>;
