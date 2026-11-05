import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '@rka/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { chatUsageRecorder, databasePath, openAppStorage } from './app-storage.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rka-userdata-'));
  dirs.push(dir);
  return dir;
}

describe('openAppStorage', () => {
  it('creates the database under userData/data and runs migrations', () => {
    const dir = userData();
    const { storage, recovery } = openAppStorage({ userDataDir: dir });
    expect(storage.path).toBe(databasePath(dir));
    expect(storage.path).toBe(join(dir, 'data', 'research.db'));
    expect(recovery.interruptedTaskIds).toEqual([]);
    storage.close();
  });

  it('marks a task that was running at shutdown as interrupted on the next start', () => {
    const dir = userData();
    const first = openStorage({ path: databasePath(dir) });
    const task = first.tasks.create({ title: 'Research', input: { question: 'q' } });
    first.tasks.start(task.id);
    const done = first.steps.append(task.id, { kind: 'plan', name: 'Plan' });
    first.steps.start(done.id);
    first.steps.complete(done.id, { plan: ['a'] });
    first.steps.start(first.steps.append(task.id, { kind: 'search', name: 'Search' }).id);
    first.close(); // Simulated crash/forced quit.

    const { storage, recovery } = openAppStorage({ userDataDir: dir });
    expect(recovery).toEqual({ interruptedTaskIds: [task.id], interruptedStepCount: 1 });
    expect(storage.tasks.require(task.id).status).toBe('interrupted');
    expect(storage.recovery.getResumePlan(task.id).nextStep?.name).toBe('Search');
    expect(storage.steps.require(done.id).status).toBe('completed');
    storage.close();
  });
});

describe('chatUsageRecorder', () => {
  it('persists model name and token usage', () => {
    const storage = openStorage({ path: ':memory:' });
    chatUsageRecorder(storage)({
      model: 'qwen3:8b',
      promptTokens: 18,
      completionTokens: 42,
      totalDurationMs: 900,
      loadDurationMs: 10,
    });
    expect(storage.modelUsage.listRecent()).toEqual([
      expect.objectContaining({
        provider: 'ollama',
        model: 'qwen3:8b',
        purpose: 'chat',
        promptTokens: 18,
        completionTokens: 42,
        taskId: null,
      }),
    ]);
  });
});
