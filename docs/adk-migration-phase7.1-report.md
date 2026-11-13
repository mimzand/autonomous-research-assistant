# ADK Migration — Phase 7.1 Report

> **Superseded for benchmarking by Phase 7.2.** Two Windows hard freezes occurred while the live benchmark
> command in §5 was running on the development laptop. Do not run it. The benchmark is now
> safe by default; see `docs/benchmark-safety.md` and `docs/adk-migration-phase7.2-report.md`.

_Windows acceptance, performance baseline and recovery hardening. Date: 2026-11-13._

**Code changes:** tests and tooling only. Production code is unchanged:

- no change to Chat, Research, the ADK runtime, storage, IPC, preload or renderer;
- defaults are still `AGENT_ENGINE=legacy` and `RESEARCH_ENGINE=legacy`.

**Added:**

- a reproducible engine benchmark;
- a read-only database acceptance report;
- six recovery and error-integrity tests;
- a Windows acceptance checklist.

**The measured ADK client overhead** is under 1 ms per model call. It does not explain the
user's 73 s vs 108 s run; the benchmark on the user's machine will show where that time
goes (§5).

**Windows GUI acceptance is pending:** this environment cannot run Windows Electron.

## 1. Windows development verification

**Status: pending (manual).**

The only machine bridge available here is a Linux VM. It cannot run Windows Electron and
cannot reach the user's Ollama (blocked by the network allowlist).

`docs/windows-acceptance-phase7.1.md` is the repeatable checklist (rows D1–D15). It covers:

- `pnpm dev` with legacy Chat and Research;
- ADK Chat: streaming, history and Stop;
- ADK Research end to end;
- pause and resume, and cancel during generation;
- restart recovery, and changing the Research flag after a task was created;
- that the two flags are independent;
- return to the defaults.

**What each row records:** the expected main-process log line (`Chat engine: …`,
`Research engine for the new task: …`), the UI result, and a read-only database check.

**Before starting:** back up the data folder. The checklist explains how.

## 2. Windows packaged-app verification

**Status: pending (manual).**

Checklist rows P1–P10 cover the `pnpm package:win` build. The app is started with its
stdout and stderr captured, the engine flags are set in `settings.env`, and the rows
include:

- recovery after quitting during a model step;
- the Storage integrity check and backup;
- rollback to the defaults.

**Linux packaged app (done here).** Electron 44.10.1:

| Run                                        | Results                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default                                    | Ollama request log identical to the baseline.                                                                                                                                                            |
| `AGENT_ENGINE=adk` + `RESEARCH_ENGINE=adk` | Request log identical to the Phase 6 ADK run. Chat (single-turn, multi-turn, cancel), the persistence task and the integrity check all pass. Connections only to 127.0.0.1. Renderer API keys unchanged. |

A full Research task cannot run in the packaged app here: it needs SearXNG and public
pages, and `fetch_source` refuses loopback addresses.

## 3. Research recovery results

All tests below are deterministic and run on both engines where relevant. They use the real
step machine, SQLite files and HTTP to a fake Ollama.

| Check                                                  | Result                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-Phase 7 task, restarted with `RESEARCH_ENGINE=adk` | Stays on legacy (Phase 7 test).                                                                                                                                                                                                                            |
| ADK task across pause, Retry and restart               | Stays on ADK, including when the flag changed to legacy (Phase 7 tests).                                                                                                                                                                                   |
| **New:** stored input is never rewritten               | For pre-Phase 7, legacy and ADK tasks, `task.input` is byte-identical before and after a crash, a restart with the opposite flag and Resume.                                                                                                               |
| **New:** unknown pin (`"adk-v2"`) fails closed         | The task fails with "started with the research engine "adk-v2" … not run with a different engine". No `/api/chat` request on any engine. Input untouched. No report.                                                                                       |
| **New:** crash during review, then recovery            | Sources, report and accepted usage rows are identical to an uninterrupted run, on both engines.                                                                                                                                                            |
| **New:** read-only `pnpm acceptance:db`                | Reports the engine pin per task, step counts, sources, reports, accepted usage, completed steps with duplicate usage, unfinished ADK tasks, ADK session-table counts and `quick_check`. Tested: it does not change the file and prints no goal or content. |

