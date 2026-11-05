import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelProviderError, type GenerateRequest, type ModelProvider } from '@rka/model-provider';
import { type ModelHealth } from '@rka/shared';
import { openStorage, type Storage } from '@rka/storage';
import { createToolRegistry } from '@rka/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSISTENCE_CHECK_KIND,
  PERSISTENCE_CHECK_QUESTION,
  localStamp,
} from './persistence-check.js';
import { createAgentRuntime } from './runtime.js';

const ready: ModelHealth = {
  status: 'ready',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  checkedAt: '2026-11-04T12:00:00.000Z',
  serverVersion: '0.40.14',
  capabilities: ['completion', 'tools'],
  contextLength: 40960,
  structuredOutput: true,
};

/** Fake provider. `generate` can be held open to simulate a slow model. */
function fakeProvider(options: { health?: ModelHealth; hold?: boolean } = {}) {
  let release: (() => void) | undefined;
  const generate = vi.fn(async (_req: GenerateRequest, opts?: { signal?: AbortSignal }) => {
    if (options.hold) {
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        opts?.signal?.addEventListener('abort', () =>
          reject(new ModelProviderError('cancelled', 'Request was cancelled.')),
        );
      });
    }
    return {
      model: 'qwen3:8b',
      content: '  SQLite is a small, embedded SQL database engine.  ',
      finishReason: 'stop' as const,
      usage: { promptTokens: 12, completionTokens: 11, totalDurationMs: 800, loadDurationMs: 0 },
    };
  });
  const provider: ModelProvider = {
    id: 'ollama',
    defaultModel: 'qwen3:8b',
    checkHealth: vi.fn(async () => options.health ?? ready),
    checkModel: vi.fn(),
    generate,
    generateStream: vi.fn(),
  };
  return { provider, generate, release: () => release?.() };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fileDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rka-runtime-'));
  dirs.push(dir);
  return join(dir, 'research.db');
}

