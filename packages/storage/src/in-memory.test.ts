import { TaskIdSchema } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { createInMemoryTaskRepository } from './in-memory.js';

const id = (value: string) => TaskIdSchema.parse(value);

describe('createInMemoryTaskRepository', () => {
  it('creates, reads and updates tasks', async () => {
    let tick = 0;
    const repo = createInMemoryTaskRepository({
      now: () => new Date(Date.UTC(2026, 10, 4, 10, 0, tick++)),
    });

    const created = await repo.create({ id: id('t1'), question: 'How do heat pumps work?' });
    expect(created).toMatchObject({ id: 't1', status: 'pending' });

    const updated = await repo.updateStatus(id('t1'), 'running');
    expect(updated.status).toBe('running');
    expect(updated.updatedAt > created.updatedAt).toBe(true);

    expect(await repo.get(id('t1'))).toEqual(updated);
    expect(await repo.list()).toHaveLength(1);
  });

  it('rejects duplicates, missing tasks and invalid questions', async () => {
    const repo = createInMemoryTaskRepository();
    await repo.create({ id: id('t1'), question: 'Q' });
    await expect(repo.create({ id: id('t1'), question: 'Q' })).rejects.toThrow(/exists/);
    await expect(repo.updateStatus(id('nope'), 'running')).rejects.toThrow(/not found/);
    await expect(repo.create({ id: id('t2'), question: '  ' })).rejects.toThrow();
  });
});
