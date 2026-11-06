import { openStorage } from '@rka/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { type TaskModelConfig } from './schemas.js';
import {
  ANALYSIS,
  cleanupDirs,
  fakeModel,
  hang,
  harness,
  tempDbPath,
  waitFor,
} from './test-fixtures.js';

/*
 * Task isolation: a research task keeps the model configuration it started
 * with (server, model, options) for its whole life - also across Pause/Resume,
 * Retry and an app restart - while new tasks use the latest settings.
 */

afterEach(cleanupDirs);

/** Two "servers", each a scripted model; `settings` is what the Settings page would change. */
function servers(options: { hangAnalyzeOn?: string } = {}) {
  const models: Record<string, ReturnType<typeof fakeModel>> = {};
  let gate = true;
  const model = (label: string) =>
    (models[label] ??= fakeModel(
      options.hangAnalyzeOn === label
        ? {
            'compare-findings': (p, r, signal) => (gate ? hang(p, r, signal) : ANALYSIS),
          }
        : {},
    ));
  const settings = { label: 'A', name: 'qwen3:8b', url: 'http://127.0.0.1:11434' };
  const taskModels = {
    capture: (): TaskModelConfig => ({
      provider: 'ollama',
      name: settings.name,
      url: settings.url,
      config: { label: settings.label },
    }),
    providerFor: (captured: TaskModelConfig) =>
      model((captured.config as { label: string }).label).provider,
  };
  return { models, model, settings, taskModels, open: () => (gate = false) };
}

describe('task isolation', () => {
  it('a running task keeps its model configuration when the settings change; new tasks use the new one', async () => {
    const s = servers({ hangAnalyzeOn: 'A' });
    // Analysis on server A answers normally once the gate opens.
    s.model('A');
    const h = harness({ model: fakeModel(), runtime: { taskModels: s.taskModels } });
    const first = await h.start();
    await waitFor(() => (s.models['A']?.calls('compare-findings') ?? 0) > 0);

    // The user switches server and model in Settings while the task runs.
    Object.assign(s.settings, {
      label: 'B',
      name: 'llama3.2:3b',
      url: 'http://192.168.1.100:11434',
    });
    const second = await h.start();
    await waitFor(() => h.storage.tasks.require(second).status === 'completed');

    expect(h.storage.tasks.require(second).status).toBe('completed');
    expect(h.storage.tasks.require(first).input).toMatchObject({
      model: { name: 'qwen3:8b', url: 'http://127.0.0.1:11434' },
    });
    expect(h.storage.tasks.require(second).input).toMatchObject({
      model: { name: 'llama3.2:3b', url: 'http://192.168.1.100:11434' },
    });
    // The first task made every call on A, including after the change; B never saw it.
    expect(s.models['B']?.prompts.some((p) => p.task === 'create-plan')).toBe(true);
    expect(s.models['B']?.calls('create-plan')).toBe(1);
    expect(s.models['A']?.calls('create-plan')).toBe(1);

    // Pause the first task, then resume: still A.
    h.runtime.tasks.pause(first);
    await h.runtime.tasks.whenIdle();
    s.open();
    expect(h.runtime.tasks.resume(first)).toMatchObject({ ok: true });
    await h.runtime.tasks.whenIdle();
    expect(h.storage.tasks.require(first).status).toBe('completed');
    expect(s.models['A']?.calls('write-report')).toBe(1);
    expect(s.models['B']?.calls('write-report')).toBe(1); // only the second task
    // The live provider (chat) was never used by either task.
    expect(h.model.generate).not.toHaveBeenCalled();
  });

  it('after a restart, Resume uses the configuration stored with the task', async () => {
    const path = tempDbPath();
    const s = servers();
    const first = openStorage({ path });
    const h1 = harness({
      storage: first,
      runtime: {
        taskModels: {
          capture: s.taskModels.capture,
          providerFor: () => fakeModel({ 'write-report': hang }).provider,
        },
      },
    });
    const id = await h1.start();
    await waitFor(() =>
      first.steps.listByTask(id).some((x) => x.kind === 'report' && x.status === 'running'),
    );
    first.close();

    // Restart with different settings.
    Object.assign(s.settings, { label: 'B', name: 'other:1b', url: 'https://ollama.example.com' });
    const second = openStorage({ path });
    second.recovery.recoverInterruptedTasks();
    const used: string[] = [];
    const h2 = harness({
      storage: second,
      runtime: {
        taskModels: {
          capture: s.taskModels.capture,
          providerFor: (captured) => {
            used.push(`${captured.name}@${captured.url}`);
            return s.model((captured.config as { label: string }).label).provider;
          },
        },
      },
    });
    expect(h2.runtime.tasks.resume(id)).toMatchObject({ ok: true });
    await h2.runtime.tasks.whenIdle();
    expect(second.tasks.require(id).status).toBe('completed');
    expect(used).toEqual(['qwen3:8b@http://127.0.0.1:11434']);
    expect(s.models['A']?.calls('write-report')).toBe(1);
    expect(s.models['B']).toBeUndefined();
    second.close();
  });

  it('tasks created before runtime settings existed use the current provider', async () => {
    const h = harness();
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(h.storage.tasks.require(id).input).not.toHaveProperty('model');
    expect(h.storage.tasks.require(id).status).toBe('completed');
  });

  it('refuses to start while disconnected, with the provider message', async () => {
    const model = fakeModel();
    model.state.health = {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      checkedAt: '2026-11-05T10:00:00.000Z',
      status: 'unreachable',
      reason: 'disconnected',
      error: 'Disconnected from Ollama. Connect again in Settings → Ollama Connection.',
    };
    const h = harness({ model });
    expect(await h.runtime.tasks.startResearch({ goal: 'A valid research goal' })).toEqual({
      ok: false,
      message: 'Disconnected from Ollama. Connect again in Settings → Ollama Connection.',
    });
  });

  it('reads research defaults when each task starts', async () => {
    let maxSources = 2;
    const h = harness({ runtime: { researchDefaults: () => ({ retryBackoffMs: 0, maxSources }) } });
    const a = await h.start();
    maxSources = 1;
    const b = await h.start();
    await h.runtime.tasks.whenIdle();
    const limits = (id: string) =>
      (h.storage.tasks.require(id).input as { limits: { maxSources: number } }).limits;
    expect(limits(a).maxSources).toBe(2);
    expect(limits(b).maxSources).toBe(1);
  });
});