## 4. Engine pinning and downgrade analysis

**Pinning.** The pin is stored in the task's model-configuration snapshot
(`input.model.config.researchEngine`):

- It is written once, when the task starts, and never rewritten (tested).
- Absent means legacy.
- An unknown value fails closed (tested).

**Downgrade to pre-Phase 7 code** (documented and tested). Phase 6 code, through
`taskModelsFor`, ignores the unknown key:

- An unfinished ADK-pinned task resumes **on legacy**.
- The pin stays stored.
- The task data format is the same on both engines, so nothing is corrupted.

The test "documents downgrade behaviour" runs the Phase 6 wiring against an ADK-pinned task
and confirms this.

**Is a safe downgrade guard feasible without a migration?** Not per task. The options
examined:

| Option                                                      | Verdict                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change the `provider` or `url` fields of ADK captures       | Ineffective: old code rebuilds the provider from `config` only.                                                                                                                                                                                                                                     |
| Make ADK `config` invalid for old code                      | Unsafe: old code then **silently falls back to the current settings**, which is worse.                                                                                                                                                                                                              |
| Make `input.model` fail `TaskModelConfigSchema` in old code | Fails closed for model calls. But old code parses the task input in many places (limits, progress, recovery info, dashboard), so it could break the old UI for that task. That is invasive and changes the stored format our own code must read. Rejected.                                          |
| Add an empty migration `0003_*`                             | Older versions already refuse a database that has a migration they do not know ("refuses a database created by a newer app version"). It would block downgrade for the **whole** database, including legacy-only users. It is a schema/migration change, so it needs approval. **Not implemented.** |

**Recommendation:**

- Keep the documented procedure: before downgrading, finish or cancel the tasks that
  `pnpm acceptance:db` lists under `summary.unfinishedAdkTasks`.
- If a hard guard is wanted, approve the `0003` marker migration as a separate,
  deliberate change.

## 5. Performance benchmark

**Command:** `pnpm bench:research:ollama`
(`apps/desktop/src/main/research-benchmark.live.test.ts`, opt-in, live config only).

**Setup:**

- **Settings:** same model and generation settings for both engines (the task's provider
  snapshot).
- **Sources:** two fixture pages (no live websites).
- **Database:** a fresh temporary one per run.

**Run order:**

- `BENCH_WARMUP` warm-up runs per engine, which are discarded. The first warm-up of each
  engine is reported separately.
- Then `BENCH_RUNS` measured runs per engine, alternating the order (L,A / A,L / …).
- ADK's first-use load time is measured separately.

**Recorded per run:**

- task wall time;
- per-call wall time around `provider.generate`;
- Ollama-reported `total_duration` and `load_duration`;
- prompt and completion tokens (from `model_usage`);
- model-step attempts (retries);
- every HTTP request, by method and path.

**Derived values:**

- client overhead per call = call wall time − Ollama `total_duration`;
- non-model time = task time − Σ model calls.

**Checks:**

- every run completes;
- `POST /api/chat` count equals the number of model calls (no extra calls or hidden
  retries).

**Output:** a JSON file (`BENCH_OUT`) with timings and counts only. No prompt or answer
text is logged.

**Results here, fake Ollama** (`BENCH_FAKE=1`; isolates client-side cost). 2 warm-ups and
10 measured runs per engine, 6 model calls per task, Linux:

