import { ResearchTaskSchema, type ResearchTask } from '@rka/shared';
import { type TaskRepository } from './repository.js';

export interface InMemoryOptions {
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
}

/** Non-persistent implementation for tests and early development. */
export function createInMemoryTaskRepository(options: InMemoryOptions = {}): TaskRepository {
  const now = options.now ?? (() => new Date());
  const tasks = new Map<string, ResearchTask>();

  return {
    async create({ id, question }) {
      if (tasks.has(id)) throw new Error(`Task ${id} already exists.`);
      const timestamp = now().toISOString();
      const task = ResearchTaskSchema.parse({
        id,
        question,
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      tasks.set(id, task);
      return task;
    },

    async get(id) {
      return tasks.get(id);
    },

    async list() {
      return [...tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async updateStatus(id, status) {
      const existing = tasks.get(id);
      if (!existing) throw new Error(`Task ${id} not found.`);
      const updated: ResearchTask = { ...existing, status, updatedAt: now().toISOString() };
      tasks.set(id, updated);
      return updated;
    },
  };
}
