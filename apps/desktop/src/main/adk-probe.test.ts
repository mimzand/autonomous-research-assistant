import { describe, expect, it } from 'vitest';
import { probeAdkRuntime } from './adk-probe.js';

type Runtime = Awaited<ReturnType<NonNullable<Parameters<typeof probeAdkRuntime>[0]>>>;

const fakeRuntime = (
  check: { ok: boolean; durationMs: number; error?: string },
  removed: string[] = [],
): Runtime =>
  ({
    version: '2.4.0',
    environment: { removed, forced: [] },
    engine: { runAdkSelfCheck: () => Promise.resolve(check) },
  }) as unknown as Runtime;

describe('probeAdkRuntime', () => {
  it('loads the real ADK runtime and passes its offline self-check', async () => {
    const result = await probeAdkRuntime();
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/^@google\/adk 2\.4\.0 loaded, self-check passed/);
  });

  it('reports removed variable names, never values', async () => {
    const result = await probeAdkRuntime(() =>
      Promise.resolve(fakeRuntime({ ok: true, durationMs: 3 }, ['GOOGLE_API_KEY'])),
    );
    expect(result.summary).toContain('removed 1 environment variable(s): GOOGLE_API_KEY');
  });

  it('reports a failed self-check without throwing', async () => {
    const result = await probeAdkRuntime(() =>
      Promise.resolve(fakeRuntime({ ok: false, durationMs: 1, error: 'boom' })),
    );
    expect(result).toEqual({
      ok: false,
      summary: '@google/adk 2.4.0 loaded, but the self-check failed: boom.',
    });
  });

  it('reports a load failure without throwing', async () => {
    const result = await probeAdkRuntime(() => Promise.reject(new Error('cannot load')));
    expect(result).toEqual({ ok: false, summary: '@google/adk could not be loaded: cannot load.' });
  });
});