| Fake latency per call | Engine | Task median (p25–p75), ms | Model wall median, ms | Overhead per call median (p25–p75), ms | Calls / attempts | HTTP per run              |
| --------------------- | ------ | ------------------------- | --------------------- | -------------------------------------- | ---------------- | ------------------------- |
| 0 ms                  | legacy | 63.3 (62.4–65.4)          | 22.2                  | 3.2 (3.1–3.6)                          | 6 / 6            | 6 chat, 7 version, 1 tags |
| 0 ms                  | adk    | 68.6 (67.1–71.2)          | 25.8                  | 3.7 (3.7–4.2)                          | 6 / 6            | identical                 |
| 200 ms                | legacy | 1272.8 (1268.9–1280.7)    | 1221.8                | 3.3 (2.9–3.9)                          | 6 / 6            | identical                 |
| 200 ms                | adk    | 1279.4 (1274.5–1284.8)    | 1226.4                | 4.2 (3.6–5.1)                          | 6 / 6            | identical                 |

**Findings:**

- **Per-call cost.** ADK adds about **0.5–0.9 ms per model call**, roughly 4–7 ms per
  6-call task. That is ADK's agent, runner and in-memory session setup plus event handling.
- **HTTP traffic** is identical. Neither engine makes extra requests or retries.
  `GET /api/version` once per call is the provider's existing structured-output version
  check, the same for both engines.
- **First use.** Loading ADK takes 0.5–0.7 s once per process. In the app, the startup
  self-check already pays this, off the Chat and Research path.

**The user's 73.36 s (legacy) vs 108.05 s (ADK) run.** A 34.7 s gap over about 6–7 model
calls is roughly 5 s per call. That is about four orders of magnitude more than the
measured client overhead.

Both engines send byte-identical requests for identical inputs (Phase 7 tests). Likely
model-side explanations, none of them confirmed yet:

- **Different output length.** The prompts differ slightly between two tasks (random
  source ids, and evidence that depends on the earlier answers), so the model can answer at
  different lengths.
- **Ollama scheduling or model reload** between the two tasks.
- **Single-run variance.**

**To confirm:** run
`$env:BENCH_RUNS="5"; $env:BENCH_WARMUP="1"; $env:BENCH_OUT="$env:USERPROFILE\Desktop\rka-bench.json"; pnpm bench:research:ollama`.
Each call's wall time sits next to Ollama's own `total_duration` and token counts:

- If ADK's extra time shows up as more completion tokens or a larger `total_duration`, it
  is model-side.
- If it shows up as wall time minus `total_duration`, it is client-side.

## 6. Security regression results

