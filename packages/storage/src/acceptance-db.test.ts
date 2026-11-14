import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage } from './storage.js';
import { tempDir } from './testing.js';

const script = join(import.meta.dirname, '..', 'scripts', 'acceptance-db.mjs');
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

const model = (pin?: string) => ({
  provider: 'ollama',
  name: 'qwen3:8b',
  url: 'http://127.0.0.1:11434',
  config: { model: 'qwen3:8b', ...(pin && { researchEngine: pin }) },
});

describe('acceptance:db (read-only report)', () => {
  it('reports engines, counts and integrity without writing or printing content', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const storage = openStorage({ path: dbPath });
    const goal = 'SECRET GOAL TEXT that must not be printed';
    const make = (input: Record<string, unknown>) =>
      storage.tasks.create({
        title: 'Research',
        input: { kind: 'research', goal, limits: {}, ...input },
      });
    const old = make({});
    const legacy = make({ model: model() });
    const adk = make({ model: model('adk') });
    const odd = make({ model: model('adk-v9') });
    storage.tasks.start(adk.id);
    const step = storage.steps.append(adk.id, {
      kind: 'plan',
      name: 'Plan',
      input: { key: 'plan' },
    });
    storage.steps.start(step.id);
    storage.steps.complete(step.id, { title: 'x' });
    storage.modelUsage.record({
      taskId: adk.id,
      stepId: step.id,
      provider: 'ollama',
      model: 'qwen3:8b',
      purpose: 'research:plan',
      promptTokens: 1,
      completionTokens: 1,
      totalDurationMs: 1,
      loadDurationMs: 0,
    });
    storage.modelUsage.record({
      taskId: adk.id,
      stepId: step.id,
      provider: 'ollama',
      model: 'qwen3:8b',
      purpose: 'research:plan',
      promptTokens: 1,
      completionTokens: 1,
      totalDurationMs: 1,
      loadDurationMs: 0,
    });
    storage.close();
    const before = { bytes: readFileSync(dbPath), mtime: statSync(dbPath).mtimeMs };

    const out = execFileSync(process.execPath, [script, dbPath], { encoding: 'utf8' });
    const report = JSON.parse(out) as {
      quickCheck: string[];
      migrations: string[];
      researchTasks: { id: string; engine: string; completedStepsWithDuplicateUsage: string[] }[];
      summary: { unfinishedAdkTasks: string[]; tasksWithDuplicateUsage: string[] };
      adkSessionTables: Record<string, number>;
    };
    expect(report.quickCheck).toEqual(['ok']);
    expect(report.migrations).toContain('0002_adk_sessions');
    const engine = (id: string) => report.researchTasks.find((t) => t.id === id)?.engine;
    expect(engine(old.id)).toBe('legacy (no model capture)');
    expect(engine(legacy.id)).toBe('legacy');
    expect(engine(adk.id)).toBe('adk');
    expect(engine(odd.id)).toBe('unknown (adk-v9)');
    expect(report.summary.unfinishedAdkTasks).toEqual([adk.id]);
    expect(report.summary.tasksWithDuplicateUsage).toEqual([adk.id]);
    expect(report.adkSessionTables).toEqual({
      adk_sessions: 0,
      adk_events: 0,
      adk_app_state: 0,
      adk_user_state: 0,
    });
    expect(out).not.toContain('SECRET GOAL');
    // Read-only: the database file is unchanged.
    expect(readFileSync(dbPath).equals(before.bytes)).toBe(true);
    expect(statSync(dbPath).mtimeMs).toBe(before.mtime);
  });
});
