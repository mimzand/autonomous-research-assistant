# ADK Migration — Phase 7.2 Report

_Windows hard-freeze investigation and benchmark hardening. Date: 2026-11-13._

**Scope:** benchmark tooling, tests and documentation only.

- No production code changed: Chat, Research, the engines, the providers, storage, IPC,
  preload and renderer are all untouched.
- Defaults are unchanged: `AGENT_ENGINE=legacy`, `RESEARCH_ENGINE=legacy`.

**What was not run:**

- no live benchmark, no live test and no real Ollama inference;
- no GPU or CPU stress;
- no Windows application.

**Commands that were run:**

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`;
- the new benchmark in its default `plan` mode, which is shown to contact nothing;
- the new benchmark in `fake` mode, against an in-process fake server with no model and no
  GPU work.

## 1. Static analysis of the original benchmark (phase 7.1)

**Verified from the code:**

| #   | Question                                     | Finding                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Research tasks scheduled                     | `(BENCH_WARMUP + BENCH_RUNS) × 2`, so **12** for the user's command.                                                                                                                                                                                                                   |
| 2   | LLM calls per task                           | Limits: 1 question, 1 query, 2 sources. Calls: plan 1, evidence 2, analyze 1, report 1, review ⌈paragraphs / 8⌉, so **6 typical** and **10 at most** (a report has at most 40 paragraphs). With `modelRetries: 1`, up to **20 attempts per task**.                                     |
| 3   | Sequential or concurrent                     | **Sequential.** Each task was awaited before the next. The step machine runs one step at a time, and each step makes one model call at a time.                                                                                                                                         |
| 4   | Vitest concurrency                           | None. The filter selects one file, the live config sets `fileParallelism: false`, and the file has one non-concurrent test.                                                                                                                                                            |
| 5   | Overlapping Ollama requests                  | Not from the benchmark (confirmed in the new fake runs: at most one request open). When a deadline aborts a request, the retry starts after a 500 ms backoff. Whether Ollama keeps generating briefly after the client disconnects is Ollama-internal (**hypothesis**).                |
| 6   | Requests left active after failure or cancel | The abort closes the HTTP request (confirmed: no open requests after cancellation in the new tests). **But a failed task did not stop the benchmark**: the next task started immediately.                                                                                              |
| 7   | Can a call hang indefinitely?                | No. Each attempt had a **300 s** deadline (the workflow's default `modelTimeoutMs` and the provider's generate timeout). A hung call could still hold the GPU for 5 minutes, twice with the retry.                                                                                     |
| 8   | Shared resources between warm-up and runs    | Only the Ollama server and the loaded model. Ollama's `keep_alive` keeps the model in VRAM between requests, so the GPU stays loaded for the whole run. The benchmark kept a fresh database and provider per task, and no ADK state.                                                   |
| 9   | Resources released                           | Each task database was closed in `finally`; the temporary root was removed in `afterAll`. Providers, runners and in-memory ADK sessions are per call or per task and are garbage-collected. In the new fake runs, memory stayed flat across 24 tasks (RSS 208–227 MB, heap 95–115 MB). |
| 10  | Model residency and context                  | `num_ctx` came from the `OLLAMA_NUM_CTX` environment variable (default **4096**), not from the app's Settings. qwen3:8b (Q4, about 5 GB of weights) plus its KV cache is close to the 6 GB of VRAM; see H2.                                                                            |
| 11  | Retries multiplying the workload             | Bounded: at most ×2 (`modelRetries: 1`). No hidden retries: the provider does not retry, and ADK adds none (one request per call in every fake run).                                                                                                                                   |
| 12  | Timeout coverage                             | Per request: 300 s. **Per task: none. Overall: none**, except Vitest's 1 h test timeout. That timeout only marks the test failed: it **does not cancel the running work**, and `afterAll` could delete the temporary directory under a still-running task.                             |
| 13  | Child processes or HTTP left running         | The benchmark starts no child processes (it never uses `child_process`). On Ctrl+C or test teardown, Vitest ends the worker and the OS closes its sockets. Ollama's own runner process is Ollama's.                                                                                    |

**Other software findings:**

- Results were written only at the end (a single JSON file), so nothing survived the
  freezes.
- No cooldown between tasks.
- No request or token budget.

**Exact workload of the user's command (`BENCH_RUNS=5`, `BENCH_WARMUP=1`):**

| Measure                | Value                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| Research tasks         | 12, sequential, no pause                                              |
| Model requests         | about 72 typical; at most 240                                         |
| Completion tokens      | at most 259,200 (10,800 per task attempt set × 2 attempts × 12 tasks) |
| Expected duration      | 12 × 73–108 s ≈ **15–22 min of near-continuous GPU inference**        |
| Theoretical worst case | bounded only by the 1 h Vitest timeout, which does not stop the work  |

Both freezes happened after about 5 minutes. At the measured speeds, that is around the
third or fourth task.

This workload arithmetic is unit-tested (`originalBenchmarkWorkload(5, 1)`), and its
constants are checked against the step machine's source.

## 2. Confirmed software issues

| Issue                                                                 | Status                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A plain `pnpm bench:research:ollama` started a long live GPU workload | **Fixed:** the default is `plan` mode, which runs nothing.              |
| No request, token, task or overall budget; no cooldown                | **Fixed:** all are enforced (§4).                                       |
| A failed task did not stop the benchmark                              | **Fixed:** any failure, budget, deadline or cancellation stops it.      |
| Vitest's timeout did not cancel running work                          | **Fixed:** the runner's own deadlines cancel the task and stop the run. |
| A retry was always on (`modelRetries: 1`)                             | **Fixed:** 0 by default; when enabled, each retry is reported.          |
| Results only at the end                                               | **Fixed:** an fsync'ed JSONL progress log; incomplete runs are marked.  |
| The acceptance guide told the user to run the long live benchmark     | **Fixed:** the guide now warns and points to `fake` mode.               |

**Not found:**

- concurrency or overlapping requests;
- leaked requests or listeners;
- hidden retries;
- unbounded hangs (each attempt was capped at 300 s);
- memory growth in the benchmark process.

## 3. Software findings vs hardware hypotheses

**Verified (software):** everything in §1 and §2. The benchmark's software behaviour does
not show a mechanism, in Node or in the app, that could freeze the operating system: no
concurrency, no leaks, no runaway retries, and flat memory. What it did do was create a
long, uninterrupted inference load on the GPU (and possibly the CPU).

**Hypotheses (not verified; to be checked on the machine):**

| #   | Hypothesis                                  | Basis                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Thermal or power limit under sustained load | The fans ramped up over several minutes, and Kernel-Processor-Power 37 (firmware CPU limiting) was logged. The individual live tests (about 1.5–3 min) completed; the longer run froze at about 5 min.                                                                            |
| H2  | VRAM pressure and partial CPU offload       | About 5 GB of qwen3:8b weights plus the KV cache on a 6 GB laptop GPU that also drives the display. Ollama may offload layers to the CPU, loading both CPU and GPU. `ollama ps` (its `PROCESSOR` column) and `server.log` (offloaded layers) show this without running inference. |
| H3  | GPU driver hang without recovery            | A complete hang with no input, Kernel-Power 41 (check its `BugcheckCode`: `0` means no bugcheck was written). Look for nvlddmkm or Display 4101 events and `C:\Windows\LiveKernelReports`.                                                                                        |
| H4  | System memory pressure                      | Unlikely with about 32 GB of RAM; the benchmark process itself stays under about 230 MB.                                                                                                                                                                                          |

ADK is **not** implicated by any evidence:

- The fake benchmark shows ADK adds **0.5–0.8 ms per model call**.
- Requests are byte-identical between the engines (parity checks).
- Both engines produce the same GPU work per request.

The 73 s vs 108 s difference remains unattributed. It is most plausibly a difference in
model output or Ollama scheduling, not ADK, and it should not be investigated with live
runs on this machine.

## 4. Implemented safe benchmark

The code is in `apps/desktop/src/bench/`; the entry point is
`apps/desktop/src/main/research-benchmark.live.test.ts`. The full operating guide is
`docs/benchmark-safety.md`.

**Modes:**

| Mode             | How                                                      | Behaviour                                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan` (default) | `pnpm bench:research:ollama`                             | Prints the safety notice, the exact workload for the settings, the phase 7.1 workload for comparison, and how to opt in. Exits without contacting anything (tested with a `fetch` spy).                                                                              |
| `fake`           | `$env:BENCH_MODE="fake"`                                 | **Recommended.** The real step machine, both engines and fixture sources, against an in-process deterministic fake Ollama. It ignores `OLLAMA_HOST` (tested), loads no model and uses no GPU. Request parity and equivalence are checked per run.                    |
| `live`           | `BENCH_MODE=live`, `BENCH_LIVE_ACKNOWLEDGE=…` and limits | Requires the acknowledgement string `I-accept-the-risk-of-a-system-freeze` and **explicit** values for runs, calls, tokens, request, task and overall deadlines, and cooldown. **No live defaults.** Ceilings below; out-of-range values are refused, never clamped. |

