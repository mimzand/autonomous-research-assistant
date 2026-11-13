/**
 * Research benchmark options and workload (phase 7.2).
 *
 * Two Windows hard freezes happened while the phase 7.1 benchmark ran a long,
 * continuous Ollama workload. This module makes every benchmark run explicit:
 * - `plan` (default): prints the workload and exits. No network, no model.
 * - `fake`: a deterministic in-process fake Ollama. Never contacts Ollama,
 *   never loads a model; measures client-side overhead and request parity.
 * - `live`: real Ollama, only with an explicit acknowledgement and explicit
 *   values for every workload limit. There are no live workload defaults.
 */
import { z } from 'zod';

export const BENCH_MODES = ['plan', 'fake', 'live'] as const;
export type BenchMode = (typeof BENCH_MODES)[number];

/** Exact value BENCH_LIVE_ACKNOWLEDGE must have for live mode. */
export const LIVE_ACKNOWLEDGEMENT = 'I-accept-the-risk-of-a-system-freeze';

/*
 * Research limits the benchmark task uses, and what the step machine does with
 * them (agent-runtime/src/research/workflow.ts and schemas.ts; a test checks
 * these numbers against the source).
 */
export const BENCH_RESEARCH_LIMITS = {
  maxQuestions: 1,
  maxQueriesPerQuestion: 1,
  maxSources: 2,
} as const;
/** maxTokens (num_predict) of each model call site. */
export const MAX_TOKENS = {
  plan: 900,
  evidence: 1200,
  analyze: 1500,
  report: 2000,
  review: 800,
} as const;
/** ReportDraftSchema: summary ≤ 4 paragraphs, ≤ 6 sections × ≤ 6 paragraphs; review batches of 8. */
export const MAX_REPORT_PARAGRAPHS = 4 + 6 * 6;
export const REVIEW_BATCH = 8;

const posInt = z.coerce.number().int().positive();
const nonNegInt = z.coerce.number().int().nonnegative();

/** Hard ceilings: no option can exceed these, in any mode. */
export const CEILINGS = {
  fake: { runs: 50, warmup: 5 },
  live: {
    runs: 3,
    warmup: 1,
    maxCalls: 60,
    maxCompletionTokens: 100_000,
    requestTimeoutMs: 300_000,
    taskTimeoutMs: 900_000,
    overallTimeoutMs: 3_600_000,
    modelRetries: 1,
  },
  /** Live runs must rest at least this long between tasks. */
  minLiveCooldownMs: 30_000,
} as const;

export interface BenchOptions {
  readonly mode: BenchMode;
  readonly runs: number;
  readonly warmup: number;
  readonly maxCalls: number;
  readonly maxCompletionTokens: number;
  readonly requestTimeoutMs: number;
  readonly taskTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly cooldownMs: number;
  /** Extra attempts after a failed model call. 0 = no automatic retries. */
  readonly modelRetries: number;
  /** Fake mode only: simulated generation time per call. */
  readonly fakeLatencyMs: number;
  /** Append-only JSONL progress file (null: no file). */
  readonly progressPath: string | null;
}

export type ParseResult =
  | { readonly ok: true; readonly options: BenchOptions }
  | { readonly ok: false; readonly mode: BenchMode; readonly errors: readonly string[] };

const LIVE_REQUIRED = [
  'BENCH_RUNS',
  'BENCH_MAX_CALLS',
  'BENCH_MAX_COMPLETION_TOKENS',
  'BENCH_REQUEST_TIMEOUT_MS',
  'BENCH_TASK_TIMEOUT_MS',
  'BENCH_OVERALL_TIMEOUT_MS',
  'BENCH_COOLDOWN_MS',
] as const;

