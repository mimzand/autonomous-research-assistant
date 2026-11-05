import { TaskStatusSchema, StepStatusSchema, type StepStatus, type TaskStatus } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { STEP_TRANSITIONS } from './repositories/task-steps.js';
import { TASK_TRANSITIONS } from './repositories/tasks.js';
import { memoryStorage } from './testing.js';

/*
 * Every task and step lifecycle transition, allowed and refused, against a
 * real database. The tables are the single source of truth; these tests pin
 * them so a change is always deliberate.
 */

const TASK_EXPECTED: Record<TaskStatus, TaskStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'awaiting-approval', 'interrupted'],
  'awaiting-approval': ['running', 'cancelled', 'failed'],
  interrupted: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: ['running'], // explicit retry only
  cancelled: [],
};

const STEP_EXPECTED: Record<StepStatus, StepStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['completed', 'failed', 'interrupted'],
  failed: ['running', 'pending'],
  interrupted: ['running', 'skipped'],
  completed: [],
  skipped: ['pending'],
};

/** Puts a new task into `status` through allowed transitions only. */
function taskIn(storage: ReturnType<typeof memoryStorage>, status: TaskStatus) {
  const task = storage.tasks.create({ title: 'T', input: {} });
  const path: Record<TaskStatus, TaskStatus[]> = {
    pending: [],
    running: ['running'],
    'awaiting-approval': ['running', 'awaiting-approval'],
    interrupted: ['running', 'interrupted'],
    completed: ['running', 'completed'],
    failed: ['running', 'failed'],
    cancelled: ['cancelled'],
  };
  for (const to of path[status]) storage.tasks.transition(task.id, to);
  return task.id;
}

function stepIn(storage: ReturnType<typeof memoryStorage>, status: StepStatus) {
  const task = storage.tasks.create({ title: 'T', input: {} });
  const step = storage.steps.append(task.id, { kind: 'k', name: 'n' });
  const go: Record<StepStatus, () => void> = {
    pending: () => undefined,
    running: () => storage.steps.start(step.id),
    completed: () => (storage.steps.start(step.id), storage.steps.complete(step.id, 1)),
    failed: () => (storage.steps.start(step.id), storage.steps.fail(step.id, 'x')),
    interrupted: () => (storage.steps.start(step.id), storage.steps.interrupt(step.id, 'x')),
    skipped: () => storage.steps.skip(step.id, 'x'),
  };
  go[status]();
  return step.id;
}

const stepAction: Record<StepStatus, (s: ReturnType<typeof memoryStorage>, id: string) => unknown> =
  {
    pending: (s, id) => s.steps.requeue(id),
    running: (s, id) => s.steps.start(id),
    completed: (s, id) => s.steps.complete(id, 1),
    failed: (s, id) => s.steps.fail(id, 'e'),
    interrupted: (s, id) => s.steps.interrupt(id, 'e'),
    skipped: (s, id) => s.steps.skip(id, 'e'),
  };

describe('task lifecycle', () => {
  it('matches the documented transition table', () => {
    expect(TASK_TRANSITIONS).toEqual(TASK_EXPECTED);
  });

  for (const from of TaskStatusSchema.options) {
    for (const to of TaskStatusSchema.options) {
      const allowed = TASK_EXPECTED[from].includes(to);
      it(`${from} → ${to} is ${allowed ? 'allowed' : 'refused'}`, () => {
        const storage = memoryStorage();
        const id = taskIn(storage, from);
        expect(storage.tasks.require(id).status).toBe(from);
        if (allowed) {
          expect(storage.tasks.transition(id, to).status).toBe(to);
        } else {
          expect(() => storage.tasks.transition(id, to)).toThrow(
            expect.objectContaining({ code: 'invalid-transition' }),
          );
          expect(storage.tasks.require(id).status).toBe(from);
        }
      });
    }
  }

  it('a retried task clears its error and finish time but keeps its start time', () => {
    const storage = memoryStorage();
    const id = taskIn(storage, 'failed');
    const failed = storage.tasks.transition(id, 'running');
    expect(failed).toMatchObject({ error: null, finishedAt: null });
    expect(failed.startedAt).not.toBeNull();
  });
});