function runtimeWith(storage: Storage, provider: ModelProvider) {
  return createAgentRuntime({ modelProvider: provider, tools: createToolRegistry([]), storage });
}

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('persistence check task', () => {
  it('creates a task with three steps, runs them and stores every output', async () => {
    const storage = openStorage({ path: ':memory:' });
    const { provider } = fakeProvider();
    const runtime = runtimeWith(storage, provider);

    const task = runtime.tasks.runPersistenceCheck();
    expect(task).toMatchObject({ status: 'running', input: { kind: PERSISTENCE_CHECK_KIND } });
    await runtime.tasks.whenIdle();

    const stored = storage.tasks.require(task.id);
    expect(stored).toMatchObject({
      status: 'completed',
      output: {
        kind: PERSISTENCE_CHECK_KIND,
        verified: true,
        answer: 'SQLite is a small, embedded SQL database engine.',
        completedSteps: 3,
      },
    });
    const steps = storage.steps.listByTask(task.id);
    expect(steps.map((s) => [s.seq, s.kind, s.status, s.attempts])).toEqual([
      [1, 'check', 'completed', 1],
      [2, 'generate', 'completed', 1],
      [3, 'verify', 'completed', 1],
    ]);
    expect(steps[0]?.output).toMatchObject({ status: 'ready', model: 'qwen3:8b' });
    expect(steps[1]?.output).toMatchObject({
      question: PERSISTENCE_CHECK_QUESTION,
      answer: 'SQLite is a small, embedded SQL database engine.',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(steps[2]?.output).toMatchObject({ verified: true });

    // Token usage recorded against the task and the generate step.
    expect(storage.modelUsage.listByTask(task.id)).toEqual([
      expect.objectContaining({
        stepId: steps[1]?.id,
        model: 'qwen3:8b',
        purpose: PERSISTENCE_CHECK_KIND,
        promptTokens: 12,
        completionTokens: 11,
      }),
    ]);
  });

  it('fails the task with a clear error when Ollama is unavailable', async () => {
    const storage = openStorage({ path: ':memory:' });
    const { provider, generate } = fakeProvider({
      health: {
        ...ready,
        status: 'unreachable',
        reason: 'unavailable',
        error: 'fetch failed (ECONNREFUSED)',
      } as never,
    });
    const runtime = runtimeWith(storage, provider);
    const task = runtime.tasks.runPersistenceCheck();
    await runtime.tasks.whenIdle();

    expect(storage.tasks.require(task.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining(
        'Step 1 (Check the local model) failed: Ollama is not reachable',
      ),
    });
    expect(storage.steps.listByTask(task.id).map((s) => s.status)).toEqual([
      'failed',
      'pending',
      'pending',
    ]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('reports a missing model', async () => {
    const storage = openStorage({ path: ':memory:' });
    const { provider } = fakeProvider({
      health: { ...ready, status: 'model-missing', installedModels: [] } as never,
    });
    const runtime = runtimeWith(storage, provider);
    const task = runtime.tasks.runPersistenceCheck();
    await runtime.tasks.whenIdle();
    expect(storage.tasks.require(task.id).error).toContain('Model qwen3:8b is not installed');
  });

  it('cancels a running check', async () => {
    const storage = openStorage({ path: ':memory:' });
    const { provider } = fakeProvider({ hold: true });
    const runtime = runtimeWith(storage, provider);
    const task = runtime.tasks.runPersistenceCheck();
    await waitFor(() => storage.steps.listByTask(task.id)[1]?.status === 'running');

    const info = runtime.tasks.recoveryInfo(
      storage.tasks.require(task.id),
      storage.steps.listByTask(task.id),
    );
    expect(info.cancellable).toBe(true);
    expect(runtime.tasks.cancel(task.id)).toMatchObject({ ok: true });
    await runtime.tasks.whenIdle();

    expect(storage.tasks.require(task.id).status).toBe('cancelled');
    expect(storage.steps.listByTask(task.id).map((s) => s.status)).toEqual([
      'completed',
      'failed',
      'pending',
    ]);
    expect(storage.steps.listByTask(task.id)[1]?.error).toBe('Cancelled by the user.');
  });

  it('after a crash, resumes from the interrupted step without re-running completed steps', async () => {
    const path = fileDb();

    // Run 1: the app "crashes" while the model is generating (step 2).
    const first = openStorage({ path });
    const slow = fakeProvider({ hold: true });
    const runtime1 = runtimeWith(first, slow.provider);
    const task = runtime1.tasks.runPersistenceCheck();
    await waitFor(() => first.steps.listByTask(task.id)[1]?.status === 'running');
    first.close(); // Process dies; nothing else is written.

    // Run 2: startup recovery, then an explicit Resume.
    const second = openStorage({ path });
    second.recovery.recoverInterruptedTasks();
    const fast = fakeProvider();
    const runtime2 = runtimeWith(second, fast.provider);

    const interrupted = second.tasks.require(task.id);
    expect(interrupted.status).toBe('interrupted');
    const info = runtime2.tasks.recoveryInfo(interrupted, second.steps.listByTask(task.id));
    expect(info).toMatchObject({
      resumable: true,
      completedSteps: 1,
      totalSteps: 3,
      nextStep: { seq: 2, name: 'Ask the model a short question' },
    });

    expect(runtime2.tasks.resume(task.id)).toMatchObject({ ok: true });
    await runtime2.tasks.whenIdle();

    expect(second.tasks.require(task.id).status).toBe('completed');
    const steps = second.steps.listByTask(task.id);
    expect(steps.map((s) => [s.status, s.attempts])).toEqual([
      ['completed', 1], // Not executed again.
      ['completed', 2], // Retried once after the interruption.
      ['completed', 1],
    ]);
    expect(fast.provider.checkHealth).not.toHaveBeenCalled(); // Step 1 was not re-run.
    expect(fast.generate).toHaveBeenCalledTimes(1);
    second.close();
  });

  it('never resumes automatically and refuses tasks without an executor', () => {
    const storage = openStorage({ path: ':memory:' });
    const { provider } = fakeProvider();
    const runtime = runtimeWith(storage, provider);
    const plain = storage.tasks.create({ title: 'Research', input: { question: 'q' } });
    storage.tasks.start(plain.id);
    storage.recovery.recoverInterruptedTasks();

    const info = runtime.tasks.recoveryInfo(storage.tasks.require(plain.id), []);
    expect(info).toMatchObject({ resumable: false, cancellable: true });
    expect(info.reason).toMatch(/No executor/);
    expect(runtime.tasks.resume(plain.id)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/No executor/),
    });
    expect(storage.tasks.require(plain.id).status).toBe('interrupted');

    expect(runtime.tasks.cancel(plain.id)).toMatchObject({ ok: true });
    expect(storage.tasks.require(plain.id).status).toBe('cancelled');
    expect(runtime.tasks.cancel(plain.id)).toMatchObject({ ok: false });
  });
});

describe('localStamp', () => {
  it('uses local time, not UTC', () => {
    const date = new Date(2026, 10, 4, 21, 5); // local 21:05
    expect(localStamp(date)).toBe('2026-11-04 21:05');
  });
});