/** Parses BENCH_* variables. Invalid or out-of-range values are errors, never clamped. */
export function parseBenchOptions(env: Record<string, string | undefined>): ParseResult {
  const errors: string[] = [];
  const modeRaw = (env['BENCH_MODE'] ?? 'plan').trim().toLowerCase();
  const mode = (BENCH_MODES as readonly string[]).includes(modeRaw) ? (modeRaw as BenchMode) : null;
  if (!mode) {
    return {
      ok: false,
      mode: 'plan',
      errors: [`BENCH_MODE must be one of ${BENCH_MODES.join(', ')}.`],
    };
  }

  const read = (
    name: string,
    schema: z.ZodType<number>,
    fallback: number | undefined,
    max?: number,
  ) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      if (fallback === undefined) errors.push(`${name} must be set explicitly for ${mode} mode.`);
      return fallback ?? 0;
    }
    const parsed = schema.safeParse(raw.trim());
    if (!parsed.success) {
      errors.push(`${name}=${JSON.stringify(raw.slice(0, 20))} is not a valid number.`);
      return 0;
    }
    if (max !== undefined && parsed.data > max) {
      errors.push(`${name}=${String(parsed.data)} exceeds the ceiling ${String(max)}.`);
    }
    return parsed.data;
  };

  if (mode === 'live') {
    if (env['BENCH_LIVE_ACKNOWLEDGE'] !== LIVE_ACKNOWLEDGEMENT) {
      errors.push(`Live mode needs BENCH_LIVE_ACKNOWLEDGE=${LIVE_ACKNOWLEDGEMENT}.`);
    }
    const missing = LIVE_REQUIRED.filter((n) => !env[n]?.trim());
    if (missing.length > 0)
      errors.push(`Live mode has no workload defaults; set ${missing.join(', ')}.`);
    const c = CEILINGS.live;
    const options: BenchOptions = {
      mode,
      runs: read('BENCH_RUNS', posInt, undefined, c.runs),
      warmup: read('BENCH_WARMUP', nonNegInt, 0, c.warmup),
      maxCalls: read('BENCH_MAX_CALLS', posInt, undefined, c.maxCalls),
      maxCompletionTokens: read(
        'BENCH_MAX_COMPLETION_TOKENS',
        posInt,
        undefined,
        c.maxCompletionTokens,
      ),
      requestTimeoutMs: read('BENCH_REQUEST_TIMEOUT_MS', posInt, undefined, c.requestTimeoutMs),
      taskTimeoutMs: read('BENCH_TASK_TIMEOUT_MS', posInt, undefined, c.taskTimeoutMs),
      overallTimeoutMs: read('BENCH_OVERALL_TIMEOUT_MS', posInt, undefined, c.overallTimeoutMs),
      cooldownMs: read('BENCH_COOLDOWN_MS', nonNegInt, undefined),
      modelRetries: read('BENCH_MODEL_RETRIES', nonNegInt, 0, c.modelRetries),
      fakeLatencyMs: 0,
      progressPath: env['BENCH_PROGRESS']?.trim() || null,
    };
    if (env['BENCH_COOLDOWN_MS']?.trim() && options.cooldownMs < CEILINGS.minLiveCooldownMs) {
      errors.push(
        `BENCH_COOLDOWN_MS must be at least ${String(CEILINGS.minLiveCooldownMs)} in live mode.`,
      );
    }
    if (options.requestTimeoutMs < 1000)
      errors.push('BENCH_REQUEST_TIMEOUT_MS must be at least 1000.');
    return errors.length > 0 ? { ok: false, mode, errors } : { ok: true, options };
  }

  // plan and fake: deterministic, no model. Defaults are safe because nothing reaches Ollama.
  const options: BenchOptions = {
    mode,
    runs: read('BENCH_RUNS', posInt, 5, CEILINGS.fake.runs),
    warmup: read('BENCH_WARMUP', nonNegInt, 1, CEILINGS.fake.warmup),
    maxCalls: read('BENCH_MAX_CALLS', posInt, 10_000),
    maxCompletionTokens: read('BENCH_MAX_COMPLETION_TOKENS', posInt, 10_000_000),
    requestTimeoutMs: read('BENCH_REQUEST_TIMEOUT_MS', posInt, 10_000),
    taskTimeoutMs: read('BENCH_TASK_TIMEOUT_MS', posInt, 60_000),
    overallTimeoutMs: read('BENCH_OVERALL_TIMEOUT_MS', posInt, 900_000),
    cooldownMs: read('BENCH_COOLDOWN_MS', nonNegInt, 0),
    modelRetries: read('BENCH_MODEL_RETRIES', nonNegInt, 0, 3),
    fakeLatencyMs: read('BENCH_FAKE_LATENCY_MS', nonNegInt, 0, 10_000),
    progressPath: env['BENCH_PROGRESS']?.trim() || null,
  };
  if (options.requestTimeoutMs < 1000)
    errors.push('BENCH_REQUEST_TIMEOUT_MS must be at least 1000.');
  return errors.length > 0 ? { ok: false, mode, errors } : { ok: true, options };
}

