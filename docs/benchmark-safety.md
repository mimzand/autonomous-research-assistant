# Research Benchmark — Safety, Modes and Incident Diagnostics

> Two complete Windows hard freezes happened on the development laptop while the
> phase 7.1 benchmark ran a long, continuous Ollama workload. The laptop has an RTX 3060
> Laptop GPU with 6 GB, about 32 GB RAM, NVIDIA driver 621.01, Ollama 0.40.14 and
> qwen3:8b. The cause is **not known**.
>
> The benchmark is now safe by default. A software deadline **cannot** prevent a
> hardware-, firmware- or driver-level freeze.

## Modes

| Command                                              | What it does                                                                                                                                                                                 | GPU / model |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `pnpm bench:research:ollama`                         | Prints the safety notice and the exact planned workload, then exits. Contacts nothing.                                                                                                       | none        |
| `$env:BENCH_MODE="fake"; pnpm bench:research:ollama` | **Recommended.** The real Research step machine with both engines against a deterministic in-process fake Ollama. Measures client overhead and checks request parity. Ignores `OLLAMA_HOST`. | none        |
| `BENCH_MODE=live` plus acknowledgement and limits    | Real Ollama. **Not recommended on this machine.**                                                                                                                                            | yes         |

### Fake mode options

All are optional:

| Variable                | Default | Meaning                               |
| ----------------------- | ------- | ------------------------------------- |
| `BENCH_RUNS`            | 5       | Measured runs per engine (at most 50) |
| `BENCH_WARMUP`          | 1       | Warm-up runs per engine (at most 5)   |
| `BENCH_FAKE_LATENCY_MS` | 0       | Simulated generation time per call    |
| `BENCH_PROGRESS`        | —       | JSONL progress file                   |
| `BENCH_OUT`             | —       | Final summary file                    |

### Live mode

All of the following are required. There are **no live workload defaults**, values are
never clamped, and out-of-range values are refused:

| Variable                      | Requirement                                        |
| ----------------------------- | -------------------------------------------------- |
| `BENCH_MODE`                  | `live`                                             |
| `BENCH_LIVE_ACKNOWLEDGE`      | exactly `I-accept-the-risk-of-a-system-freeze`     |
| `BENCH_RUNS`                  | ≤ 3 (and optionally `BENCH_WARMUP` ≤ 1; default 0) |
| `BENCH_MAX_CALLS`             | ≤ 60 model requests in total                       |
| `BENCH_MAX_COMPLETION_TOKENS` | ≤ 100,000 in total                                 |
| `BENCH_REQUEST_TIMEOUT_MS`    | ≤ 300,000 per request                              |
| `BENCH_TASK_TIMEOUT_MS`       | ≤ 900,000 per task                                 |
| `BENCH_OVERALL_TIMEOUT_MS`    | ≤ 3,600,000 overall                                |
| `BENCH_COOLDOWN_MS`           | ≥ 30,000 between tasks                             |
| `BENCH_MODEL_RETRIES`         | optional, 0 (default) or 1                         |

The model and server come from `OLLAMA_HOST` and `OLLAMA_MODEL`.

## Guarantees (enforced in code, unit-tested)

**Execution:**

- **Strictly sequential.** One Research task at a time, one model request at a time. A
  second concurrent request stops the benchmark.
- **Budgets checked before each request.** The request budget and the completion-token
  budget are checked first. The request's whole `maxTokens` is reserved in advance, so the
  token budget cannot be exceeded even if every answer is as long as allowed.
- **Deadlines.** Per request (also the workflow's own model deadline), per task (cancels
  the task) and overall (cancels the task in progress).
- **Cooldown** between tasks; cancellation interrupts it.
- **No automatic retries** (`modelRetries: 0`) unless explicitly set. Retries are reported
  per call.

**Stopping:**

- Any budget, deadline, failed task, refused start or cancellation **stops the whole
  benchmark**. Nothing is re-run.
- Ctrl+C (SIGINT/SIGTERM) cancels the running task. Its HTTP request to Ollama is
  closed, and temporary databases are closed and deleted.
- Best effort: if the process is killed hard, the operating system closes its sockets.

**Results:**

- **Progressive results.** `BENCH_PROGRESS` is an append-only JSONL file. Each record
  (start, call, task end, end) is written and fsync'ed immediately.
- Records come from an allow-list of numbers, timestamps, engine, step, status and error
  codes. They never contain prompts, answers, page text, URLs, paths, headers or error
  messages.
- A run without a `bench-end` record is **incomplete**. The final summary (`BENCH_OUT`) is
  written atomically, and **only** for a complete run.

## The ADK first-load figure (`adkLoad`)

The fake and live modes measure the first `loadAdkRuntime()` call once, before any task,
so it never counts in task or per-call timings. The result is reported as `adkLoad` and in
an `adk-load` progress record:

