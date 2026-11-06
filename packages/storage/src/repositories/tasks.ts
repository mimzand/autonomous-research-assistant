import { type TaskStatus } from '@rka/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { redactText } from '@rka/shared';
import { StorageError } from '../errors.js';
import { tasks, type JsonValue, type TaskRecord } from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { IdSchema, JsonValueSchema, parseInput } from '../validation.js';

/** Allowed task status changes. Terminal states have none. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'awaiting-approval', 'interrupted'],
  'awaiting-approval': ['running', 'cancelled', 'failed'],
  interrupted: ['running', 'cancelled', 'failed'],
  completed: [],
  // Only an explicit user retry moves a failed task back to running.
  failed: ['running'],
  cancelled: [],
};

const TERMINAL: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

const CreateTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  /** What the user asked for (question, options...). */
  input: JsonValueSchema,
});
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;

const ListTasksSchema = z.strictObject({
  status: z
    .array(z.enum(Object.keys(TASK_TRANSITIONS) as [TaskStatus, ...TaskStatus[]]))
    .optional(),
  limit: z.int().min(1).max(500).default(50),
});

export function createTaskRepository(db: Executor, ctx: StorageContext) {
  function get(id: string): TaskRecord | undefined {
    return db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  function require(id: string): TaskRecord {
    const task = get(id);
    if (!task) throw new StorageError('not-found', `Task ${id} not found.`);
    return task;
  }

  function transition(
    id: string,
    to: TaskStatus,
    patch: { output?: JsonValue; error?: string | null } = {},
  ): TaskRecord {
    const current = require(id);
    if (!TASK_TRANSITIONS[current.status].includes(to)) {
      throw new StorageError(
        'invalid-transition',
        `Task ${id} cannot go from "${current.status}" to "${to}".`,
      );
    }
    const output =
      patch.output === undefined
        ? undefined
        : parseInput(JsonValueSchema, patch.output, 'task output');
    const now = ctx.now();
    const updated = db
      .update(tasks)
      .set({
        status: to,
        updatedAt: now,
        ...(output !== undefined && { output }),
        // Errors are shown and kept long-term: never store secrets or personal paths in them.
        ...(patch.error !== undefined && {
          error: patch.error === null ? null : redactText(patch.error),
        }),
        ...(to === 'running' && { error: null, finishedAt: null }),
        ...(to === 'running' && !current.startedAt && { startedAt: now }),
        ...(TERMINAL.includes(to) && { finishedAt: now }),
      })
      // Compare-and-set: fails if another writer changed the status meanwhile.
      .where(and(eq(tasks.id, id), eq(tasks.status, current.status)))
      .returning()
      .get();
    if (!updated) {
      throw new StorageError('conflict', `Task ${id} changed while updating; retry.`);
    }
    return updated;
  }

  return {
    create(input: CreateTaskInput): TaskRecord {
      const data = parseInput(CreateTaskSchema, input, 'task');
      const now = ctx.now();
      return guarded('Create task', () =>
        db
          .insert(tasks)
          .values({
            id: ctx.newId(),
            title: data.title,
            input: data.input,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get(),
      );
    },

    get(id: string): TaskRecord | undefined {
      return get(parseInput(IdSchema, id, 'task id'));
    },

    require,

    /** Newest first. */
    list(options: z.input<typeof ListTasksSchema> = {}): TaskRecord[] {
      const { status, limit } = parseInput(ListTasksSchema, options, 'task list options');
      return db
        .select()
        .from(tasks)
        .where(status?.length ? inArray(tasks.status, status) : undefined)
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(limit)
        .all();
    },

    rename(id: string, title: string): TaskRecord {
      const value = parseInput(CreateTaskSchema.shape.title, title, 'task title');
      const updated = db
        .update(tasks)
        .set({ title: value, updatedAt: ctx.now() })
        .where(eq(tasks.id, id))
        .returning()
        .get();
      if (!updated) throw new StorageError('not-found', `Task ${id} not found.`);
      return updated;
    },

    transition,
    start: (id: string) => transition(id, 'running'),
    complete: (id: string, output: JsonValue) => transition(id, 'completed', { output }),
    fail: (id: string, error: string) => transition(id, 'failed', { error }),
    cancel: (id: string) => transition(id, 'cancelled'),
    awaitApproval: (id: string) => transition(id, 'awaiting-approval'),

    /** Deletes the task and (cascade) its steps, sources, reports and approvals. */
    delete(id: string): boolean {
      return db.delete(tasks).where(eq(tasks.id, id)).run().changes > 0;
    },
  };
}

export type TaskRepository = ReturnType<typeof createTaskRepository>;