export interface Workload {
  readonly tasks: number;
  readonly order: readonly {
    readonly engine: 'legacy' | 'adk';
    readonly warmup: boolean;
    readonly run: number;
  }[];
  readonly perTask: {
    readonly typicalCalls: number;
    readonly maxCalls: number;
    readonly maxAttempts: number;
    readonly maxCompletionTokens: number;
  };
  /** Before the call and token budgets are applied. */
  readonly scheduled: { readonly maxAttempts: number; readonly maxCompletionTokens: number };
  /** After the budgets: the most the benchmark will ever request. */
  readonly bounded: { readonly maxAttempts: number; readonly maxCompletionTokens: number };
  readonly worstCaseWallMs: number;
}

/** Exact workload of a configuration (the same arithmetic the runner enforces). */
export function computeWorkload(
  o: Pick<
    BenchOptions,
    | 'runs'
    | 'warmup'
    | 'modelRetries'
    | 'maxCalls'
    | 'maxCompletionTokens'
    | 'requestTimeoutMs'
    | 'taskTimeoutMs'
    | 'overallTimeoutMs'
    | 'cooldownMs'
  >,
): Workload {
  const order: { engine: 'legacy' | 'adk'; warmup: boolean; run: number }[] = [];
  for (let i = 0; i < o.warmup; i++)
    order.push({ engine: 'legacy', warmup: true, run: i }, { engine: 'adk', warmup: true, run: i });
  for (let i = 0; i < o.runs; i++) {
    const pair = i % 2 === 0 ? (['legacy', 'adk'] as const) : (['adk', 'legacy'] as const);
    for (const engine of pair) order.push({ engine, warmup: false, run: i });
  }
  const sources = BENCH_RESEARCH_LIMITS.maxSources;
  const reviewCalls = Math.ceil(MAX_REPORT_PARAGRAPHS / REVIEW_BATCH);
  const maxCalls = 1 + sources + 1 + 1 + reviewCalls;
  const typicalCalls = 1 + sources + 1 + 1 + 1;
  const attempts = 1 + o.modelRetries;
  const tokensOnce =
    MAX_TOKENS.plan +
    sources * MAX_TOKENS.evidence +
    MAX_TOKENS.analyze +
    MAX_TOKENS.report +
    reviewCalls * MAX_TOKENS.review;
  const tasks = order.length;
  const scheduledAttempts = tasks * maxCalls * attempts;
  const scheduledTokens = tasks * tokensOnce * attempts;
  const perTaskWall = Math.min(o.taskTimeoutMs, maxCalls * attempts * o.requestTimeoutMs);
  return {
    tasks,
    order,
    perTask: {
      typicalCalls,
      maxCalls,
      maxAttempts: maxCalls * attempts,
      maxCompletionTokens: tokensOnce * attempts,
    },
    scheduled: { maxAttempts: scheduledAttempts, maxCompletionTokens: scheduledTokens },
    bounded: {
      maxAttempts: Math.min(scheduledAttempts, o.maxCalls),
      maxCompletionTokens: Math.min(scheduledTokens, o.maxCompletionTokens),
    },
    worstCaseWallMs: Math.min(
      o.overallTimeoutMs,
      tasks * perTaskWall + Math.max(0, tasks - 1) * o.cooldownMs,
    ),
  };
}