describe('step lifecycle', () => {
  it('matches the documented transition table', () => {
    expect(STEP_TRANSITIONS).toEqual(STEP_EXPECTED);
  });

  for (const from of StepStatusSchema.options) {
    for (const to of StepStatusSchema.options) {
      const allowed = STEP_EXPECTED[from].includes(to);
      it(`${from} → ${to} is ${allowed ? 'allowed' : 'refused'}`, () => {
        const storage = memoryStorage();
        const id = stepIn(storage, from);
        if (allowed) {
          expect((stepAction[to](storage, id) as { status: string }).status).toBe(to);
        } else {
          expect(() => stepAction[to](storage, id)).toThrow();
          expect(storage.steps.get(id)?.status).toBe(from);
        }
      });
    }
  }

  it('a completed step can never run again or be re-queued (no duplicate execution)', () => {
    const storage = memoryStorage();
    const id = stepIn(storage, 'completed');
    expect(() => storage.steps.start(id)).toThrow(
      expect.objectContaining({ code: 'step-already-completed' }),
    );
    expect(() => storage.steps.requeue(id)).toThrow(
      expect.objectContaining({ code: 'invalid-transition' }),
    );
  });

  it('re-queuing clears the error; attempts keep counting', () => {
    const storage = memoryStorage();
    const id = stepIn(storage, 'failed');
    expect(storage.steps.requeue(id)).toMatchObject({
      status: 'pending',
      error: null,
      finishedAt: null,
      attempts: 1,
    });
    expect(storage.steps.start(id)).toMatchObject({ attempts: 2 });
  });

  it('a skip keeps its reason', () => {
    const storage = memoryStorage();
    const id = stepIn(storage, 'pending');
    expect(storage.steps.skip(id, 'Source 2 could not be read.')).toMatchObject({
      status: 'skipped',
      error: 'Source 2 could not be read.',
    });
  });
});

describe('execution log', () => {
  it('appends entries in order per task and lists them incrementally', () => {
    const storage = memoryStorage();
    const a = storage.tasks.create({ title: 'A', input: {} });
    const b = storage.tasks.create({ title: 'B', input: {} });
    const step = storage.steps.append(a.id, { kind: 'k', name: 'n' });
    storage.logs.append(a.id, { level: 'info', event: 'task.started', message: 'Started' });
    storage.logs.append(b.id, { level: 'info', event: 'task.started', message: 'Other task' });
    storage.logs.append(a.id, {
      stepId: step.id,
      level: 'warn',
      event: 'model.retry',
      message: 'Retrying',
      data: { attempt: 1, code: 'timeout' },
    });
    storage.logs.append(a.id, { level: 'error', event: 'task.failed', message: 'Failed' });

    expect(storage.logs.listByTask(a.id).map((l) => [l.seq, l.event])).toEqual([
      [1, 'task.started'],
      [2, 'model.retry'],
      [3, 'task.failed'],
    ]);
    expect(storage.logs.listByTask(a.id, { afterSeq: 2 }).map((l) => l.seq)).toEqual([3]);
    expect(storage.logs.listByTask(a.id, { levels: ['warn', 'error'] })).toHaveLength(2);
    expect(storage.logs.listByTask(a.id)[1]).toMatchObject({
      stepId: step.id,
      data: { attempt: 1 },
    });
    expect(storage.logs.listByTask(b.id)[0]?.seq).toBe(1);
  });

  it('validates entries', () => {
    const storage = memoryStorage();
    const t = storage.tasks.create({ title: 'A', input: {} });
    expect(() =>
      storage.logs.append(t.id, { level: 'fatal' as never, event: 'x', message: 'm' }),
    ).toThrow();
    expect(() =>
      storage.logs.append(t.id, { level: 'info', event: 'Bad Event', message: 'm' }),
    ).toThrow();
    expect(() => storage.logs.append(t.id, { level: 'info', event: 'x', message: '' })).toThrow();
    expect(() =>
      storage.logs.append(t.id, {
        level: 'info',
        event: 'x',
        message: 'm',
        data: 'y'.repeat(5000),
      }),
    ).toThrow(/exceeds/);
  });

  it('is deleted with its task', () => {
    const storage = memoryStorage();
    const t = storage.tasks.create({ title: 'A', input: {} });
    storage.logs.append(t.id, { level: 'info', event: 'x', message: 'm' });
    storage.tasks.delete(t.id);
    expect(storage.logs.listByTask(t.id)).toEqual([]);
  });
});
