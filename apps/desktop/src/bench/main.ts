/**
 * Benchmark entry (phase 7.2). `pnpm bench:research:ollama` calls this through
 * a Vitest live file. Safe by default: without BENCH_MODE it only prints the
 * safety notice and the planned workload; nothing contacts Ollama.
 */
import { renameSync, writeFileSync } from 'node:fs';
import {
  loadOllamaConfig,
  ollamaTransportOptionsFromEnv,
  type OllamaConfig,
} from '@rka/model-provider';
import { startFakeOllama, type FakeOllama } from './fake-ollama.js';
import { describePlan, parseBenchOptions } from './plan.js';
import { openProgressLog } from './progress.js';
import { runBenchmark, summarize, type BenchResult } from './runner.js';

export interface BenchIo {
  log(line: string): void;
  error(line: string): void;
}

export async function benchMain(
  env: Record<string, string | undefined>,
  io: BenchIo,
  options: { signal?: AbortSignal; handleSignals?: boolean } = {},
): Promise<{ exitCode: number; result?: BenchResult }> {
  const parsed = parseBenchOptions(env);
  if (!parsed.ok) {
    io.error('Research benchmark: refusing to run.');
    for (const e of parsed.errors) io.error(`  - ${e}`);
    io.error('See docs/benchmark-safety.md. Nothing was run.');
    return { exitCode: 2 };
  }
  const o = parsed.options;
  // Live mode reads OLLAMA_HOST/OLLAMA_MODEL; fake mode ignores them entirely.
  const liveConfig = o.mode === 'live' ? loadOllamaConfig(env) : null;
  io.log(describePlan(o, liveConfig?.model ?? 'n/a'));
  if (o.mode === 'plan') return { exitCode: 0 };

  const progress = openProgressLog(o.progressPath);
  let fake: FakeOllama | undefined;
  const controller = new AbortController();
  const onSignal = () => {
    io.error('Research benchmark: cancelling (signal received)…');
    controller.abort();
  };
  const forward = () => controller.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  if (options.handleSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  try {
    let config: OllamaConfig;
    if (o.mode === 'fake') {
      fake = await startFakeOllama({ latencyMs: o.fakeLatencyMs });
      config = loadOllamaConfig({ OLLAMA_HOST: fake.host });
    } else {
      config = liveConfig as OllamaConfig;
    }
    const result = await runBenchmark(o, {
      ollama: config,
      ...(o.mode === 'live' && {
        transport: { ngrokBypassHosts: ollamaTransportOptionsFromEnv(env).ngrokBypassHosts },
      }),
      progress,
      signal: controller.signal,
      ...(fake && { chatBodies: fake.chatBodies }),
      log: io.log,
    });
    const summary = summarize(result);
    io.log(
      `[bench] ${result.complete ? 'complete' : `INCOMPLETE (${result.stopReason ?? 'unknown'})`}`,
    );
    io.log(`[bench] ${JSON.stringify(summary)}`);
    const out = env['BENCH_OUT']?.trim();
    if (out && result.complete) {
      // Atomic: a reader never sees a half-written summary.
      writeFileSync(`${out}.tmp`, `${JSON.stringify(summary, null, 2)}\n`);
      renameSync(`${out}.tmp`, out);
    }
    return { exitCode: result.complete ? 0 : 1, result };
  } finally {
    options.signal?.removeEventListener('abort', forward);
    if (options.handleSignals) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    progress.close();
    await fake?.close();
  }
}
