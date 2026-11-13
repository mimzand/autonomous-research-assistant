/*
 * Phase 7.2: the benchmark's safety, budgets, deadlines, cleanup and logs.
 * Everything runs against the deterministic in-process fake Ollama (or no
 * server at all): no GPU, no installed model, no real Ollama.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOllamaConfig } from '@rka/model-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFakeOllama, type FakeOllama } from './fake-ollama.js';
import { benchMain } from './main.js';
import {
  BENCH_RESEARCH_LIMITS,
  computeWorkload,
  LIVE_ACKNOWLEDGEMENT,
  MAX_REPORT_PARAGRAPHS,
  MAX_TOKENS,
  originalBenchmarkWorkload,
  parseBenchOptions,
  REVIEW_BATCH,
  type BenchOptions,
} from './plan.js';
import { openProgressLog, readProgress, summarizeProgress } from './progress.js';
import { measureAdkLoad, runBenchmark, summarize } from './runner.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  vi.restoreAllMocks();
});

const io = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
};

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rka-bench-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fakeOptions = (over: Partial<BenchOptions> = {}): BenchOptions => ({
  mode: 'fake',
  runs: 1,
  warmup: 0,
  maxCalls: 1000,
  maxCompletionTokens: 1_000_000,
  requestTimeoutMs: 5000,
  taskTimeoutMs: 30_000,
  overallTimeoutMs: 60_000,
  cooldownMs: 0,
  modelRetries: 0,
  fakeLatencyMs: 0,
  progressPath: null,
  ...over,
});

async function fake(latencyMs = 0): Promise<FakeOllama> {
  const server = await startFakeOllama({ latencyMs });
  cleanups.push(() => server.close());
  return server;
}

async function run(options: BenchOptions, server: FakeOllama, signal?: AbortSignal) {
  const progress = openProgressLog(options.progressPath);
  try {
    return {
      result: await runBenchmark(options, {
        ollama: loadOllamaConfig({ OLLAMA_HOST: server.host }),
        progress,
        chatBodies: server.chatBodies,
        ...(signal && { signal }),
      }),
      records: progress.records,
    };
  } finally {
    progress.close();
  }
}

// --- safe default -----------------------------------------------------------------------

describe('safe default', () => {
  it('without BENCH_MODE it only prints the notice and the workload: no request, no ADK, no model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = io();
    const { exitCode, result } = await benchMain({ BENCH_RUNS: '5', BENCH_WARMUP: '1' }, out);
    expect(exitCode).toBe(0);
    expect(result).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = out.lines.join('\n');
    expect(text).toMatch(/two complete Windows hard freezes/i);
    expect(text).toMatch(/Research tasks: 12 /);
    expect(text).toMatch(/Mode: plan \(nothing is run\)/);
    expect(text).toContain('BENCH_MODE="fake"');
  });

  it('live mode refuses to start without the acknowledgement and explicit limits; nothing is contacted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const env of [
      { BENCH_MODE: 'live' },
      { BENCH_MODE: 'live', BENCH_LIVE_ACKNOWLEDGE: 'yes' },
      { BENCH_MODE: 'live', BENCH_LIVE_ACKNOWLEDGE: LIVE_ACKNOWLEDGEMENT }, // limits missing
      {
        BENCH_MODE: 'live',
        BENCH_LIVE_ACKNOWLEDGE: LIVE_ACKNOWLEDGEMENT,
        BENCH_RUNS: '5', // above the live ceiling of 3
        BENCH_MAX_CALLS: '20',
        BENCH_MAX_COMPLETION_TOKENS: '20000',
        BENCH_REQUEST_TIMEOUT_MS: '120000',
        BENCH_TASK_TIMEOUT_MS: '300000',
        BENCH_OVERALL_TIMEOUT_MS: '900000',
        BENCH_COOLDOWN_MS: '60000',
      },
    ]) {
      const out = io();
      expect((await benchMain(env, out)).exitCode, JSON.stringify(env)).toBe(2);
      expect(out.lines.join('\n')).toMatch(/refusing to run/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('live mode has no workload defaults and never clamps: every limit is explicit and within its ceiling', () => {
    const base = {
      BENCH_MODE: 'live',
      BENCH_LIVE_ACKNOWLEDGE: LIVE_ACKNOWLEDGEMENT,
      BENCH_RUNS: '1',
      BENCH_MAX_CALLS: '14',
      BENCH_MAX_COMPLETION_TOKENS: '20000',
      BENCH_REQUEST_TIMEOUT_MS: '120000',
      BENCH_TASK_TIMEOUT_MS: '300000',
      BENCH_OVERALL_TIMEOUT_MS: '900000',
      BENCH_COOLDOWN_MS: '60000',
    };
    const ok = parseBenchOptions(base);
    expect(ok).toMatchObject({
      ok: true,
      options: { mode: 'live', runs: 1, warmup: 0, modelRetries: 0 },
    });
    expect(parseBenchOptions({ ...base, BENCH_COOLDOWN_MS: '1000' })).toMatchObject({ ok: false });
    expect(parseBenchOptions({ ...base, BENCH_MAX_CALLS: '100' })).toMatchObject({ ok: false });
    expect(parseBenchOptions({ ...base, BENCH_MODEL_RETRIES: '2' })).toMatchObject({ ok: false });
    expect(parseBenchOptions({ ...base, BENCH_RUNS: 'lots' })).toMatchObject({ ok: false });
    expect(parseBenchOptions({ BENCH_MODE: 'turbo' })).toMatchObject({ ok: false });
  });

  it('fake mode never contacts the configured Ollama, even when OLLAMA_HOST is set', async () => {
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return realFetch(input, init);
    });
    const out = io();
    const { exitCode, result } = await benchMain(
      {
        BENCH_MODE: 'fake',
        BENCH_RUNS: '1',
        BENCH_WARMUP: '0',
        OLLAMA_HOST: '127.0.0.1:9',
        OLLAMA_MODEL: 'real-model:70b',
      },
      out,
    );
    expect(exitCode).toBe(0);
    expect(result?.complete).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes('127.0.0.1:9/'))).toBe(false);
    expect(out.lines.join('\n')).toMatch(/Model: none \(deterministic fake Ollama, no GPU\)/);
  });
});

// --- workload --------------------------------------------------------------------------

describe('workload', () => {
  it('the exact workload of the user’s phase 7.1 command (BENCH_RUNS=5, BENCH_WARMUP=1)', () => {
    expect(originalBenchmarkWorkload(5, 1)).toEqual({
      tasks: 12,
      typicalCalls: 72,
      maxAttempts: 240,
      maxCompletionTokens: 259_200,
      worstCaseAttemptWaitMs: 240 * 300_000,
    });
  });

  it('per-task maxima follow the Research limits and call sites', () => {
    const w = computeWorkload(fakeOptions({ runs: 2, warmup: 1, modelRetries: 1 }));
    expect(w.tasks).toBe(6);
    // Phase 7.5: + at most 3 goal-completeness calls (600 + 800 + 400 tokens), typically 1.
    expect(w.perTask).toEqual({
      typicalCalls: 7,
      maxCalls: 13,
      maxAttempts: 26,
      maxCompletionTokens: 25_200,
    });
  });

  it('the budgets bound the workload, and options never increase it', () => {
    const w = computeWorkload(
      fakeOptions({ runs: 3, warmup: 1, maxCalls: 14, maxCompletionTokens: 20_000 }),
    );
    expect(w.scheduled.maxAttempts).toBe(104);
    expect(w.bounded).toEqual({ maxAttempts: 14, maxCompletionTokens: 20_000 });
  });

  it('alternates the engine order of measured runs; warm-ups come first', () => {
    const w = computeWorkload(fakeOptions({ runs: 3, warmup: 1 }));
    expect(w.order.map((x) => `${x.warmup ? 'W' : 'M'}${String(x.run)}:${x.engine}`)).toEqual([
      'W0:legacy',
      'W0:adk',
      'M0:legacy',
      'M0:adk',
      'M1:adk',
      'M1:legacy',
      'M2:legacy',
      'M2:adk',
    ]);
  });

  it('the constants match the Research step machine source', () => {
    const workflow = readFileSync(
      join(import.meta.dirname, '../../../../packages/agent-runtime/src/research/workflow.ts'),
      'utf8',
    );
    const schemas = readFileSync(
      join(import.meta.dirname, '../../../../packages/agent-runtime/src/research/schemas.ts'),
      'utf8',
    );
    const tokens = Object.fromEntries(
      [
        ...workflow.matchAll(
          /(ResearchPlanSchema|SourceEvidenceSchema|AnalysisSchema|ReportDraftSchema|ReviewSchema|GoalCheckSchema|GoalCorrectionSchema),\s*(\d+),/g,
        ),
      ].map((m) => [m[1], Number(m[2])]),
    );
    expect(tokens).toEqual({
      ResearchPlanSchema: MAX_TOKENS.plan,
      SourceEvidenceSchema: MAX_TOKENS.evidence,
      AnalysisSchema: MAX_TOKENS.analyze,
      ReportDraftSchema: MAX_TOKENS.report,
      ReviewSchema: MAX_TOKENS.review,
      GoalCheckSchema: MAX_TOKENS.goalCheck,
      GoalCorrectionSchema: MAX_TOKENS.goalCorrection,
    });
    expect(workflow).toContain(`const GOAL_REVIEW_MAX_TOKENS = ${String(MAX_TOKENS.goalReview)};`);
    expect(workflow).toContain(`const REVIEW_BATCH = ${String(REVIEW_BATCH)};`);
    const report =
      /ReportDraftSchema = z\.object\(\{[\s\S]*?summary: z\.array\(ParagraphSchema\)\.min\(1\)\.max\((\d+)\)[\s\S]*?paragraphs: z\.array\(ParagraphSchema\)\.min\(1\)\.max\((\d+)\)[\s\S]*?\.max\((\d+)\)/.exec(
        schemas,
      );
    expect(Number(report?.[1]) + Number(report?.[2]) * Number(report?.[3])).toBe(
      MAX_REPORT_PARAGRAPHS,
    );
    expect(BENCH_RESEARCH_LIMITS).toEqual({
      maxQuestions: 1,
      maxQueriesPerQuestion: 1,
      maxSources: 2,
    });
  });
});

// --- runner ----------------------------------------------------------------------------

describe('runner (fake Ollama)', () => {
  it('completes strictly sequentially, with request parity and no extra HTTP calls or retries', async () => {
    const server = await fake();
    const { result } = await run(fakeOptions({ runs: 2, warmup: 1 }), server);
    expect(result.complete).toBe(true);
    expect(result.tasks.map((t) => `${t.engine}:${t.status}`)).toEqual([
      'legacy:completed',
      'adk:completed',
      'legacy:completed',
      'adk:completed',
      'adk:completed',
      'legacy:completed',
    ]);
    expect(result.maxInflight).toBe(1);
    expect(server.maxConcurrentChats()).toBe(1);
    expect(result.parity).toEqual([
      { run: 0, identical: true },
      { run: 1, identical: true },
    ]);
    const s = summarize(result);
    for (const e of ['legacy', 'adk'] as const) {
      expect(s[e].retries).toBe(0);
      expect(s[e].extraHttp).toBe(0);
      expect(s[e].callsPerTask.median).toBe(6);
    }
    expect(result.tasks.every((t) => t.completedAllSteps)).toBe(true);
    expect(s.equivalentRuns.every((r) => r.sameStepsAndTokens)).toBe(true);
    expect(server.openRequests()).toBe(0);
  });

  it('stops at the request budget before sending the next request', async () => {
    const server = await fake();
    const { result } = await run(fakeOptions({ maxCalls: 3 }), server);
    expect(result).toMatchObject({ complete: false, stopReason: 'request-budget', requests: 3 });
    expect(server.chatBodies).toHaveLength(3);
    expect(result.tasks).toHaveLength(1); // the next engine never started
  });

  it('stops at the completion-token budget, reserving each request’s maxTokens in advance', async () => {
    const server = await fake();
    // Each answer uses 20 tokens and the rest of its reservation is released:
    // plan, evidence ×2 and analyze fit; report reserves 2000 and would exceed the budget.
    const { result } = await run(fakeOptions({ maxCompletionTokens: 2000 }), server);
    expect(result).toMatchObject({ complete: false, stopReason: 'token-budget', requests: 4 });
    expect(server.chatBodies).toHaveLength(4);
    expect(result.completionTokensReserved).toBeLessThanOrEqual(2000);
  });

  it('per-request deadline: a slow answer is abandoned and, with retries off, not retried', async () => {
    const server = await fake(1500);
    const { result } = await run(fakeOptions({ requestTimeoutMs: 1000 }), server);
    expect(result.complete).toBe(false);
    expect(result.stopReason).toMatch(/^task-/);
    expect(result.requests).toBe(1);
    const [call] = result.tasks[0]?.calls ?? [];
    expect(call).toMatchObject({ step: 'plan', ok: false, retry: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.openRequests()).toBe(0); // the HTTP request was closed
  });

  it('retries are opt-in and reported explicitly', async () => {
    const server = await fake(1500);
    const { result } = await run(fakeOptions({ requestTimeoutMs: 1000, modelRetries: 1 }), server);
    expect(result.requests).toBe(2);
    expect(result.tasks[0]?.calls.map((c) => c.retry)).toEqual([false, true]);
  });

  it('per-task deadline cancels the task and stops the benchmark', async () => {
    const server = await fake(150);
    const { result, records } = await run(fakeOptions({ taskTimeoutMs: 400 }), server);
    expect(result).toMatchObject({ complete: false, stopReason: 'task-deadline' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.status).toBe('cancelled');
    expect(records.at(-1)).toMatchObject({
      type: 'bench-end',
      complete: false,
      stopReason: 'task-deadline',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.openRequests()).toBe(0);
  });

  it('overall deadline stops between or during tasks', async () => {
    const server = await fake(100);
    const { result } = await run(fakeOptions({ runs: 3, overallTimeoutMs: 900 }), server);
    expect(result).toMatchObject({ complete: false, stopReason: 'overall-deadline' });
    expect(result.tasks.length).toBeLessThan(6);
  });

  it('cancellation (e.g. Ctrl+C) stops the current task, closes the request and cleans up', async () => {
    const server = await fake(300);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const { result } = await run(fakeOptions({ runs: 2 }), server, controller.signal);
    expect(result).toMatchObject({ complete: false, stopReason: 'cancelled' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.status).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 50));
    expect(server.openRequests()).toBe(0);
  });

  it('cooldown waits between tasks and is interrupted by cancellation', async () => {
    const server = await fake();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const { result } = await run(fakeOptions({ cooldownMs: 10_000 }), server, controller.signal);
    expect(result.stopReason).toBe('cancelled');
    expect(result.tasks).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// --- progress log -----------------------------------------------------------------------

describe('progress log', () => {
  it('appends one valid record per event, without prompts, answers, sources, URLs or paths', async () => {
    const server = await fake();
    const path = join(tmp(), 'progress.jsonl');
    await run(fakeOptions({ progressPath: path }), server);
    const text = readFileSync(path, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines[0]).toMatch(/"type":"bench-start"/);
    expect(lines.at(-1)).toMatch(/"type":"bench-end","at":"[^"]+","complete":true/);
    expect(lines.filter((l) => l.includes('"type":"call"'))).toHaveLength(12);
    for (const forbidden of [
      'Lindholm',
      'lighthouse',
      'Task:',
      'fixture.example',
      'http',
      tmpdir(),
      'research assistant',
      'Bearer',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(readProgress(path)).toMatchObject({
      complete: true,
      tasksStarted: 2,
      tasksEnded: 2,
      unfinishedTask: null,
    });
  });

  it('a run cut off mid-way is reported as incomplete, with the last completed step', async () => {
    const server = await fake();
    const path = join(tmp(), 'progress.jsonl');
    await run(fakeOptions({ progressPath: path }), server);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    // Simulate a power-off during the first task: 5 records, plus half of the next line.
    const cut = `${lines.slice(0, 5).join('\n')}\n${(lines[5] ?? '').slice(0, 25)}`;
    writeFileSync(path, cut);
    const summary = readProgress(path);
    expect(summary).toMatchObject({ complete: false, started: true, invalidLines: 1 });
    expect(summary.stopReason).toMatch(/terminated/);
    expect(summary.lastCompleted).not.toBeNull();
    expect(summary.unfinishedTask).not.toBeNull();
  });

  it('rejects records with fields outside the allow-list', () => {
    const log = openProgressLog(null);
    expect(() =>
      log.write({
        type: 'call',
        at: 'x',
        task: 0,
        engine: 'adk',
        call: 1,
        step: 'plan',
        ok: false,
        errorCode: 'Model did not return valid JSON (got: "secret")' as never,
        wallMs: 1,
        ollamaTotalMs: null,
        ollamaLoadMs: null,
        promptTokens: null,
        completionTokens: null,
      }),
    ).toThrow();
    expect(() =>
      log.write({
        type: 'bench-end',
        at: 'x',
        complete: true,
        stopReason: null,
        tasksCompleted: 0,
        requests: 0,
        completionTokens: 0,
        prompt: 'leak',
      } as never),
    ).toThrow();
    expect(summarizeProgress('')).toMatchObject({ complete: false, started: false });
  });

  it('writes the final summary file only for a complete run, atomically', async () => {
    const dir = tmp();
    const out = join(dir, 'summary.json');
    const ok = await benchMain(
      { BENCH_MODE: 'fake', BENCH_RUNS: '1', BENCH_WARMUP: '0', BENCH_OUT: out },
      io(),
    );
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ complete: true });
    const out2 = join(dir, 'summary2.json');
    const stopped = await benchMain(
      {
        BENCH_MODE: 'fake',
        BENCH_RUNS: '1',
        BENCH_WARMUP: '0',
        BENCH_MAX_CALLS: '2',
        BENCH_OUT: out2,
      },
      io(),
    );
    expect(stopped.exitCode).toBe(1);
    expect(() => readFileSync(out2)).toThrow();
  });
});

// --- phase 7.2.1: ADK first-load attribution ------------------------------------------------

describe('ADK first-load attribution', () => {
  const once = (first: () => Promise<void>) => {
    let calls = 0;
    return () => (calls++ === 0 ? first() : Promise.resolve());
  };

  it('waiting (I/O, scanning) shows as wall time with a low CPU share; the cached call is near zero', async () => {
    const t = await measureAdkLoad(once(() => new Promise((r) => setTimeout(r, 300))));
    expect(t.wallMs).toBeGreaterThanOrEqual(290);
    expect(t.cpuShare).toBeLessThan(0.5);
    expect(t.cachedCallMs).toBeLessThan(50);
  });

  it('computing shows as a high CPU share', async () => {
    const t = await measureAdkLoad(
      once(() => {
        const end = performance.now() + 200;
        let x = 0;
        while (performance.now() < end) x += Math.sqrt(x + 1);
        return Promise.resolve();
      }),
    );
    expect(t.wallMs).toBeGreaterThanOrEqual(195);
    expect(t.cpuShare).toBeGreaterThan(0.5);
  });

  it('the runner measures the load once, before the first task, and keeps it out of task and call timings', async () => {
    const server = await fake();
    const progress = openProgressLog(null);
    const loads: number[] = [];
    const result = await runBenchmark(fakeOptions(), {
      ollama: loadOllamaConfig({ OLLAMA_HOST: server.host }),
      progress,
      loadAdk: once(async () => {
        loads.push(Date.now());
        await new Promise((r) => setTimeout(r, 500));
      }),
    });
    expect(loads).toHaveLength(1);
    expect(result.adkLoad.wallMs).toBeGreaterThanOrEqual(490);
    expect(result.adkFirstLoadMs).toBe(result.adkLoad.wallMs);
    const types = progress.records.map((r) => r.type);
    expect(types.indexOf('adk-load')).toBeLessThan(types.indexOf('task-start'));
    for (const task of result.tasks) expect(task.taskMs).toBeLessThan(result.adkLoad.wallMs);
    expect(summarize(result).adkLoad).toEqual(result.adkLoad);
  });
});
