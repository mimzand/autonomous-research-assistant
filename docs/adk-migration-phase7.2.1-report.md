# ADK Migration — Phase 7.2.1 Report

_Why the Windows fake benchmark reported `adkFirstLoadMs: 41646`. Date: 2026-11-13._

**Answer.** The 41.6 s is a correct measurement of **loading ADK's unbundled dependency
graph from `node_modules`**: about 1,800–1,900 module files, read and evaluated by Node in
the Vitest test process. In other words:

- It is **not** time spent waiting on something unrelated.
- It is **not** ADK's runtime initialisation.
- It is **not** steady-state overhead.
- It does **not** represent the Electron app, which loads ADK as one pre-bundled 2.6 MB
  chunk.

On Linux the same load takes 0.4–0.8 s, or 0.25–0.75 ms per file. On the Windows machine it
took about 22 ms per file. That points to a **per-file cost on Windows**. The most common
causes are real-time antivirus scanning (Microsoft Defender) and file-system filters on the
first open of each file, plus Windows path resolution through pnpm's links. This is a
**hypothesis, not yet verified on the machine**; §4 says how to confirm it, read-only.

**Safety:** no real Ollama, no GPU or CPU stress, no live benchmark. No production code,
defaults or Windows settings were changed.

## 1. How `adkFirstLoadMs` was measured (code inspection)

In `apps/desktop/src/bench/runner.ts` (phase 7.2), once per benchmark, after the
`bench-start` record and before the first task:

```ts
const t0 = performance.now();
await loadAdkRuntime();
adkFirstLoadMs = performance.now() - t0;
```

`loadAdkRuntime()` (`packages/adk-runtime/src/runtime.ts`) runs
`sanitizeAdkEnvironment(env)` (microseconds) and then `await import('./engine.js')`.

That dynamic import:

1. has Vitest transform the adk-runtime TypeScript modules that `engine.ts` pulls in
   (a few dozen workspace files);
2. has Node import `@google/adk`. Vitest leaves `node_modules` packages to Node
   (externalised, not transformed).

`@google/adk`'s single entry point re-exports the whole SDK, so Node loads its full graph.

**Nothing else runs in that interval:**

- The fake Ollama server is idle.
- No task has started.
- The overall-deadline timer only fires on expiry.
- The interval is one awaited call in a single-threaded runner.

So the figure contains no unrelated waiting, and it is correctly attributed to "loading
ADK". It is not included in any task or per-call timing.

## 2. What is loaded (measured on Linux)

**Source:** `strace` of the fake benchmark process, and `pnpm diag:adk-load`.

| Package (files opened during the load) | Files       |
| -------------------------------------- | ----------- |
| `lodash-es`                            | 641         |
| `@google/adk`                          | 312         |
| `@opentelemetry/*`                     | about 330   |
| `google-auth-library` (two versions)   | 95          |
| `zod-to-json-schema`                   | 41          |
| `@google-cloud/vertexai`               | 40          |
| `uuid`                                 | 39          |
| `gaxios`, `winston` and others         | rest        |
| **Total in the load window**           | **≈ 1,900** |

The diagnostic, which counts ESM plus CommonJS modules, reports **1,823 modules**.

**Further observations:**

- All opens came from one process, and none were Vite or Vitest cache files. Node loaded
  the files directly; Vite did not transform them.
- The cached second call took about 0 ms, so after the first load ADK costs nothing extra
  to obtain.

**Linux timings:**

| Measurement                                        | Wall time   | CPU share | Per module |
| -------------------------------------------------- | ----------- | --------- | ---------- |
| Fake benchmark, warm OS cache                      | 0.43–0.48 s | 1.35      | —          |
| Fake benchmark, page cache dropped (cold)          | 0.76 s      | 1.06      | —          |
| `diag:adk-load`, cold (includes the counting hook) | 1.39 s      | —         | 0.8 ms     |
| `diag:adk-load`, warm (includes the counting hook) | 0.92 s      | —         | 0.5 ms     |

On Linux the load is CPU-bound: a CPU share of about 1 or more means parsing and running
JavaScript.

## 3. Why Windows is about 50–100× slower here

Windows took 41,646 ms for about 1,820–1,900 files, which is **about 22 ms per file**.
Linux needs well under 1 ms per file for the same files. ADK's own code is identical on
both systems, so the extra cost is per file, not per unit of ADK work.

**Candidate causes (not verified):**

1. **Real-time antivirus scanning** (Defender's "Antimalware Service Executable", or any
   third-party antivirus). Each `.js` file is scanned when it is first opened. A cost of
   about 10–30 ms per small script file when cold is typical.
2. **Path resolution on Windows.** NTFS metadata and pnpm's `node_modules/.pnpm` links make
   every module resolution touch several directory entries.
3. **First-time disk reads** on a cold cache.

**Ruled out by the code:**

- Vitest transforming ADK (it is externalised).
- Concurrency.
- Unrelated work inside the timed interval.
- Repeated loads (the second call is cached).

Two other observations from the Windows run fit "Windows I/O and process overhead", not
ADK:

- **Total duration.** The whole Vitest run took about 43 s, almost all of it this one
  load. The 8 tasks themselves took about 1 s.
- **Per-call overhead.** It is 9.8 ms (legacy) and 12.1 ms (ADK) on Windows, against about
  3 ms on Linux. ADK's own share is the difference, +2.3 ms per call, which is still tiny
  next to seconds of model generation.

## 4. How to confirm on the machine (read-only, CPU-only)

