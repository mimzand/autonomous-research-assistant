import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../testing.js';

describe('model usage repository', () => {
  it('records model name and token usage, with or without a task', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({ title: 'T', input: {} });
    const step = storage.steps.append(task.id, { kind: 'plan', name: 'Plan' });

    const usage = storage.modelUsage.record({
      taskId: task.id,
      stepId: step.id,
      provider: 'ollama',
      model: 'qwen3:8b',
      purpose: 'plan',
      promptTokens: 120,
      completionTokens: 40,
      totalDurationMs: 2100,
      loadDurationMs: 0,
    });
    expect(usage).toMatchObject({ model: 'qwen3:8b', promptTokens: 120, completionTokens: 40 });

    // Token counts are optional (not every response reports them).
    storage.modelUsage.record({ provider: 'ollama', model: 'qwen3:8b', purpose: 'chat' });
    storage.modelUsage.record({
      provider: 'ollama',
      model: 'qwen3:4b',
      purpose: 'chat',
      completionTokens: 5,
    });

    expect(storage.modelUsage.listByTask(task.id)).toHaveLength(1);
    expect(storage.modelUsage.totals()).toEqual([
      { provider: 'ollama', model: 'qwen3:4b', calls: 1, promptTokens: 0, completionTokens: 5 },
      { provider: 'ollama', model: 'qwen3:8b', calls: 2, promptTokens: 120, completionTokens: 40 },
    ]);
    expect(storage.modelUsage.totals(task.id)).toEqual([
      { provider: 'ollama', model: 'qwen3:8b', calls: 1, promptTokens: 120, completionTokens: 40 },
    ]);
  });

  it('keeps usage history when the task is deleted', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({ title: 'T', input: {} });
    const usage = storage.modelUsage.record({
      taskId: task.id,
      provider: 'ollama',
      model: 'qwen3:8b',
      purpose: 'plan',
    });
    storage.tasks.delete(task.id);
    expect(storage.modelUsage.listRecent()).toEqual([
      expect.objectContaining({ id: usage.id, taskId: null }),
    ]);
  });

  it('rejects negative token counts', () => {
    const storage = memoryStorage();
    expect(() =>
      storage.modelUsage.record({
        provider: 'ollama',
        model: 'm',
        purpose: 'chat',
        promptTokens: -1,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
  });
});

describe('approvals repository', () => {
  it('requests and decides approvals exactly once', () => {
    const storage = memoryStorage();
    const task = storage.tasks.create({ title: 'T', input: {} });
    const approval = storage.approvals.request(task.id, {
      action: 'file.write',
      summary: 'Save report to Documents/heat-pumps.md',
      payload: { path: 'Documents/heat-pumps.md' },
    });
    expect(approval).toMatchObject({ status: 'pending', decidedAt: null });
    expect(storage.approvals.listPending()).toHaveLength(1);

    const decided = storage.approvals.decide(approval.id, { decision: 'approved', reason: 'ok' });
    expect(decided).toMatchObject({ status: 'approved', reason: 'ok' });
    expect(decided.decidedAt).not.toBeNull();
    expect(storage.approvals.listPending()).toEqual([]);

    expect(() => storage.approvals.decide(approval.id, { decision: 'rejected' })).toThrow(
      /already approved/,
    );
    expect(() => storage.approvals.decide('missing', { decision: 'rejected' })).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(storage.approvals.listByTask(task.id)).toHaveLength(1);
  });
});