| Check                                           | Result                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No model-driven tools in Chat or Research       | Guard tests pass. Requests carry no `tools`. A model tool call is rejected, never executed.                                                                                      |
| Research tools code-controlled                  | Identical searches and fetches through the step machine's `ToolRegistry`. `agent-runtime` never imports ADK (guard).                                                             |
| No autonomous ADK tool execution                | `RegistryTool` is wired nowhere in production (guard).                                                                                                                           |
| No cloud LLM or telemetry                       | Environment sanitised, `OTEL_SDK_DISABLED`. `fetch` reaches only Ollama (tests). The packaged app connects only to 127.0.0.1.                                                    |
| No unsafe executors reachable                   | Facade allowlist unchanged. The bundle contains no code-executor, `LocalEnvironment`, MikroORM or Vertex session modules. `child_process` comes only from `google-auth-library`. |
| No new IPC, renderer or preload exposure        | None changed. Renderer API keys identical in the packaged run.                                                                                                                   |
| No ADK session persistence for Chat or Research | `adk_*` tables stay empty (tests, plus `acceptance:db` on the packaged run's database).                                                                                          |
| Phase 4.1 tool-outcome integrity                | The `outcomes.runner` tests pass. The allowlist guard limits which modules may read function calls or the final text.                                                            |
| Benchmark and acceptance tooling not shipped    | Neither appears in the main bundle. The acceptance script opens the database read-only.                                                                                          |

## 7. Automated and live test results

| Check                      | Result                                        |
| -------------------------- | --------------------------------------------- |
| `pnpm typecheck`           | pass                                          |
| `pnpm lint`                | pass                                          |
| `pnpm format:check`        | pass                                          |
| `pnpm test`                | pass: 68 files, 913 tests (Phase 7: 67 / 906) |
| `pnpm build`               | pass                                          |
| `pnpm package:dir` (Linux) | pass                                          |
| `pnpm package:win`         | pending (Windows)                             |

**Cancellation and error integrity, retested.** Each case is checked for: no output stored,
no accepted usage row, no report, and the same classification on both engines.

| Case                                            | Evidence                                                      |
| ----------------------------------------------- | ------------------------------------------------------------- |
| Abort before the request                        | Phase 7 test                                                  |
| Abort during generation                         | Phase 7 test                                                  |
| Abort during streaming Chat                     | Phase 6 tests                                                 |
| Timeout with a successful retry                 | Phase 7 test                                                  |
| **Timeout until the retry budget is exhausted** | New test                                                      |
| Invalid JSON                                    | Phase 7 test                                                  |
| Schema validation failure                       | Phase 7 test                                                  |
| Model missing or unavailable                    | Phase 7 tests                                                 |
| **Connection dropped mid-request**              | New test                                                      |
| Shutdown during a step                          | Phase 7 crash tests, plus the new no-duplicates recovery test |

The ADK "last event is partial" warning stays as documented in Phase 6: it is logged only
after a mid-stream Chat abort, and the result is still `cancelled`. Warnings are not
suppressed globally.

**Live tests** (opt-in; commands unchanged): `pnpm test:research:ollama`,
`pnpm test:chat:ollama`, `pnpm test:adk:ollama`. The user reported 6/6, 10/10 and 14/14 on
Windows with Ollama 0.40.14 and qwen3:8b; no new run was possible here. The live benchmark
(`pnpm bench:research:ollama`) is pending on Windows.

## 8. Code changes

**Created:**

| File                                                    | Purpose                                                   |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `apps/desktop/src/main/research-benchmark.live.test.ts` | The benchmark (live config only; not run by `pnpm test`). |
| `packages/storage/scripts/acceptance-db.mjs`            | Read-only database acceptance report.                     |
| `packages/storage/src/acceptance-db.test.ts`            | Test for that script.                                     |
| `docs/windows-acceptance-phase7.1.md`                   | Windows acceptance checklist.                             |
| `docs/adk-migration-phase7.1-report.md`                 | This report.                                              |

**Modified:**

| File                                                        | Change                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/research-engine.integration.test.ts` | Six audit tests: input never rewritten, unknown pin fails closed, downgrade behaviour, timeout exhaustion, dropped connection, recovery without duplicates. |
| `package.json`                                              | `bench:research:ollama` and `acceptance:db` scripts.                                                                                                        |

**Production code:** none changed.

## 9. Remaining blockers

1. **Windows GUI acceptance** (checklist D1–D15 and P1–P10) for Phases 6, 7 and 7.1.
2. **Live benchmark on the user's machine.** It explains the 73 s vs 108 s run; the
   expected outcome is model-side variance.
3. **Downgrade guard:** only procedural so far. A hard guard needs an approved
   `0003` marker migration.
4. `pnpm package:win` has not been run in this environment.

## 10. Readiness for Phase 8

**Not ready yet; conditionally ready once blockers 1 and 2 are cleared.**

**Ready:**

- The engine infrastructure works: identical requests and stored data, pinned and
  recoverable tasks, fail-closed unknown pins.
- No measurable client overhead.
- Security guards intact.

**Required before Phase 8 enables any production model-driven tools or removes a legacy
engine:**

1. **Windows acceptance:** Windows D/P checklists all PASS, especially restart recovery
   (D13/D14, P7) and rollback (D15, P9).
2. **Benchmark:** the live benchmark shows no client-side overhead and attributes the
   earlier gap.
3. **Downgrade policy:** a decision on the policy, either the procedure or the marker
   migration.

**Keep the legacy engines as the default and the rollback path through Phase 8.**