**Live-mode ceilings:**

| Setting                | Ceiling         |
| ---------------------- | --------------- |
| Measured runs          | ≤ 3             |
| Warm-up runs           | ≤ 1             |
| Model requests         | ≤ 60            |
| Completion tokens      | ≤ 100,000       |
| Request deadline       | ≤ 300 s         |
| Task deadline          | ≤ 900 s         |
| Overall deadline       | ≤ 1 h           |
| Cooldown between tasks | ≥ 30 s          |
| Retries                | ≤ 1 (default 0) |

**Enforcement.** Every model request passes a guard that, before sending:

- refuses a second concurrent request;
- applies the request budget;
- reserves the request's whole `maxTokens` against the token budget (released down to the
  actual count afterwards), so the budget can never be exceeded;
- adds the per-request deadline.

**Other runner behaviour:**

- Per-task and overall deadlines cancel the running task.
- A cooldown runs between tasks.
- Ctrl+C cancels the run.
- Any stop condition ends the whole benchmark.
- Cleanup is best effort: cancel, wait a bounded time, close the database, delete the
  temporary files, restore `fetch`.

**Correctness of the comparison:**

- Engine order alternates; warm-ups come first.
- ADK's one-time load is measured separately.
- Client overhead is computed per call as wall time minus Ollama's `total_duration`;
  load time and tokens are recorded.