1. **Run the diagnostic twice in a row.** It only imports the package, calls no ADK API
   and runs no model:

   ```powershell
   pnpm diag:adk-load
   pnpm diag:adk-load
   ```

   - **Antivirus or cold-cache cost:** low `cpuShare` (for example below 0.3) and a high
     `msPerModule` on the first run. The second run is usually much faster, because scan
     verdicts and files are cached.
   - **Antivirus scanning every open:** `cpuShare` stays low and both runs stay slow.
   - **Slow JavaScript execution** (unlikely): `cpuShare` close to 1 on a slow run.

2. **Re-run the fake benchmark.** `$env:BENCH_MODE="fake"; pnpm bench:research:ollama`
   now prints `ADK first load … ms (CPU x of wall), cached call … ms` and writes an
   `adk-load` record (wall, user and system CPU, CPU share, file reads, cached call) to the
   progress log.

3. **Optional read-only checks** (no settings changed):
   - `Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled, AMServiceEnabled`
     shows whether Defender's real-time protection is on.
   - While the diagnostic runs, Task Manager → Details: watch "MsMpEng.exe" (Antimalware
     Service Executable) for CPU.
   - Whether to add antivirus exclusions is a security decision for the machine's owner.
     This project does not change it.

## 5. Is this a genuine ADK initialisation cost?

**No.** Broken down:

| Component                               | Size                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADK runtime initialisation              | Negligible. On Linux the entire load, including parsing about 1,800 files, is 0.4–0.8 s. The production self-check of a full agent turn takes 8–14 ms in the packaged app's log.                                                                                        |
| Steady state                            | About 0 ms per later `loadAdkRuntime()` call. ADK adds 0.5 ms (Linux) to 2.3 ms (Windows) per model call.                                                                                                                                                               |
| Module loading in an unbundled checkout | **This is the 41.6 s.** It applies to Vitest and the benchmark, which load `@google/adk` from `node_modules`.                                                                                                                                                           |
| The Electron app                        | The build bundles ADK and its dependencies, tree-shaken, into **one chunk** (`out/main/chunks/engine-*.js`, 2.6 MB). The app opens one file instead of about 1,800, so this per-file cost largely does not apply. Its Windows cold load has not been measured (see §6). |

## 6. What should change

**Done in this phase** (benchmark and diagnostics only):

1. **Fine-grained load timing.** `measureAdkLoad()` (`apps/desktop/src/bench/runner.ts`)
   records wall time, user and system CPU, CPU share, OS file-read count and the cached
   second call.
   - It is still measured once, before the first task, and excluded from task and call
     statistics.
   - It is reported as `adkLoad` in the result and summary (`adkFirstLoadMs` is kept, with
     the same value) and in a new allow-listed `adk-load` progress record.
   - It is injectable for tests.
2. **`pnpm diag:adk-load`** (`packages/adk-runtime/scripts/diag-adk-load.mjs`): a
   standalone, CPU-only measurement of the module graph. It sanitises the environment
   exactly like `loadAdkRuntime()` before importing.
3. **Documentation** in `docs/benchmark-safety.md`.
4. **Behaviour unchanged.** The benchmark is still safe by default (`plan` mode runs
   nothing). Production code, Chat, Research and engine defaults are unchanged.

**Recommended, needing approval** (none is required for correctness):

1. **Measure the production load on Windows.** Log the duration of `loadAdkRuntime()` in
   the startup probe (`main/adk-probe.ts`; it currently logs only the self-check time).
   This is a one-line, log-only production change. It would show the real packaged-app
   cold load on Windows. That matters because, with `AGENT_ENGINE=adk`, a Chat request
   sent before the startup probe finishes loading ADK waits for that load.
2. **Optional, test infrastructure only.** Pre-bundle `@google/adk` for Vitest (Vitest's
   dependency optimizer), or keep ADK-heavy tests in fewer worker processes. This would
   cut the per-file cost for the test suite and the benchmark on Windows. It changes the
   test setup, so it is proposed, not done.
3. **Interpretation.** Treat `adkLoad.wallMs` as a property of the development or test
   environment, not as an ADK engine cost. The engine comparison uses the steady-state
   figures, which already exclude it.

## 7. Tests and verification

| Check               | Result                                     |
| ------------------- | ------------------------------------------ |
| `pnpm typecheck`    | pass                                       |
| `pnpm lint`         | pass                                       |
| `pnpm format:check` | pass                                       |
| `pnpm test`         | pass: 69 files, 939 tests (Phase 7.2: 936) |
| `pnpm build`        | pass                                       |

**New deterministic tests** (`apps/desktop/src/bench/bench.test.ts`):

- A load that waits shows wall time with a low CPU share, and the cached call is near 0.
- A CPU-bound load shows a high CPU share.
- The runner measures the load exactly once, writes `adk-load` before the first
  `task-start`, and keeps it out of every task timing; the summary carries `adkLoad`.

**Runs here (CPU-only):** the fake benchmark (cold and warm) and `diag:adk-load` (cold
and warm), with the results in §2.

## 8. Files changed

**Modified:**

| File                                   | Change                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `apps/desktop/src/bench/runner.ts`     | `measureAdkLoad`, `adkLoad` in the result and summary, injectable loader. |
| `apps/desktop/src/bench/progress.ts`   | Allow-listed `adk-load` record.                                           |
| `apps/desktop/src/bench/bench.test.ts` | Three attribution tests.                                                  |
| `docs/benchmark-safety.md`             | `adkLoad` and the diagnostic.                                             |
| `package.json`                         | `diag:adk-load` script.                                                   |

**Created:**

- `packages/adk-runtime/scripts/diag-adk-load.mjs`
- `docs/adk-migration-phase7.2.1-report.md`
