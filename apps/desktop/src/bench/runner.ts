/**
 * Bounded, strictly sequential Research benchmark runner (phase 7.2).
 *
 * Runs the real Research step machine (createAgentRuntime) with each engine
 * on fixture sources, one task at a time. Every model request passes through
 * a guard that enforces, before the request is sent:
 * - at most one request in flight (sequential execution);
 * - the request budget (BENCH_MAX_CALLS);
 * - the completion-token budget (reserving each request's maxTokens, so the
 *   budget cannot be exceeded even if every answer uses all of it);
 * - a per-request deadline, on top of the workflow's own model deadline.
 * Per-task and overall deadlines cancel the running task. Any budget, deadline,
 * failure or cancellation stops the whole benchmark: nothing is retried or
 * re-run, and no option increases the workload.
 *
 * Software deadlines are best effort. They cannot protect against a
 * hardware-, firmware- or driver-level system freeze.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdkRuntime } from '@rka/adk-runtime';
import { createAgentRuntime, createSourceStore, type TaskModelConfig } from '@rka/agent-runtime';
import {
  createOllamaProvider,
  isModelProviderError,
  type GenerateRequest,
  type ModelProvider,
  type OllamaConfig,
} from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import {
  createToolRegistry,
  createWebTools,
  type FetchedDocument,
  type WebFetcher,
  type WebSearchProvider,
} from '@rka/tools';
import { researchTaskModelsFor, type ResearchEngine } from '@rka/agent-host';
import { BENCH_RESEARCH_LIMITS, computeWorkload, type BenchOptions } from './plan.js';
import { type ProgressLog } from './progress.js';

// --- fixture web (no live websites) ---------------------------------------------------

export const FIXTURE_PAGES: Readonly<Record<string, { title: string; text: string }>> = {
  'https://fixture.example/lighthouse-history': {
    title: 'The Lindholm lighthouse',
    text:
      'The Lindholm lighthouse was built in 1872 on the northern cape. ' +
      'Its light could be seen from 22 nautical miles away. ' +
      'The lighthouse was automated in 1968 and the last keeper left in 1969.',
  },
  'https://fixture.example/lighthouse-today': {
    title: 'Lindholm lighthouse today',
    text:
      'Today the Lindholm lighthouse is a museum that opens from May to September. ' +
      'The tower is 31 metres tall and has 140 steps.',
  },
};
export const BENCH_GOAL = 'When was the Lindholm lighthouse built, and what is it used for today?';

function fixtureWeb() {
  const searchProvider: WebSearchProvider = {
    id: 'searxng',
    checkHealth: () => Promise.reject(new Error('unused')),
    search: () =>
      Promise.resolve(
        Object.entries(FIXTURE_PAGES).map(([url, page]) => ({
          title: page.title,
          url,
          snippet: page.text.slice(0, 80),
          engines: ['fixture'],
          publishedAt: null,
        })),
      ),
  };
  const fetcher: WebFetcher = {
    fetch: (url): Promise<FetchedDocument> => {
      const page = FIXTURE_PAGES[url];
      if (!page) return Promise.reject(new Error('not a fixture page'));
      return Promise.resolve({
        requestedUrl: url,
        finalUrl: url,
        canonicalUrl: url,
        redirects: [],
        status: 200,
        kind: 'html',
        contentType: 'text/html',
        byteLength: page.text.length,
        sha256: 'b'.repeat(64),
        retrievedAt: '2026-11-13T10:00:00.000Z',
        title: page.title,
        text: page.text,
        truncated: false,
        metadata: {},
        timings: { downloadMs: 1, extractMs: 1 },
      });
    },
  };
  return { searchProvider, fetcher };
}

// --- results ----------------------------------------------------------------------------

export class BenchStopError extends Error {
  override readonly name = 'BenchStopError';
}

const STEP_LABELS = new Set([
  'create-plan',
  'extract-evidence',
  'compare-findings',
  'write-report',
  'review-report',
]);
const STEP_OF: Record<string, 'plan' | 'evidence' | 'analyze' | 'report' | 'review'> = {
  'create-plan': 'plan',
  'extract-evidence': 'evidence',
  'compare-findings': 'analyze',
  'write-report': 'report',
  'review-report': 'review',
};
/** The step a request belongs to, from its "Task: ..." label. The prompt itself is never kept. */
const stepOf = (request: GenerateRequest) => {
  const label = /^Task: ([a-z-]+)/m.exec(
    request.messages.find((m) => m.role === 'user')?.content ?? '',
  )?.[1];
  return label && STEP_LABELS.has(label) ? (STEP_OF[label] ?? 'unknown') : 'unknown';
};
/** Fingerprint of the original prompt (system + first user message), to recognise retries. */
const promptKey = (request: GenerateRequest) =>
  createHash('sha256')
    .update(JSON.stringify(request.messages.slice(0, 2)))
    .digest('hex');

