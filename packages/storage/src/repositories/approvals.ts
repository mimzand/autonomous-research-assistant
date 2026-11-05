import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { StorageError } from '../errors.js';
import { approvals, type ApprovalRecord } from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { JsonValueSchema, parseInput } from '../validation.js';

const RequestApprovalSchema = z.strictObject({
  stepId: z.string().min(1).optional(),
  /** Machine-readable action, e.g. "file.write". */
  action: z.string().trim().min(1).max(100),
  /** What the user is asked to approve, in plain words. */
  summary: z.string().trim().min(1).max(2000),
  payload: JsonValueSchema.optional(),
});
export type RequestApprovalInput = z.input<typeof RequestApprovalSchema>;

const DecisionSchema = z.strictObject({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().max(2000).optional(),
});
export type ApprovalDecision = z.input<typeof DecisionSchema>;

export function createApprovalRepository(db: Executor, ctx: StorageContext) {
  return {
    request(taskId: string, input: RequestApprovalInput): ApprovalRecord {
      const data = parseInput(RequestApprovalSchema, input, 'approval request');
      const now = ctx.now();
      return guarded('Request approval', () =>
        db
          .insert(approvals)
          .values({
            id: ctx.newId(),
            taskId,
            stepId: data.stepId ?? null,
            action: data.action,
            summary: data.summary,
            payload: data.payload ?? null,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get(),
      );
    },

    /** Records the user's decision. Only pending approvals can be decided, once. */
    decide(id: string, input: ApprovalDecision): ApprovalRecord {
      const data = parseInput(DecisionSchema, input, 'approval decision');
      const now = ctx.now();
      const updated = db
        .update(approvals)
        .set({ status: data.decision, reason: data.reason ?? null, decidedAt: now, updatedAt: now })
        .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
        .returning()
        .get();
      if (updated) return updated;
      const existing = db.select().from(approvals).where(eq(approvals.id, id)).get();
      if (!existing) throw new StorageError('not-found', `Approval ${id} not found.`);
      throw new StorageError(
        'invalid-transition',
        `Approval ${id} was already ${existing.status}; decisions cannot be changed.`,
      );
    },

    get(id: string): ApprovalRecord | undefined {
      return db.select().from(approvals).where(eq(approvals.id, id)).get();
    },

    listPending(taskId?: string): ApprovalRecord[] {
      return db
        .select()
        .from(approvals)
        .where(
          taskId === undefined
            ? eq(approvals.status, 'pending')
            : and(eq(approvals.status, 'pending'), eq(approvals.taskId, taskId)),
        )
        .orderBy(asc(approvals.createdAt))
        .all();
    },

    listByTask(taskId: string): ApprovalRecord[] {
      return db
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, taskId))
        .orderBy(asc(approvals.createdAt))
        .all();
    },
  };
}

export type ApprovalRepository = ReturnType<typeof createApprovalRepository>;
