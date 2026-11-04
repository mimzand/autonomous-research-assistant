import { z } from 'zod';

/** Lifecycle of a research task. Persisted so tasks can be resumed after a restart. */
export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting-approval',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskIdSchema = z.string().min(1).brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const ResearchTaskSchema = z.object({
  id: TaskIdSchema,
  question: z.string().trim().min(1).max(4000),
  status: TaskStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ResearchTask = z.infer<typeof ResearchTaskSchema>;
