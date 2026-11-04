import { type ResearchTask, type TaskId, type TaskStatus } from '@rka/shared';

/**
 * Persistence contract for research tasks. The agent runtime depends only
 * on this interface; the SQLite/Drizzle implementation will satisfy it.
 */
export interface TaskRepository {
  create(input: { readonly id: TaskId; readonly question: string }): Promise<ResearchTask>;
  get(id: TaskId): Promise<ResearchTask | undefined>;
  list(): Promise<readonly ResearchTask[]>;
  updateStatus(id: TaskId, status: TaskStatus): Promise<ResearchTask>;
}