- Statistics are median, p25, p75, min and max over measured, **fully completed** tasks
  only.
- Extra HTTP requests and retries are counted.
- Each run checks whether both engines produced the same per-step token counts
  (equivalent workloads).

**Progress log** (`BENCH_PROGRESS`):

- Append-only JSONL, fsync'ed per record: `bench-start`, `task-start`, `call`, `task-end`,
  `bench-end`.
- Each record carries timestamps, engine, task and call indexes, step, wall time, Ollama
  total and load durations, tokens, the error code, request and retry counts, and process
  and free memory.
- Fields come from a Zod allow-list, so no prompts, answers, sources, URLs, paths, headers
  or error messages can be written (tested).
- A run without `bench-end` reads back as **incomplete**, with the last completed call and
  the unfinished task; a line cut off by a power loss is tolerated.
- The final summary (`BENCH_OUT`) is written atomically, **only** for complete runs.

**Fake-mode results here.** 2 warm-ups and 10 measured runs per engine, run in this
environment:

| Fake latency | Engine | Task median (p25–p75), ms | Overhead per call median (p25–p75), ms | Retries | Extra HTTP | Parity        | Max in flight |
| ------------ | ------ | ------------------------- | -------------------------------------- | ------- | ---------- | ------------- | ------------- |
| 0 ms         | legacy | 60.7 (56.3–66.0)          | 2.8 (2.7–3.1)                          | 0       | 0          | all identical | 1             |
| 0 ms         | adk    | 63.9 (61.1–68.5)          | 3.3 (3.2–3.7)                          | 0       | 0          | all identical | 1             |
| 200 ms       | legacy | 1279.9 (1272.9–1290.8)    | 3.4 (2.8–3.9)                          | 0       | 0          | all identical | 1             |
| 200 ms       | adk    | 1282.6 (1276.4–1288.3)    | 4.2 (3.4–4.6)                          | 0       | 0          | all identical | 1             |

ADK's first load took 0.43–0.45 s. These results match Phase 7.1.

## 5. Deterministic test results

| Check               | Result                                           |
| ------------------- | ------------------------------------------------ |
| `pnpm typecheck`    | pass                                             |
| `pnpm lint`         | pass                                             |
| `pnpm format:check` | pass                                             |
| `pnpm test`         | pass: 69 files, 936 tests (Phase 7.1: 68 / 913)  |
| `pnpm build`        | pass; the main bundle contains no benchmark code |

**New tests:** `apps/desktop/src/bench/bench.test.ts` (22 tests, no GPU, no model, no real
Ollama). They cover:

- **Safe default:** plan mode makes no request; live refuses without the acknowledgement or
  explicit in-range limits; nothing is clamped; fake mode ignores `OLLAMA_HOST`.
- **Workload:** the exact phase 7.1 workload (12 / 72 / 240 / 259,200); per-task maxima;
  budgets bound the workload; alternating engine order; constants checked against the
  workflow source.
- **Runner:**
  - sequential execution (at most 1 in flight, on both client and server);
  - request parity; no retries or extra HTTP;
  - the request budget and the token budget (reservation, then release);
  - per-request deadline with no retry; opt-in retry, reported;
  - task deadline; overall deadline;
  - Ctrl+C-style cancellation with request cleanup; cooldown interrupted by cancellation.
- **Progress log:** no forbidden content; incomplete runs, including a line cut off by a
  power loss; the allow-list rejects messages and extra fields; the summary file is
  written only for complete runs.