export interface CallResult {
  readonly step: string;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly wallMs: number;
  readonly ollamaTotalMs: number | null;
  readonly ollamaLoadMs: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly retry: boolean;
}

export interface TaskResult {
  readonly index: number;
  readonly engine: ResearchEngine;
  readonly warmup: boolean;
  readonly run: number;
  readonly status: string;
  readonly completedAllSteps: boolean;
  readonly taskMs: number;
  readonly calls: readonly CallResult[];
  readonly http: Readonly<Record<string, number>>;
}

export interface BenchResult {
  readonly complete: boolean;
  readonly stopReason: string | null;
  /** Wall time of the first loadAdkRuntime() call (kept for compatibility; = adkLoad.wallMs). */
  readonly adkFirstLoadMs: number;
  readonly adkLoad: AdkLoadTiming;
  readonly tasks: readonly TaskResult[];
  readonly requests: number;
  readonly completionTokensReserved: number;
  readonly maxInflight: number;
  /** Fake mode: per measured run, whether both engines sent identical requests. */
  readonly parity: readonly { readonly run: number; readonly identical: boolean }[];
}

export interface RunnerDeps {
  readonly ollama: OllamaConfig;
  readonly progress: ProgressLog;
  /** Abort to cancel the benchmark (e.g. Ctrl+C). */
  readonly signal?: AbortSignal;
  /** Fake mode: the server's recorded chat bodies, for the parity check. */
  readonly chatBodies?: readonly unknown[];
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Bound on waiting for a cancelled task to settle. */
  readonly cleanupGraceMs?: number;
  /** Provider transport options (live mode: trusted ngrok hosts from the environment). */
  readonly transport?: { readonly ngrokBypassHosts?: readonly string[] };
  /** ADK loader (default loadAdkRuntime). Injected in tests. */
  readonly loadAdk?: () => Promise<unknown>;
}

/**
 * The one-time ADK load, measured before the first task so it never counts in
 * task or per-call timings. In an unbundled checkout (Vitest, this benchmark)
 * the first call imports @google/adk and its dependency graph from
 * node_modules (about 1,800–1,900 module files); in the Electron app the same
 * code is a single pre-bundled chunk. cpuShare (process CPU time / wall time)
 * tells computing from waiting: a low share means the time went to disk,
 * antivirus scanning or file-system filters, not to ADK code.
 */
export interface AdkLoadTiming {
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  /** (user + system CPU) / wall. Process-wide, so it can exceed 1. */
  readonly cpuShare: number;
  /** File-system reads reported by the OS for this process during the load (0 where unsupported). */
  readonly fsReads: number;
  /** A second loadAdkRuntime() call: the cached, steady-state cost. */
  readonly cachedCallMs: number;
}

