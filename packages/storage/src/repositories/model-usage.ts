import { asc, count, desc, eq, sum } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { modelUsage, type ModelUsageRecord } from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { parseInput } from '../validation.js';

const tokens = z.int().nonnegative().nullable().optional();

const RecordUsageSchema = z.strictObject({
  taskId: z.string().min(1).nullable().optional(),
  stepId: z.string().min(1).nullable().optional(),
  provider: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(200),
  /** Why the model was called, e.g. "chat", "plan", "summarize". */
  purpose: z.string().trim().min(1).max(50),
  promptTokens: tokens,
  completionTokens: tokens,
  totalDurationMs: tokens,
  loadDurationMs: tokens,
});
export type RecordUsageInput = z.input<typeof RecordUsageSchema>;

export interface UsageTotals {
  readonly provider: string;
  readonly model: string;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export function createModelUsageRepository(db: Executor, ctx: StorageContext) {
  return {
    record(input: RecordUsageInput): ModelUsageRecord {
      const data = parseInput(RecordUsageSchema, input, 'model usage');
      const now = ctx.now();
      return guarded('Record model usage', () =>
        db
          .insert(modelUsage)
          .values({
            id: ctx.newId(),
            taskId: data.taskId ?? null,
            stepId: data.stepId ?? null,
            provider: data.provider,
            model: data.model,
            purpose: data.purpose,
            promptTokens: data.promptTokens ?? null,
            completionTokens: data.completionTokens ?? null,
            totalDurationMs: data.totalDurationMs ?? null,
            loadDurationMs: data.loadDurationMs ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get(),
      );
    },

    listByTask(taskId: string): ModelUsageRecord[] {
      return db
        .select()
        .from(modelUsage)
        .where(eq(modelUsage.taskId, taskId))
        .orderBy(asc(modelUsage.createdAt))
        .all();
    },

    listRecent(limit = 50): ModelUsageRecord[] {
      return db.select().from(modelUsage).orderBy(desc(modelUsage.createdAt)).limit(limit).all();
    },

    /** Token totals per provider/model, optionally for one task. Unknown counts add as 0. */
    totals(taskId?: string): UsageTotals[] {
      return db
        .select({
          provider: modelUsage.provider,
          model: modelUsage.model,
          calls: count(),
          promptTokens: sum(modelUsage.promptTokens).mapWith(Number),
          completionTokens: sum(modelUsage.completionTokens).mapWith(Number),
        })
        .from(modelUsage)
        .where(taskId === undefined ? undefined : eq(modelUsage.taskId, taskId))
        .groupBy(modelUsage.provider, modelUsage.model)
        .orderBy(asc(modelUsage.model))
        .all()
        .map((row) => ({
          ...row,
          promptTokens: row.promptTokens || 0,
          completionTokens: row.completionTokens || 0,
        }));
    },
  };
}

export type ModelUsageRepository = ReturnType<typeof createModelUsageRepository>;
