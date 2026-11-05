import { z } from 'zod';

/**
 * Lifecycle of a research task. Persisted so tasks survive restarts.
 * `interrupted`: the app stopped while the task was running; it can be resumed.
 */
export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting-approval',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Lifecycle of one execution step. `completed` is final: completed steps never run again. */
export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'interrupted',
  'skipped',
]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const TaskIdSchema = z.string().min(1).brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;
