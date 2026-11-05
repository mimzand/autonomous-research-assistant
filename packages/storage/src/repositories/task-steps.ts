import { type StepStatus } from '@rka/shared';
import { and, asc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { StorageError } from '../errors.js';
import { taskSteps, type JsonValue, type TaskStepRecord } from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { IdSchema, JsonValueSchema, parseInput } from '../validation.js';

/**
 * Allowed step status changes. `completed` and `skipped` are final:
 * a completed step is never executed again (recovery relies on this).
 */
export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ['running', 'skipped'],
  running: ['completed', 'failed', 'interrupted'],
  failed: ['running'],
  interrupted: ['running', 'skipped'],
  completed: [],
  skipped: [],
};

const AppendStepSchema = z.strictObject({
  /** Category, e.g. plan, search, fetch, analyze, write. */
  kind: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(500),
  input: JsonValueSchema.optional(),
});
export type AppendStepInput = z.input<typeof AppendStepSchema>;

export function createTaskStepRepository(db: Executor, ctx: StorageContext) {
  function require(id: string): TaskStepRecord {
    const step = db.select().from(taskSteps).where(eq(taskSteps.id, id)).get();
    if (!step) throw new StorageError('not-found', `Step ${id} not found.`);
    return step;
  }

  function transition(
    id: string,
    to: StepStatus,
    patch: Partial<Pick<TaskStepRecord, 'output' | 'error'>> = {},
  ): TaskStepRecord {
    const current = require(id);
    if (current.status === 'completed' && to === 'running') {
      throw new StorageError(
        'step-already-completed',
        `Step ${current.seq} ("${current.name}") already completed; it must not run again.`,
      );
    }
    if (!STEP_TRANSITIONS[current.status].includes(to)) {
      throw new StorageError(
        'invalid-transition',
        `Step ${id} cannot go from "${current.status}" to "${to}".`,
      );
    }
    const now = ctx.now();
    const updated = db
      .update(taskSteps)
      .set({
        status: to,
        updatedAt: now,
        ...patch,
        ...(to === 'running' && {
          attempts: current.attempts + 1,
          startedAt: now,
          finishedAt: null,
          error: null,
        }),
        ...(['completed', 'failed', 'skipped', 'interrupted'].includes(to) && { finishedAt: now }),
      })
      .where(and(eq(taskSteps.id, id), eq(taskSteps.status, current.status)))
      .returning()
      .get();
    if (!updated) throw new StorageError('conflict', `Step ${id} changed while updating; retry.`);
    return updated;
  }

  return {
    /** Adds the next step (seq = last + 1) in `pending` state. */
    append(taskId: string, input: AppendStepInput): TaskStepRecord {
      const data = parseInput(AppendStepSchema, input, 'step');
      const last = db
        .select({ seq: max(taskSteps.seq) })
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .get();
      const now = ctx.now();
      return guarded('Append step', () =>
        db
          .insert(taskSteps)
          .values({
            id: ctx.newId(),
            taskId: parseInput(IdSchema, taskId, 'task id'),
            seq: (last?.seq ?? 0) + 1,
            kind: data.kind,
            name: data.name,
            input: data.input ?? null,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get(),
      );
    },

    get(id: string): TaskStepRecord | undefined {
      return db.select().from(taskSteps).where(eq(taskSteps.id, id)).get();
    },

    require,

    /** In execution order. */
    listByTask(taskId: string): TaskStepRecord[] {
      return db
        .select()
        .from(taskSteps)
        .where(eq(taskSteps.taskId, taskId))
        .orderBy(asc(taskSteps.seq))
        .all();
    },

    /** pending | failed | interrupted → running. Throws `step-already-completed` for completed steps. */
    start: (id: string) => transition(id, 'running'),

    complete(id: string, output: JsonValue): TaskStepRecord {
      return transition(id, 'completed', {
        output: parseInput(JsonValueSchema, output, 'step output'),
      });
    },

    fail(id: string, error: string): TaskStepRecord {
      return transition(id, 'failed', { error: error.slice(0, 10_000) });
    },

    skip: (id: string) => transition(id, 'skipped'),

    /** running → interrupted (e.g. the user paused the task). The step runs again on resume. */
    interrupt(id: string, reason: string): TaskStepRecord {
      return transition(id, 'interrupted', { error: reason.slice(0, 10_000) });
    },
  };
}

export type TaskStepRepository = ReturnType<typeof createTaskStepRepository>;
