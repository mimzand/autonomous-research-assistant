import { afterEach, describe, expect, it } from 'vitest';
import { INTERRUPTED_MESSAGE } from './recovery.js';
import { openStorage, type Storage } from './storage.js';
import { tempDir } from './testing.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

/** A task mid-run: step 1 done, step 2 running, step 3 not started. */
function seedRunningTask(storage: Storage) {
  const task = storage.tasks.create({ title: 'Heat pumps', input: { question: 'q' } });
  storage.tasks.start(task.id);
  const s1 = storage.steps.append(task.id, { kind: 'plan', name: 'Plan' });
  const s2 = storage.steps.append(task.id, { kind: 'search', name: 'Search' });
  const s3 = storage.steps.append(task.id, { kind: 'write', name: 'Write report' });
  storage.steps.start(s1.id);
  storage.steps.complete(s1.id, { subquestions: ['a', 'b'] });
  storage.steps.start(s2.id);
  return { task, s1, s2, s3 };
}

function fileStorage() {
  const { dbPath, cleanup } = tempDir();
  const opened: Storage[] = [];
  cleanups.push(() => {
    opened.forEach((s) => s.close());
    cleanup();
  });
  return () => {
    const storage = openStorage({ path: dbPath });
    opened.push(storage);
    return storage;
  };
}

describe('recovery after an unexpected restart', () => {
  it('marks running tasks and steps as interrupted, keeping completed work', () => {
    const open = fileStorage();
    const before = open();
    const { task, s1, s2, s3 } = seedRunningTask(before);
    before.close(); // The app stops while the task is running.

    const after = open();
    const report = after.recovery.recoverInterruptedTasks();
    expect(report).toEqual({ interruptedTaskIds: [task.id], interruptedStepCount: 1 });

    expect(after.tasks.require(task.id)).toMatchObject({
      status: 'interrupted',
      error: INTERRUPTED_MESSAGE,
    });
    const steps = after.steps.listByTask(task.id);
    expect(steps.map((s) => [s.id, s.status])).toEqual([
      [s1.id, 'completed'],
      [s2.id, 'interrupted'],
      [s3.id, 'pending'],
    ]);
    expect(steps[0]?.output).toEqual({ subquestions: ['a', 'b'] });
    expect(after.recovery.listResumable().map((t) => t.id)).toEqual([task.id]);
  });

  it('does not touch tasks that were not running', () => {
    const open = fileStorage();
    const storage = open();
    const pending = storage.tasks.create({ title: 'Pending', input: {} });
    const waiting = storage.tasks.create({ title: 'Waiting', input: {} });
    storage.tasks.start(waiting.id);
    storage.tasks.awaitApproval(waiting.id);
    const done = storage.tasks.create({ title: 'Done', input: {} });
    storage.tasks.start(done.id);
    storage.tasks.complete(done.id, 'ok');

    expect(storage.recovery.recoverInterruptedTasks()).toEqual({
      interruptedTaskIds: [],
      interruptedStepCount: 0,
    });
    expect(storage.tasks.require(pending.id).status).toBe('pending');
    expect(storage.tasks.require(waiting.id).status).toBe('awaiting-approval');
    expect(storage.tasks.require(done.id).status).toBe('completed');
    expect(storage.recovery.listResumable().map((t) => t.title)).toEqual(['Waiting']);
  });

  it('resumes from the next unfinished step without re-running completed ones', () => {
    const open = fileStorage();
    const before = open();
    const { task, s1, s2, s3 } = seedRunningTask(before);
    before.close();

    const after = open();
    after.recovery.recoverInterruptedTasks();
    const plan = after.recovery.resume(task.id);

    expect(plan.task.status).toBe('running');
    expect(plan.completedSteps.map((s) => s.id)).toEqual([s1.id]);
    expect(plan.completedSteps[0]?.output).toEqual({ subquestions: ['a', 'b'] });
    expect(plan.remainingSteps.map((s) => s.id)).toEqual([s2.id, s3.id]);
    expect(plan.nextStep?.id).toBe(s2.id);

    // A completed step can never be executed again...
    expect(() => after.steps.start(s1.id)).toThrow(
      expect.objectContaining({ code: 'step-already-completed' }),
    );
    // ...while the interrupted one is retried (second attempt).
    expect(after.steps.start(s2.id)).toMatchObject({ status: 'running', attempts: 2 });
  });

  it('is safe to run recovery repeatedly', () => {
    const open = fileStorage();
    const storage = open();
    const { task } = seedRunningTask(storage);
    expect(storage.recovery.recoverInterruptedTasks().interruptedTaskIds).toEqual([task.id]);
    expect(storage.recovery.recoverInterruptedTasks().interruptedTaskIds).toEqual([]);
  });

  it('only resumes interrupted tasks', () => {
    const open = fileStorage();
    const storage = open();
    const task = storage.tasks.create({ title: 'T', input: {} });
    expect(() => storage.recovery.resume(task.id)).toThrow(/Only interrupted tasks/);
    storage.tasks.start(task.id);
    storage.recovery.recoverInterruptedTasks();
    storage.tasks.cancel(task.id);
    expect(() => storage.recovery.resume(task.id)).toThrow(/is "cancelled"/);
  });

  it('includes pending approvals in the resume plan', () => {
    const open = fileStorage();
    const storage = open();
    const { task } = seedRunningTask(storage);
    storage.approvals.request(task.id, { action: 'file.write', summary: 'Save report' });
    storage.recovery.recoverInterruptedTasks();
    expect(storage.recovery.getResumePlan(task.id).pendingApprovals).toHaveLength(1);
  });
});
