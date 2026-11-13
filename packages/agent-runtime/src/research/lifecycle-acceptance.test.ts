/**
 * Phase 7.6 lifecycle acceptance (agent runtime): report-save idempotency
 * after a crash, late model answers after Cancel, and what the renderer is
 * told (progress events) around terminal states.
 */
import { openStorage } from '@rka/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYSIS, cleanupDirs, fakeModel, harness, tempDbPath, waitFor } from './test-fixtures.js';

afterEach(() => {
  vi.useRealTimers();
  cleanupDirs();
});

describe('crash during report save', () => {
  it('recovery later does not create a second, identical report version', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    const path = tempDbPath();
    const first = openStorage({ path });
    const create = first.reports.create.bind(first.reports);
    first.reports.create = (taskId, input) => {
      const report = create(taskId, input);
      first.close(); // the process dies right after the insert
      return report;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infos = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const h1 = harness({ storage: first });
    const id = await h1.start();
    await h1.runtime.tasks.whenIdle();
    // A closed database (app quitting) is reported as a stop, never as a crash.
    expect(errors).not.toHaveBeenCalled();
    expect(infos).toHaveBeenCalledWith(
      expect.stringMatching(/stopped: the database was closed \(app shutting down\)/),
    );
    errors.mockRestore();
    infos.mockRestore();

    // Restart five minutes later.
    vi.setSystemTime(new Date('2026-11-13T10:05:00Z'));
    const second = openStorage({ path });
    expect(second.tasks.require(id).status).toBe('running');
    second.recovery.recoverInterruptedTasks();
    expect(second.steps.listByTask(id).find((s) => s.kind === 'save')?.status).toBe('interrupted');
    expect(second.reports.listByTask(id)).toHaveLength(1);

    const h2 = harness({ storage: second });
    h2.runtime.tasks.resume(id);
    await h2.runtime.tasks.whenIdle();
    expect(second.tasks.require(id).status).toBe('completed');
    const reports = second.reports.listByTask(id);
    expect(reports.map((r) => r.version)).toEqual([1]);
    expect((second.tasks.require(id).output as { reportId: string }).reportId).toBe(reports[0]?.id);
    second.close();
  });
});

describe('late answers and events around Cancel / Pause', () => {
  /** A model call that ignores the abort and answers 150 ms later anyway. */
  const late = (value: unknown) => () =>
    new Promise((resolve) => setTimeout(() => resolve(value), 150));

  it('a late answer after Cancel cannot complete the task or start another step', async () => {
    const slow = fakeModel({ 'compare-findings': late(ANALYSIS) });
    const h = harness({ model: slow });
    const id = await h.start();
    await waitFor(() => slow.calls('compare-findings') > 0);
    expect(h.runtime.tasks.cancel(id)).toMatchObject({ ok: true });
    await h.runtime.tasks.whenIdle();
    expect(h.storage.tasks.require(id).status).toBe('cancelled');
    expect(slow.calls('write-report')).toBe(0);
    expect(h.storage.reports.listByTask(id)).toEqual([]);
    const steps = h.storage.steps.listByTask(id);
    expect(steps.filter((s) => s.status === 'running')).toEqual([]);
    expect(steps.find((s) => s.kind === 'report')?.status).toBe('pending');
    // Terminal: nothing can move it again.
    expect(h.runtime.tasks.resume(id)).toMatchObject({ ok: false });
    expect(h.runtime.tasks.retry(id)).toMatchObject({ ok: false });
    expect(() => h.storage.tasks.complete(id, {})).toThrow(/cannot go from "cancelled"/);
  });

  it.each(['cancel', 'pause'] as const)(
    'after %s, the last event is the terminal one and no step event follows',
    async (action) => {
      const slow = fakeModel({ 'write-report': late({}) });
      const h = harness({ model: slow });
      const id = await h.start();
      await waitFor(() => slow.calls('write-report') > 0);
      h.runtime.tasks[action](id);
      await h.runtime.tasks.whenIdle();
      await new Promise((r) => setTimeout(r, 200)); // let the late answer arrive
      const mine = h.events.filter((e) => e.taskId === id);
      const last = mine.at(-1);
      expect(last).toMatchObject({
        type: 'task',
        taskStatus: action === 'cancel' ? 'cancelled' : 'interrupted',
      });
      const terminal = mine.findIndex(
        (e) =>
          e.type === 'task' && (e.taskStatus === 'cancelled' || e.taskStatus === 'interrupted'),
      );
      expect(mine.slice(terminal + 1)).toEqual([]);
      // The event's status matches what is stored (no stale state for the renderer).
      expect(last?.taskStatus).toBe(h.storage.tasks.require(id).status);
    },
  );
});