/** The workload of the phase 7.1 benchmark (unbounded original design) for the given runs. */
export function originalBenchmarkWorkload(runs: number, warmup: number) {
  const w = computeWorkload({
    runs,
    warmup,
    modelRetries: 1,
    maxCalls: Number.MAX_SAFE_INTEGER,
    maxCompletionTokens: Number.MAX_SAFE_INTEGER,
    requestTimeoutMs: 300_000,
    taskTimeoutMs: Number.MAX_SAFE_INTEGER,
    overallTimeoutMs: Number.MAX_SAFE_INTEGER,
    cooldownMs: 0,
  });
  return {
    tasks: w.tasks,
    typicalCalls: w.tasks * w.perTask.typicalCalls,
    maxAttempts: w.scheduled.maxAttempts,
    maxCompletionTokens: w.scheduled.maxCompletionTokens,
    /** Each attempt could wait up to the 300 s model deadline; only Vitest's 1 h test timeout bounded the run, and it does not cancel work. */
    worstCaseAttemptWaitMs: w.scheduled.maxAttempts * 300_000,
  };
}

export function describePlan(o: BenchOptions, model: string): string {
  const w = computeWorkload(o);
  const min = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
  return [
    '='.repeat(78),
    'RESEARCH BENCHMARK — SAFETY NOTICE',
    'Two complete Windows hard freezes happened while the previous version of this',
    'benchmark ran a long, continuous Ollama workload on this kind of laptop. A',
    'software deadline cannot prevent a hardware- or driver-level freeze.',
    '='.repeat(78),
    `Mode: ${o.mode}${o.mode === 'plan' ? ' (nothing is run)' : ''}`,
    `Model: ${o.mode === 'fake' ? 'none (deterministic fake Ollama, no GPU)' : model}`,
    `Research tasks: ${String(w.tasks)} (${String(o.warmup)} warm-up + ${String(o.runs)} measured per engine, alternating order, strictly sequential)`,
    `Model calls per task: typically ${String(w.perTask.typicalCalls)}, at most ${String(w.perTask.maxCalls)}; retries per call: ${String(o.modelRetries)}`,
    `Scheduled maximum: ${String(w.scheduled.maxAttempts)} model requests, ${String(w.scheduled.maxCompletionTokens)} completion tokens`,
    `Enforced budget: ${String(w.bounded.maxAttempts)} requests, ${String(w.bounded.maxCompletionTokens)} completion tokens`,
    `Deadlines: ${String(o.requestTimeoutMs)} ms per request, ${String(o.taskTimeoutMs)} ms per task, ${String(o.overallTimeoutMs)} ms overall (worst case ${min(w.worstCaseWallMs)})`,
    `Cooldown between tasks: ${String(o.cooldownMs)} ms`,
    o.mode === 'plan'
      ? [
          '(The figures above describe BENCH_MODE=fake with these settings.)',
          (() => {
            const prev = originalBenchmarkWorkload(o.runs, o.warmup);
            return `For comparison, the phase 7.1 version scheduled ${String(prev.tasks)} live tasks: about ${String(prev.typicalCalls)} and up to ${String(prev.maxAttempts)} model requests, up to ${String(prev.maxCompletionTokens)} completion tokens, with no request, token, task or overall budget.`;
          })(),
          '',
          'To measure client-side overhead without any model or GPU work (recommended):',
          '  $env:BENCH_MODE="fake"; pnpm bench:research:ollama',
          'Live mode is NOT recommended on this machine. It requires BENCH_MODE=live,',
          `BENCH_LIVE_ACKNOWLEDGE=${LIVE_ACKNOWLEDGEMENT} and explicit values for`,
          `${LIVE_REQUIRED.join(', ')}. See docs/benchmark-safety.md.`,
        ].join('\n')
      : '',
    '='.repeat(78),
  ]
    .filter((l) => l !== '')
    .join('\n');
}
