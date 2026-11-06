import { and, asc, eq, gt, inArray, max } from 'drizzle-orm';
import { redactText, redactValue } from '@rka/shared';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { LOG_LEVELS, taskLogs, type TaskLogRecord } from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { JsonValueSchema, parseInput } from '../validation.js';

/** Largest JSON payload kept with one log entry (keeps the table small). */
export const MAX_LOG_DATA_CHARS = 4000;

const AppendLogSchema = z.strictObject({
  stepId: z.string().min(1).nullable().optional(),
  level: z.enum(LOG_LEVELS),
  event: z.string().regex(/^[a-z][a-z0-9.-]{0,59}$/, 'Use a dotted lower-case event name.'),
  message: z.string().trim().min(1).max(2000),
  data: JsonValueSchema.refine((v) => JSON.stringify(v).length <= MAX_LOG_DATA_CHARS, {
    message: `Log data exceeds ${MAX_LOG_DATA_CHARS} characters.`,
  }).optional(),
});
export type AppendLogInput = z.input<typeof AppendLogSchema>;

const ListLogsSchema = z.strictObject({
  /** Only entries after this sequence number (for incremental polling). */
  afterSeq: z.int().min(0).default(0),
  limit: z.int().min(1).max(2000).default(500),
  levels: z.array(z.enum(LOG_LEVELS)).max(4).optional(),
});
export type ListLogsInput = z.input<typeof ListLogsSchema>;

/** Append-only execution log per task, ordered by `seq`. */
export function createTaskLogRepository(db: Executor, ctx: StorageContext) {
  return {
    append(taskId: string, input: AppendLogInput): TaskLogRecord {
      const data = parseInput(AppendLogSchema, input, 'log entry');
      const now = ctx.now();
      return guarded('Append log entry', () => {
        const last = db
          .select({ seq: max(taskLogs.seq) })
          .from(taskLogs)
          .where(eq(taskLogs.taskId, taskId))
          .get();
        return db
          .insert(taskLogs)
          .values({
            id: ctx.newId(),
            taskId,
            stepId: data.stepId ?? null,
            seq: (last?.seq ?? 0) + 1,
            level: data.level,
            event: data.event,
            // The log can be exported or shown in bug reports: strip secrets and personal details.
            message: redactText(data.message),
            data: data.data === undefined ? null : redactValue(data.data),
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
      });
    },

    listByTask(taskId: string, options: ListLogsInput = {}): TaskLogRecord[] {
      const query = parseInput(ListLogsSchema, options, 'log query');
      return db
        .select()
        .from(taskLogs)
        .where(
          and(
            eq(taskLogs.taskId, taskId),
            gt(taskLogs.seq, query.afterSeq),
            query.levels ? inArray(taskLogs.level, query.levels) : undefined,
          ),
        )
        .orderBy(asc(taskLogs.seq))
        .limit(query.limit)
        .all();
    },
  };
}

export type TaskLogRepository = ReturnType<typeof createTaskLogRepository>;