/** Measures one call of `load` (wall and CPU time, file reads), then a cached second call. */
export async function measureAdkLoad(load: () => Promise<unknown>): Promise<AdkLoadTiming> {
  const cpu0 = process.cpuUsage();
  const fs0 = process.resourceUsage().fsRead;
  const t0 = performance.now();
  await load();
  const wallMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const fsReads = process.resourceUsage().fsRead - fs0;
  const t1 = performance.now();
  await load();
  const cachedCallMs = performance.now() - t1;
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    wallMs: r(wallMs),
    cpuUserMs: r(cpu.user / 1000),
    cpuSystemMs: r(cpu.system / 1000),
    cpuShare: wallMs > 0 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100) / 100 : 0,
    fsReads,
    cachedCallMs: r(cachedCallMs),
  };
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const at = () => new Date().toISOString();
const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const isLoopback = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
};

export async function runBenchmark(o: BenchOptions, deps: RunnerDeps): Promise<BenchResult> {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? defaultSleep;
  const workload = computeWorkload(o);
  const progress = deps.progress;

  const halted = new AbortController();
  let stopReason: string | null = null;
  let current: { cancel: () => void } | null = null;
  const halt = (reason: string) => {
    if (stopReason === null) stopReason = reason;
    current?.cancel();
    halted.abort();
  };
  const onExternalAbort = () => halt('cancelled');
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (deps.signal?.aborted) halt('cancelled');
  const overallTimer = setTimeout(() => halt('overall-deadline'), o.overallTimeoutMs);

  const budget = { requests: 0, tokens: 0, inflight: 0, maxInflight: 0 };
  const results: TaskResult[] = [];
  const parity: { run: number; identical: boolean }[] = [];
  const bodiesByTask = new Map<number, unknown[]>();

  // Count every HTTP request by method and path (no URLs, hosts or bodies are kept).
  let http: Record<string, number> = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}`;
    http[key] = (http[key] ?? 0) + 1;
    return realFetch(input, init);
  };

  let adkLoad: AdkLoadTiming;
  const root = mkdtempSync(join(tmpdir(), 'rka-bench-'));
  try {
    progress.write({
      type: 'bench-start',
      at: at(),
      mode: o.mode === 'live' ? 'live' : 'fake',
      model: deps.ollama.model.slice(0, 200),
      serverIsLocal: isLoopback(deps.ollama.baseUrl),
      tasks: workload.tasks,
      maxRequests: workload.bounded.maxAttempts,
      maxCompletionTokens: workload.bounded.maxCompletionTokens,
      requestTimeoutMs: o.requestTimeoutMs,
      taskTimeoutMs: o.taskTimeoutMs,
      overallTimeoutMs: o.overallTimeoutMs,
      cooldownMs: o.cooldownMs,
      modelRetries: o.modelRetries,
    });
    // ADK's one-time load (CPU only, no model), measured apart from the steady state.
    adkLoad = await measureAdkLoad(deps.loadAdk ?? loadAdkRuntime);
    progress.write({ type: 'adk-load', at: at(), ...adkLoad });
    log(
      `[bench] ADK first load ${String(adkLoad.wallMs)} ms (CPU ${String(adkLoad.cpuShare)} of wall), cached call ${String(adkLoad.cachedCallMs)} ms`,
    );

    for (const [index, item] of workload.order.entries()) {
      if (stopReason !== null) break;
      if (index > 0 && o.cooldownMs > 0) {
        log(`[bench] cooldown ${String(o.cooldownMs)} ms`);
        await sleep(o.cooldownMs, halted.signal);
        if (stopReason !== null) break;
      }
      http = {};
      const bodiesBefore = deps.chatBodies?.length ?? 0;
      const result = await runTask(index, item);
      results.push(result);
      if (deps.chatBodies) bodiesByTask.set(index, deps.chatBodies.slice(bodiesBefore));
      if (stopReason === null && result.status !== 'completed') halt(`task-${result.status}`);
      log(
        `[bench] task ${String(index + 1)}/${String(workload.tasks)} ${item.engine}: ${result.status}`,
      );
    }

    // Request parity per measured run (fake mode): same requests from both engines?
    if (deps.chatBodies) {
      const norm = (b: unknown[] | undefined) =>
        JSON.stringify(b ?? []).replace(/source [0-9a-f]{8}\]/g, 'source ID]');
      for (const run of new Set(results.filter((r) => !r.warmup).map((r) => r.run))) {
        const pair = results.filter((r) => !r.warmup && r.run === run);
        const legacy = pair.find((r) => r.engine === 'legacy');
        const adk = pair.find((r) => r.engine === 'adk');
        if (legacy && adk) {
          parity.push({
            run,
            identical: norm(bodiesByTask.get(legacy.index)) === norm(bodiesByTask.get(adk.index)),
          });
        }
      }
    }
  } finally {
    clearTimeout(overallTimer);
    deps.signal?.removeEventListener('abort', onExternalAbort);
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }

  const complete = stopReason === null && results.length === workload.tasks;
  progress.write({
    type: 'bench-end',
    at: at(),
    complete,
    stopReason,
    tasksCompleted: results.filter((r) => r.status === 'completed').length,
    requests: budget.requests,
    completionTokens: budget.tokens,
  });
  return {
    complete,
    stopReason,
    adkFirstLoadMs: adkLoad.wallMs,
    adkLoad,
    tasks: results,
    requests: budget.requests,
    completionTokensReserved: budget.tokens,
    maxInflight: budget.maxInflight,
    parity,
  };

  async function runTask(
    index: number,
    item: { engine: ResearchEngine; warmup: boolean; run: number },
  ): Promise<TaskResult> {
    const dir = mkdtempSync(join(root, 'task-'));
    const storage = openStorage({ path: join(dir, 'bench.db') });
    const calls: CallResult[] = [];
    let lastFailedKey: string | null = null;
    let taskTimer: NodeJS.Timeout | undefined;
    const started = performance.now();
    progress.write({
      type: 'task-start',
      at: at(),
      index,
      engine: item.engine,
      warmup: item.warmup,
      run: item.run,
    });
    let id: string | null = null;
    let runtime: ReturnType<typeof createAgentRuntime> | null = null;
    try {
      const provider = createOllamaProvider(deps.ollama, deps.transport ?? {});
      const base = researchTaskModelsFor(provider, {
        readFlag: () => item.engine,
        log: () => undefined,
      });
      const guard = (inner: ModelProvider): ModelProvider =>
        Object.assign(Object.create(inner) as ModelProvider, {
          generate: async (
            request: GenerateRequest,
            options: Parameters<ModelProvider['generate']>[1] = {},
          ) => {
            const step = stepOf(request);
            const key = promptKey(request);
            const reserve = request.options?.maxTokens ?? Number.POSITIVE_INFINITY;
            if (stopReason !== null) throw new BenchStopError(`Benchmark stopped (${stopReason}).`);
            if (budget.inflight > 0) {
              halt('concurrency-violation');
              throw new BenchStopError(
                'A second model request was attempted while one was running.',
              );
            }
            if (budget.requests + 1 > o.maxCalls) {
              halt('request-budget');
              throw new BenchStopError('Request budget reached.');
            }
            if (budget.tokens + reserve > o.maxCompletionTokens) {
              halt('token-budget');
              throw new BenchStopError('Completion-token budget reached.');
            }
            const retry = lastFailedKey === key;
            budget.requests++;
            budget.tokens += reserve;
            budget.inflight++;
            budget.maxInflight = Math.max(budget.maxInflight, budget.inflight);
            const signal = AbortSignal.any([
              ...(options.signal ? [options.signal] : []),
              AbortSignal.timeout(o.requestTimeoutMs),
              halted.signal,
            ]);
            const t0 = performance.now();
            const record = (c: Omit<CallResult, 'step' | 'wallMs' | 'retry'>) => {
              const call: CallResult = { step, wallMs: performance.now() - t0, retry, ...c };
              calls.push(call);
              progress.write({
                type: 'call',
                at: at(),
                task: index,
                engine: item.engine,
                call: calls.length,
                step: step as 'plan',
                ok: c.ok,
                errorCode: c.errorCode,
                wallMs: Math.round(call.wallMs),
                ollamaTotalMs: c.ollamaTotalMs,
                ollamaLoadMs: c.ollamaLoadMs,
                promptTokens: c.promptTokens,
                completionTokens: c.completionTokens,
              });
            };
            try {
              const result = await inner.generate(request, { ...options, signal });
              // Release the unused part of the reservation (keep it when the count is unknown).
              if (result.usage.completionTokens !== null) {
                budget.tokens += result.usage.completionTokens - reserve;
              }
              lastFailedKey = null;
              record({
                ok: true,
                errorCode: null,
                ollamaTotalMs: result.usage.totalDurationMs,
                ollamaLoadMs: result.usage.loadDurationMs,
                promptTokens: result.usage.promptTokens,
                completionTokens: result.usage.completionTokens,
              });
              return result;
            } catch (error) {
              lastFailedKey = key;
              record({
                ok: false,
                errorCode: isModelProviderError(error)
                  ? error.code
                  : error instanceof BenchStopError
                    ? 'bench-stopped'
                    : 'failed',
                ollamaTotalMs: null,
                ollamaLoadMs: null,
                promptTokens: null,
                completionTokens: null,
              });
              throw error;
            } finally {
              budget.inflight--;
            }
          },
        });
      const web = fixtureWeb();
      runtime = createAgentRuntime({
        modelProvider: provider,
        tools: createToolRegistry(createWebTools({ ...web, store: createSourceStore(storage) })),
        storage,
        taskModels: {
          capture: base.capture,
          providerFor: (captured: TaskModelConfig) => guard(base.providerFor(captured)),
        },
      });
      const rt = runtime;
      const outcome = await rt.tasks.startResearch({
        goal: BENCH_GOAL,
        limits: {
          ...BENCH_RESEARCH_LIMITS,
          modelRetries: o.modelRetries,
          modelTimeoutMs: o.requestTimeoutMs,
          retryBackoffMs: 500,
        },
      });
      if (!outcome.ok) {
        halt('start-refused');
        return finish('start-refused', false);
      }
      const taskId = outcome.task.id;
      id = taskId;
      current = { cancel: () => rt.tasks.cancel(taskId) };
      if (stopReason !== null) current.cancel();
      taskTimer = setTimeout(() => halt('task-deadline'), o.taskTimeoutMs);
      await rt.tasks.whenIdle();
      const steps = storage.steps.listByTask(taskId);
      const status = storage.tasks.require(taskId).status;
      return finish(
        status,
        steps.length > 0 && steps.every((s) => s.status === 'completed' || s.status === 'skipped'),
      );
    } finally {
      clearTimeout(taskTimer);
      current = null;
      // Best-effort cleanup: cancel anything still running, wait a bounded time, release everything.
      if (runtime && id && storage.tasks.require(id).status === 'running') {
        runtime.tasks.cancel(id);
        await Promise.race([
          runtime.tasks.whenIdle(),
          sleep(deps.cleanupGraceMs ?? 15_000, new AbortController().signal),
        ]);
      }
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }

    function finish(status: string, completedAllSteps: boolean): TaskResult {
      const mem = process.memoryUsage();
      const sum = (f: (c: CallResult) => number | null) =>
        calls.some((c) => f(c) !== null) ? calls.reduce((a, c) => a + (f(c) ?? 0), 0) : null;
      const chat = http['POST /api/chat'] ?? 0;
      const result: TaskResult = {
        index,
        engine: item.engine,
        warmup: item.warmup,
        run: item.run,
        status,
        completedAllSteps,
        taskMs: performance.now() - started,
        calls: [...calls],
        http: { ...http },
      };
      progress.write({
        type: 'task-end',
        at: at(),
        index,
        engine: item.engine,
        status: status.slice(0, 40),
        stopReason,
        completedAllSteps,
        taskMs: Math.round(result.taskMs),
        modelCalls: calls.filter((c) => !c.retry).length,
        modelAttempts: calls.length,
        retries: calls.filter((c) => c.retry).length,
        chatRequests: chat,
        otherRequests: Object.entries(http).reduce(
          (a, [k, v]) => (k === 'POST /api/chat' ? a : a + v),
          0,
        ),
        promptTokens: sum((c) => c.promptTokens),
        completionTokens: sum((c) => c.completionTokens),
        ollamaTotalMs: sum((c) => c.ollamaTotalMs),
        rssMb: mb(mem.rss),
        heapUsedMb: mb(mem.heapUsed),
        systemFreeMb: mb(freemem()),
      });
      return result;
    }
  }
}

// --- statistics -----------------------------------------------------------------------------

export function stats(values: readonly number[]) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    if (v.length === 0) return NaN;
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return (v[lo] ?? 0) + ((v[hi] ?? 0) - (v[lo] ?? 0)) * (i - lo);
  };
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    n: v.length,
    median: r(q(0.5)),
    p25: r(q(0.25)),
    p75: r(q(0.75)),
    min: r(v[0] ?? NaN),
    max: r(v.at(-1) ?? NaN),
  };
}

/** Per-engine summary of measured, fully completed tasks only. */
export function summarize(result: BenchResult) {
  const measured = (e: ResearchEngine) =>
    result.tasks.filter(
      (t) => !t.warmup && t.engine === e && t.status === 'completed' && t.completedAllSteps,
    );
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (x ?? 0), 0);
  const engine = (e: ResearchEngine) => {
    const tasks = measured(e);
    const okCalls = tasks.flatMap((t) => t.calls.filter((c) => c.ok));
    return {
      tasks: tasks.length,
      taskMs: stats(tasks.map((t) => t.taskMs)),
      modelWallMs: stats(tasks.map((t) => sum(t.calls.map((c) => c.wallMs)))),
      ollamaTotalMs: stats(tasks.map((t) => sum(t.calls.map((c) => c.ollamaTotalMs)))),
      ollamaLoadMs: stats(tasks.map((t) => sum(t.calls.map((c) => c.ollamaLoadMs)))),
      clientOverheadPerCallMs: stats(
        okCalls
          .filter((c) => c.ollamaTotalMs !== null)
          .map((c) => c.wallMs - (c.ollamaTotalMs ?? 0)),
      ),
      promptTokens: stats(tasks.map((t) => sum(t.calls.map((c) => c.promptTokens)))),
      completionTokens: stats(tasks.map((t) => sum(t.calls.map((c) => c.completionTokens)))),
      callsPerTask: stats(tasks.map((t) => t.calls.length)),
      retries: sum(tasks.map((t) => t.calls.filter((c) => c.retry).length)),
      extraHttp: tasks.filter((t) => (t.http['POST /api/chat'] ?? 0) !== t.calls.length).length,
    };
  };
  // Equivalent workloads only: per measured run, did both engines produce the same per-step token counts?
  const equivalentRuns = [...new Set(result.tasks.filter((t) => !t.warmup).map((t) => t.run))].map(
    (run) => {
      const pair = result.tasks.filter((t) => !t.warmup && t.run === run);
      const shape = (e: ResearchEngine) =>
        JSON.stringify(
          pair.find((t) => t.engine === e)?.calls.map((c) => [c.step, c.completionTokens]) ?? null,
        );
      return { run, sameStepsAndTokens: shape('legacy') === shape('adk') };
    },
  );
  return {
    complete: result.complete,
    stopReason: result.stopReason,
    adkFirstLoadMs: Math.round(result.adkFirstLoadMs),
    adkLoad: result.adkLoad,
    requests: result.requests,
    maxInflight: result.maxInflight,
    legacy: engine('legacy'),
    adk: engine('adk'),
    equivalentRuns,
    parity: result.parity,
  };
}