| Field          | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `wallMs`       | Wall time of the first load (`adkFirstLoadMs` is the same value).         |
| `cpuUserMs`    | Process CPU time in user mode during the load.                            |
| `cpuSystemMs`  | Process CPU time in kernel mode during the load.                          |
| `cpuShare`     | `(user + system CPU) / wall`. Process-wide, so it can exceed 1.           |
| `fsReads`      | File-system reads reported by the OS (0 where the OS does not report it). |
| `cachedCallMs` | A second, cached call: the steady state, about 0.                         |

**What the figure measures.** In this unbundled checkout, the first load imports
`@google/adk` and its whole dependency graph from `node_modules`: about 1,800–1,900 module
files, including about 640 from `lodash-es`. The Electron app instead loads the same code
as one pre-bundled chunk.

**How to read `cpuShare`:**

- **High (about 1 or more):** the time went to parsing and running JavaScript.
- **Low:** the time went to waiting: disk, antivirus scanning or file-system filters.

**Diagnostic.** `pnpm diag:adk-load` imports only the package in a fresh Node process. It
calls no ADK API and runs no model. It reports wall time, CPU share, module count, time
per module and the cached re-import. Run it twice in a row to compare a cold load with a
warm one.

## Optional read-only monitoring (Windows)

`scripts\windows\monitor-system.ps1` samples every 10 s (minimum 5 s) and writes CSV lines
with write-through. It records:

- with `nvidia-smi`: GPU utilization, memory, temperature, power, SM clock and P-state;
- available RAM and total CPU %;
- the working sets of Ollama and Node.

It does **not** record CPU temperature, because Windows has no reliable built-in sensor for
it. It changes nothing on the system. Run it in a second PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\monitor-system.ps1 -OutFile "$env:USERPROFILE\Desktop\rka-monitor.csv"
```

**Useful read-only Ollama checks** (no inference):

- `ollama ps`: the `PROCESSOR` column shows whether the loaded model is 100% on the GPU or
  split between CPU and GPU.
- `%LOCALAPPDATA%\Ollama\server.log`: model load lines show how many layers were offloaded
  to the GPU and how much VRAM was used.

## After a freeze or unexpected shutdown

1. **Reliability Monitor:** run `perfmon /rel` and note the time of the "Windows was not
   properly shut down" entry.
2. **Event Viewer** (`eventvwr.msc` → Windows Logs → System), around that time:

   | Event                                             | What to look for                                                                                                                                         |
   | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **Kernel-Power 41**                               | Open it and check `BugcheckCode`. `0` means no blue screen was recorded: a hard hang or a power-off. A non-zero code means a bugcheck; check for a dump. |
   | **EventLog 6008**                                 | The previous shutdown was unexpected (a consequence, not a cause).                                                                                       |
   | **Kernel-Processor-Power 37**                     | Firmware limited the CPU speed (thermal or power limit). Note how often and when it appears before the incident.                                         |
   | **WHEA-Logger** (e.g. 17, 18, 19, 47)             | Hardware errors (CPU, PCIe, memory).                                                                                                                     |
   | **nvlddmkm** (e.g. 13, 14, 153), **Display 4101** | The GPU driver stopped responding, or recovered (TDR).                                                                                                   |

   Or, read-only from PowerShell:

   ```powershell
   Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = (Get-Date).AddDays(-2) } |
     Where-Object { $_.ProviderName -match 'Kernel-Power|EventLog|Kernel-Processor-Power|WHEA|nvlddmkm|Display' } |
     Select-Object TimeCreated, ProviderName, Id, LevelDisplayName |
     Format-Table -AutoSize
   ```

3. **Dumps:**
   - `C:\Windows\Minidump`: present only if a bugcheck was written.
   - `C:\Windows\LiveKernelReports` (for example `WATCHDOG`): GPU driver timeouts are often
     recorded here even without a blue screen.
4. **Data:**
   - the last lines of the `BENCH_PROGRESS` file, which show the last completed model call;
   - the monitor CSV, if it was running.

## What the old benchmark did (phase 7.1)

The command was `BENCH_RUNS=5`, `BENCH_WARMUP=1`. It scheduled:

- **12 sequential Research tasks**, each engine with 1 warm-up and 5 measured runs;
- about **72 model requests** typically (6 per task), and up to **240** (10 calls per task
  × 2 attempts);
- up to **259,200** completion tokens;
- no request, token, task or overall budget, and no cooldown;
- a 300 s deadline per request, with one retry;
- an outer bound only from Vitest's one-hour test timeout, which does not cancel running
  work.

At the measured 73–108 s per task, that is roughly **15–22 minutes of near-continuous
inference**. Both freezes happened after about 5 minutes, which is around the third or
fourth task.
