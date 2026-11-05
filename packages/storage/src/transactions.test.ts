import { describe, expect, it } from 'vitest';
import { memoryStorage } from './testing.js';

describe('transactions', () => {
  it('commits all writes together', () => {
    const storage = memoryStorage();
    const taskId = storage.transaction((repos) => {
      const task = repos.tasks.create({ title: 'T', input: {} });
      repos.steps.append(task.id, { kind: 'plan', name: 'Plan' });
      repos.steps.append(task.id, { kind: 'search', name: 'Search' });
      return task.id;
    });
    expect(storage.steps.listByTask(taskId)).toHaveLength(2);
  });

  it('rolls back every write if anything fails', () => {
    const storage = memoryStorage();
    expect(() =>
      storage.transaction((repos) => {
        const task = repos.tasks.create({ title: 'T', input: {} });
        repos.steps.append(task.id, { kind: 'plan', name: 'Plan' });
        repos.steps.append('missing-task', { kind: 'plan', name: 'Boom' }); // FK violation
      }),
    ).toThrow(expect.objectContaining({ code: 'not-found' }));
    expect(storage.tasks.list()).toEqual([]);
  });

  it('nested transactions roll back only the inner savepoint', () => {
    const storage = memoryStorage();
    storage.transaction((repos) => {
      repos.tasks.create({ title: 'Outer', input: {} });
      try {
        repos.transaction((inner) => {
          inner.tasks.create({ title: 'Inner', input: {} });
          throw new Error('inner failure');
        });
      } catch {
        // Handled: outer work continues.
      }
    });
    expect(storage.tasks.list().map((t) => t.title)).toEqual(['Outer']);
  });

  it('rejects async callbacks, which cannot be atomic with better-sqlite3', () => {
    const storage = memoryStorage();
    expect(() =>
      storage.transaction(async (repos) => {
        repos.tasks.create({ title: 'T', input: {} });
      }),
    ).toThrow(/must be synchronous/);
    expect(storage.tasks.list()).toEqual([]);
  });
});