**Updated guard (`security-guards.test.ts`):** the benchmark may delete only the temporary
directories it created itself, and no app code imports `src/bench`.

## 6. Low-risk monitoring and diagnostics guide

`docs/benchmark-safety.md` describes the following (only to be used without heavy model
work during this investigation):

- **`scripts/windows/monitor-system.ps1`:** opt-in and read-only; samples every 10 s
  (minimum 5 s) and writes CSV lines with write-through. It records:
  - GPU utilization, memory, temperature, power, SM clock and P-state (via `nvidia-smi`);
  - available RAM and total CPU %;
  - Ollama and Node working sets.

  It does not record CPU temperature, because Windows has no reliable built-in sensor.

- **Read-only Ollama checks:** `ollama ps` (CPU/GPU split) and `server.log` (layer
  offload).
- **After an incident:**
  - Reliability Monitor (`perfmon /rel`);
  - Event Viewer: Kernel-Power 41 and its `BugcheckCode`, 6008, Kernel-Processor-Power 37,
    WHEA-Logger, nvlddmkm and Display 4101;
  - a read-only `Get-WinEvent` query;
  - `C:\Windows\Minidump` and `C:\Windows\LiveKernelReports`;
  - the progress JSONL and the monitor CSV.

## 7. Files changed

**Created:**

| File                                    | Purpose                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `apps/desktop/src/bench/plan.ts`        | Modes, options, ceilings, exact workload, safety notice. |
| `apps/desktop/src/bench/progress.ts`    | Allow-listed, fsync'ed JSONL log and reader.             |
| `apps/desktop/src/bench/runner.ts`      | Guarded, sequential runner; statistics.                  |
| `apps/desktop/src/bench/fake-ollama.ts` | Deterministic fake server.                               |
| `apps/desktop/src/bench/main.ts`        | Entry point (plan, fake, live).                          |
| `apps/desktop/src/bench/bench.test.ts`  | The new tests.                                           |
| `scripts/windows/monitor-system.ps1`    | Read-only monitor.                                       |
| `docs/benchmark-safety.md`              | Operating and diagnostics guide.                         |
| `docs/adk-migration-phase7.2-report.md` | This report.                                             |

**Modified:**

| File                                                    | Change                                            |
| ------------------------------------------------------- | ------------------------------------------------- |
| `apps/desktop/src/main/research-benchmark.live.test.ts` | Now a thin, safe-by-default entry point.          |
| `apps/desktop/src/main/security-guards.test.ts`         | Bench cleanup allowance; "never shipped" guard.   |
| `apps/desktop/tsconfig.node.json`                       | Includes `src/bench`.                             |
| `apps/desktop/vitest.config.ts`                         | Includes `src/bench` tests.                       |
| `docs/windows-acceptance-phase7.1.md`                   | The benchmark step now warns and uses fake mode.  |
| `docs/adk-migration-phase7.1-report.md`                 | Banner: the live benchmark command is superseded. |

**Unchanged:** all production code, prompts, schemas, defaults, IPC, preload and renderer.
The existing live test commands are kept as they are.

## 8. Remaining risks

- **The hardware cause is unknown.** No software change can prevent a hardware, firmware
  or driver freeze. Deadlines and budgets only shorten and bound the load.
- **The live tests are not budget-guarded.** `test:research:ollama`, `test:chat:ollama`
  and `test:adk:ollama` still run real inference, but they are short (a few minutes) and
  completed on this machine before.
- **Normal app use also loads the GPU.** Real Research tasks in the app put similar,
  shorter load on the GPU. If H1 or H2 holds, a long Research task in the app could stress
  the machine the same way.
- **Durability is best effort.** The fsync and write-through cannot guarantee that the
  last lines survive a hard power-off.

## 9. Recommendation

**Keep live benchmarking disabled on this machine.** Do not opt in to `BENCH_MODE=live`
until:

1. the Event Viewer checks (§6) have been done;
2. `ollama ps` and `server.log` show whether the model fits fully on the GPU;
3. the laptop's thermals have been checked: vents, cooling pad, power mode, driver health,
   all done by the user, not by this tool.

**For engine comparisons, use `BENCH_MODE=fake`.** It already answers the question
software can answer: ADK's client-side cost is under 1 ms per call, with identical
requests.

**If live data is ever needed,** use one run per engine, `BENCH_MAX_CALLS` of about 14, a
cooldown of 2 minutes or more, the monitor running, and the user present. Treat it as a
deliberate hardware test, not a routine benchmark.

**Phase 8 readiness** is unchanged from Phase 7.1. Windows GUI acceptance is still open.
For the performance question, the 0.5–0.8 ms fake-mode result is sufficient; a live
benchmark is no longer a prerequisite.
