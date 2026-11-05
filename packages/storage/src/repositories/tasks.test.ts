import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../testing.js';

describe('tasks repository', () => {
  it('creates a task with input, timestamps and pending status', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({
      title: 'Heat pumps',
      input: { question: 'How efficient are heat pumps in cold climates?', depth: 2 },
    });
    expect(task).toEqual({
      id: 'id-0001',
      title: 'Heat pumps',
      input: { question: 'How efficient are heat pumps in cold climates?', depth: 2 },
      output: null,
      status: 'pending',
      error: null,
      startedAt: null,
      finishedAt: null,
      createdAt: expect.stringMatching(/^2026-11-04T10:00:\d{2}\.000Z$/),
      updatedAt: task.createdAt,
    });
    expect(storage.tasks.get(task.id)).toEqual(task);
  });

  it('reads, lists (newest first, filterable), renames and deletes', () => {
    const storage = memoryStorage();
    const a = storage.tasks.create({ title: 'A', input: {} });
    const b = storage.tasks.create({ title: 'B', input: {} });
    storage.tasks.start(b.id);

    expect(storage.tasks.list().map((t) => t.title)).toEqual(['B', 'A']);
    expect(storage.tasks.list({ status: ['running'] }).map((t) => t.title)).toEqual(['B']);
    expect(storage.tasks.list({ limit: 1 })).toHaveLength(1);

    const renamed = storage.tasks.rename(a.id, 'A2');
    expect(renamed.title).toBe('A2');
    expect(renamed.updatedAt > a.updatedAt).toBe(true);

    expect(storage.tasks.delete(a.id)).toBe(true);
    expect(storage.tasks.get(a.id)).toBeUndefined();
    expect(storage.tasks.delete(a.id)).toBe(false);
  });

  it('stores output on completion and lifecycle timestamps', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({ title: 'T', input: { question: 'q' } });
    const running = storage.tasks.start(task.id);
    expect(running.startedAt).not.toBeNull();
    expect(running.finishedAt).toBeNull();

    const done = storage.tasks.complete(task.id, { summary: 'Answer', sources: 3 });
    expect(done).toMatchObject({ status: 'completed', output: { summary: 'Answer', sources: 3 } });
    expect(done.finishedAt).not.toBeNull();
    expect(storage.tasks.require(task.id).output).toEqual({ summary: 'Answer', sources: 3 });
  });

  it('records errors on failure and clears them when running again', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({ title: 'T', input: {} });
    storage.tasks.start(task.id);
    storage.tasks.awaitApproval(task.id);
    storage.tasks.start(task.id);
    expect(storage.tasks.fail(task.id, 'Network down')).toMatchObject({
      status: 'failed',
      error: 'Network down',
    });
  });

  it('enforces valid status transitions', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({ title: 'T', input: {} });
    expect(() => storage.tasks.complete(task.id, {})).toThrow(
      expect.objectContaining({ code: 'invalid-transition' }),
    );
    storage.tasks.cancel(task.id);
    expect(() => storage.tasks.start(task.id)).toThrow(/cannot go from "cancelled"/);
  });

  it('validates input', () => {
    const storage = memoryStorage();
    expect(() => storage.tasks.create({ title: '  ', input: {} })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() =>
      storage.tasks.create({ title: 'T', input: { when: new Date() } as never }),
    ).toThrow(/Invalid task/);
    expect(() => storage.tasks.require('missing')).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });
});
