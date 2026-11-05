import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../testing.js';

function setup() {
  const storage = memoryStorage();
  const task = storage.tasks.create({ title: 'T', input: { question: 'q' } });
  return { storage, task };
}

describe('task steps repository', () => {
  it('appends steps in order with input', () => {
    const { storage, task } = setup();
    const plan = storage.steps.append(task.id, {
      kind: 'plan',
      name: 'Plan research',
      input: { q: 'q' },
    });
    const search = storage.steps.append(task.id, { kind: 'search', name: 'Search the web' });
    expect(plan).toMatchObject({ seq: 1, status: 'pending', attempts: 0, input: { q: 'q' } });
    expect(search).toMatchObject({ seq: 2, input: null });
    expect(storage.steps.listByTask(task.id).map((s) => s.name)).toEqual([
      'Plan research',
      'Search the web',
    ]);
  });

  it('runs a step: start → complete stores output', () => {
    const { storage, task } = setup();
    const step = storage.steps.append(task.id, { kind: 'plan', name: 'Plan' });
    const running = storage.steps.start(step.id);
    expect(running).toMatchObject({ status: 'running', attempts: 1 });
    expect(running.startedAt).not.toBeNull();

    const done = storage.steps.complete(step.id, { subquestions: ['a', 'b'] });
    expect(done).toMatchObject({ status: 'completed', output: { subquestions: ['a', 'b'] } });
    expect(done.finishedAt).not.toBeNull();
  });

  it('never starts a completed step again', () => {
    const { storage, task } = setup();
    const step = storage.steps.append(task.id, { kind: 'plan', name: 'Plan' });
    storage.steps.start(step.id);
    storage.steps.complete(step.id, 'ok');
    expect(() => storage.steps.start(step.id)).toThrow(
      expect.objectContaining({ code: 'step-already-completed' }),
    );
    expect(storage.steps.require(step.id)).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('retries failed steps and counts attempts', () => {
    const { storage, task } = setup();
    const step = storage.steps.append(task.id, { kind: 'fetch', name: 'Fetch' });
    storage.steps.start(step.id);
    expect(storage.steps.fail(step.id, 'timeout')).toMatchObject({
      status: 'failed',
      error: 'timeout',
    });
    const retry = storage.steps.start(step.id);
    expect(retry).toMatchObject({ status: 'running', attempts: 2, error: null });
  });

  it('skips pending steps and rejects invalid transitions', () => {
    const { storage, task } = setup();
    const step = storage.steps.append(task.id, { kind: 'fetch', name: 'Fetch' });
    expect(() => storage.steps.complete(step.id, 'x')).toThrow(
      expect.objectContaining({ code: 'invalid-transition' }),
    );
    expect(storage.steps.skip(step.id).status).toBe('skipped');
    expect(() => storage.steps.start(step.id)).toThrow(/cannot go from "skipped"/);
  });

  it('rejects steps for unknown tasks and is deleted with its task', () => {
    const { storage, task } = setup();
    expect(() => storage.steps.append('nope', { kind: 'plan', name: 'x' })).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    storage.steps.append(task.id, { kind: 'plan', name: 'x' });
    storage.tasks.delete(task.id);
    expect(storage.steps.listByTask(task.id)).toEqual([]);
  });

  it('interrupts a running step so it can run again (pause)', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({ title: 'T', input: {} });
    const step = storage.steps.append(task.id, { kind: 'k', name: 'n' });
    storage.steps.start(step.id);
    expect(storage.steps.interrupt(step.id, 'Paused')).toMatchObject({
      status: 'interrupted',
      error: 'Paused',
    });
    expect(storage.steps.start(step.id)).toMatchObject({ status: 'running', attempts: 2 });
    storage.steps.complete(step.id, null);
    expect(() => storage.steps.interrupt(step.id, 'x')).toThrow();
  });
});
