/**
 * `pnpm bench:research:ollama` — Research engine benchmark (phase 7.2).
 *
 * SAFE BY DEFAULT: with no BENCH_MODE this prints the safety notice and the
 * planned workload, then exits without contacting Ollama. Two complete Windows
 * hard freezes happened while the phase 7.1 version ran a long live workload.
 *
 *   $env:BENCH_MODE="fake"; pnpm bench:research:ollama   (deterministic, no model, no GPU)
 *
 * Live mode needs an explicit acknowledgement and explicit limits; see
 * docs/benchmark-safety.md. The logic lives in src/bench (unit-tested).
 */
import { expect, it } from 'vitest';
import { benchMain } from '../bench/main.js';
import { parseBenchOptions } from '../bench/plan.js';

const parsed = parseBenchOptions(process.env);
const timeoutMs =
  parsed.ok && parsed.options.mode !== 'plan' ? parsed.options.overallTimeoutMs + 120_000 : 60_000;

it(
  'research benchmark (safe by default)',
  async () => {
    const { exitCode } = await benchMain(
      process.env,
      // Written directly to the terminal: Vitest may hide console output of passing tests.
      {
        log: (l) => process.stdout.write(`${l}\n`),
        error: (l) => process.stderr.write(`${l}\n`),
      },
      { handleSignals: true },
    );
    expect(exitCode).toBe(0);
  },
  timeoutMs,
);
