import { and, eq, inArray } from 'drizzle-orm';
import { type Executor, type StorageContext } from './context.js';
import { StorageError } from './errors.js';
import { createApprovalRepository } from './repositories/approvals.js';
import { createTaskLogRepository } from './repositories/task-logs.js';
import { createTaskStepRepository } from './repositories/task-steps.js';
import { createTaskRepository } from './repositories/tasks.js';
import {
  taskSteps,
  tasks,
  type ApprovalRecord,
  type TaskRecord,
  type TaskStepRecord,
} from './schema.js';

export const INTERRUPTED_MESSAGE = 'The application stopped while this task was running.';

export interface RecoveryReport {
  /** Tasks that were running and are now `interrupted`. */
  readonly interruptedTaskIds: readonly string[];
  /** Steps that were running and are now `interrupted`. */
  readonly interruptedStepCount: number;
}

/**
 * Everything needed to continue a task without redoing finished work.
 * `completedSteps` carry their outputs; execution continues at `nextStep`.
 */
export interface ResumePlan {
  readonly task: TaskRecord;
  readonly completedSteps: readonly TaskStepRecord[];
  readonly remainingSteps: readonly TaskStepRecord[];
  readonly nextStep: TaskStepRecord | null;
  readonly pendingApprovals: readonly ApprovalRecord[];
}

export function createRecovery(
  db: Executor,
  ctx: StorageContext,
  transaction: <T>(fn: (tx: Executor) => T) => T,
) {
  return {
    /**
     * Call once at startup, before any task runs. Marks tasks and steps that
     * were `running` when the app stopped as `interrupted` (atomically).
     * Nothing is re-executed here; resuming is an explicit decision.
     */
    recoverInterruptedTasks(): RecoveryReport {
      return transaction((tx) => {
        const now = ctx.now();
        const interrupted = tx
          .update(tasks)
          .set({ status: 'interrupted', error: INTERRUPTED_MESSAGE, updatedAt: now })
          .where(eq(tasks.status, 'running'))
          .returning({ id: tasks.id })
          .all();
        const steps = tx
          .update(taskSteps)
          .set({
            status: 'interrupted',
            error: INTERRUPTED_MESSAGE,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(taskSteps.status, 'running'))
          .run();
        const logs = createTaskLogRepository(tx, ctx);
        for (const { id } of interrupted) {
          logs.append(id, {
            level: 'warn',
            event: 'task.recovered',
            message: `${INTERRUPTED_MESSAGE} Marked as interrupted at startup; it continues only when resumed.`,
          });
        }
        return {
          interruptedTaskIds: interrupted.map((t) => t.id),
          interruptedStepCount: steps.changes,
        };
      });
    },

    /** Tasks waiting for the user to resume or cancel them. */
    listResumable(): TaskRecord[] {
      return db
        .select()
        .from(tasks)
        .where(inArray(tasks.status, ['interrupted', 'awaiting-approval']))
        .all();
    },

    getResumePlan(taskId: string): ResumePlan {
      const task = createTaskRepository(db, ctx).require(taskId);
      const steps = createTaskStepRepository(db, ctx).listByTask(taskId);
      const completedSteps = steps.filter(
        (s) => s.status === 'completed' || s.status === 'skipped',
      );
      const remainingSteps = steps.filter(
        (s) => s.status !== 'completed' && s.status !== 'skipped',
      );
      return {
        task,
        completedSteps,
        remainingSteps,
        nextStep: remainingSteps[0] ?? null,
        pendingApprovals: createApprovalRepository(db, ctx).listPending(taskId),
      };
    },

    /**
     * Moves an interrupted task back to `running` and returns where to
     * continue. Completed steps stay completed and cannot be started again.
     */
    resume(taskId: string): ResumePlan {
      return transaction((tx) => {
        const taskRepo = createTaskRepository(tx, ctx);
        const task = taskRepo.require(taskId);
        if (task.status !== 'interrupted') {
          throw new StorageError(
            'invalid-transition',
            `Only interrupted tasks can be resumed (task is "${task.status}").`,
          );
        }
        taskRepo.transition(taskId, 'running');
        return createRecovery(tx, ctx, (fn) => fn(tx)).getResumePlan(taskId);
      });
    },

    /** Running steps of a task (should be empty after recovery). */
    runningSteps(taskId: string): TaskStepRecord[] {
      return db
        .select()
        .from(taskSteps)
        .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.status, 'running')))
        .all();
    },
  };
}

export type Recovery = ReturnType<typeof createRecovery>;
