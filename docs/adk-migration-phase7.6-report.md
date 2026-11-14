# Phase 7.6 — Windows lifecycle & recovery acceptance

A reliability phase. All automated checks use fake models and fake HTTP responses on
temporary databases. No inference, GPU load or company endpoint was used, the real app
database was not touched, and no Windows shutdown was triggered.

## 1. Lifecycle architecture (audit)

| Area                        | Implementation                                                                                                                                                                                                                                                                                            | Status                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Startup                     | `openAppStorage` opens SQLite (migrations), then `recoverInterruptedTasks()` marks `running` tasks and steps `interrupted` in one transaction **before** any task can run. Nothing resumes automatically.                                                                                                 | correct                       |
| Normal quit                 | `will-quit` → `storage.close()`. A running task's later writes fail and are ignored. On the next start it is `interrupted` ("app-closed") and can be resumed.                                                                                                                                             | correct (documented contract) |
| Step machine                | Each step is persisted before the next starts; later steps are appended idempotently. The loop continues at the first unsettled step; completed steps cannot be started again (repository guard).                                                                                                         | correct                       |
| Status transitions          | Compare-and-set transition table. `completed`, `failed` and `cancelled` are terminal; `cancelled` has no outgoing transition.                                                                                                                                                                             | correct                       |
| Pause / Cancel              | `AbortController` per run. The signal reaches model calls (provider `fetch`, ADK), tools (`fetch_source` → HTTP client) and retry back-off sleeps. Pause interrupts the current step; Cancel fails it ("Cancelled by the user.") and cancels the task. A paused task can be cancelled without a run loop. | correct                       |
| Late answers                | An answer that arrives after Cancel/Pause is validated and checkpointed (documented contract); the loop then stops before the next step.                                                                                                                                                                  | correct                       |
| Retry                       | Only `failed` tasks. Re-queues the fatal step plus failed source steps that are still useful, in one transaction.                                                                                                                                                                                         | correct                       |
| Engine pin / model snapshot | Captured once at creation in `task.input.model`. `providerFor(captured)` is used for resume, retry and recovery, never the current Settings or environment.                                                                                                                                               | correct                       |
| Report save                 | Renders, then `reports.create` (with a version check), then the run loop completes the step **in a separate write**. A resume compares the new rendering with the latest report to avoid a second version.                                                                                                | **defect** (§2)               |
| Renderer                    | Pulls `tasks.get` (details, recovery info, pinned engine) and refreshes on progress events and Settings changes.                                                                                                                                                                                          | correct                       |

## 2. Confirmed defects and root causes

**D1 — duplicate report version after a crash during report save (fixed).**
The report row and the save step's completion are separate writes. A process death between
them leaves the step `interrupted` while the report already exists. On resume the save
re-renders, but the Markdown includes the generation time ("Generated YYYY-MM-DD HH:MM
UTC"). The idempotency check compared the full content, so a resume in a later minute
created **version 2**, identical apart from the time.

- **Reproduced:** `lifecycle-acceptance.test.ts`, with the clock moved five minutes forward;
  before the fix it produced versions `[2, 1]`.
- **Fix:** `sameReportIgnoringTime()` compares the renderings with only that timestamp
  normalised. The stored version 1 is reused, so the task's `reportId` points to it.
- **Not affected:** real content changes (for example after Retry) still create a new
  version.

No other defect was found. In particular:

- a cancelled task cannot reach `completed` (storage transition table, plus the run loop
  stops before the next step);
- recovery is idempotent;
- the pin and the captured model are never rewritten.

## 3. Files changed

| File                                                                              | Why                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent-runtime/src/research/grounding.ts`                                | `sameReportIgnoringTime()` (D1).                                                                                                                                                                                                                                                                                                                |
| `packages/agent-runtime/src/research/workflow.ts`                                 | The save step uses it (D1). No other behaviour change.                                                                                                                                                                                                                                                                                          |
| `packages/agent-runtime/src/research/lifecycle-acceptance.test.ts` (new, 4 tests) | Reproduction of D1; a late answer after Cancel; no events after Cancel or Pause; event status matches storage.                                                                                                                                                                                                                                  |
| `apps/desktop/src/main/lifecycle/test-fixtures.ts` (new, test-only)               | Child-process entry and fixtures for real process interruption. It runs the app's own Research wiring (agent runtime, real OllamaProvider over HTTP, `researchTaskModelsFor`, SQLite). Self-kill points: web fetch, right after the report insert. The security guards treat `test-fixtures.ts` as test-only; it never imports `child_process`. |
| `apps/desktop/src/main/lifecycle/process-crash.test.ts` (new, 12 tests)           | Forks real Node processes, loads the TS sources through Vite (an existing devDependency, no new packages) and ends them at exact points. Restarts through `openAppStorage`.                                                                                                                                                                     |
| `apps/desktop/src/main/research-engine.integration.test.ts` (+6 tests)            | Tool-level pause and cancel; Retry after model and after tool failures in both directions; cancelled-while-paused across a restart; restart with changed Settings and environment overrides, plus renderer task details. Adds a `fetchHook` to the scripted web.                                                                                |

No migration, no change to the step machine, engine defaults, pinning format, transport,
authentication or tool permissions.

## 4. Pause / Resume (automated, Legacy and ADK)

- **Pause during a model request:** resumes without repeating finished steps (existing test).
- **Pause during a web fetch:** the fetch receives the abort; the task is `interrupted`
  ("paused") within 2 s. Resume repeats only that fetch (plan and select attempts stay 1).
  The pin stays, even though Settings were switched to the other engine in between. The
  task input is byte-identical.
- **Task details** show the pause, and the pinned engine before and after.

## 5. Cancel / Retry (automated, Legacy and ADK)

- **Cancel during a model request, before a call, and right after an answer:** existing
  tests.
- **Cancel during a web fetch:** the abort reaches the fetch; `cancelled` within 2 s. No
  later step starts, there is no report, and Resume and Retry are refused.
- **Late answer after Cancel** (a provider that ignores the abort): the task stays
  `cancelled` and the next step never starts; `complete()` on a cancelled task throws. The
  last progress event is the terminal one, with no step events after it, and its status
  matches the database.
- **Paused, then cancelled, then restarted:** stays `cancelled`; recovery ignores it.
- **Retry after a model failure,** both directions, with Settings set to the other engine:
  only the failed review runs again, on the pinned engine. Report version 1 only; input
  unchanged.
- **Retry after a tool failure** (every source failed, so the analysis failed): the sources
  are fetched again and the task completes on the pinned engine.
- **Limitation (documented, unchanged):** an operation that ignores its AbortSignal delays
  the stop until it returns. Model calls (Ollama `fetch`, ADK) and `fetch_source` honour the
  signal; a Retry back-off sleep also aborts. The UI shows `running` until the task stops;
  there is no permanent "cancelling" state.

## 6. Restart and crash recovery

**Real-process matrix (12 tests).** A child Node process runs the task and is ended at each
point, on both engines:

| Point                           | How the process ends                                  | Step found `interrupted` | Report rows before resume |
| ------------------------------- | ----------------------------------------------------- | ------------------------ | ------------------------- |
| Model generation (write report) | SIGKILL while the request is in flight                | report                   | 0                         |
| Web fetch                       | SIGKILL inside the fetch                              | fetch                    | 0                         |
| Evidence extraction             | SIGKILL while the 2nd extraction request is in flight | evidence                 | 0                         |
| Review                          | SIGKILL while the request is in flight                | review                   | 0                         |
| Report save                     | SIGKILL right after the report row was written        | save                     | 1                         |
| Normal quit                     | `will-quit` closes SQLite, the process exits with 0   | analyze                  | 0                         |

For each one, after the restart through `openAppStorage`:

- **Recovery:**
  - exactly that task is recovered, and `PRAGMA integrity_check` is `ok`
  - no step is left `running`; completed steps have 1 attempt
  - the pin matches the engine at creation
- **Second restart:** recovers nothing and the state is identical (idempotent).
- **Resume, with Settings switched to the other engine:**
  - the task completes on the pinned engine
  - exactly one report, two sources (no duplicates), task input byte-identical
  - completed steps are not repeated; `reportId` matches the report
  - the header says "via Local Ollama"
  - integrity is still `ok`

**In-process:** a restart with `RESEARCH_ENGINE` and `OLLAMA_MODEL` overrides, while the
current provider points at a dead address and another model. The resumed task uses only
the captured model and server, on the pinned ADK engine. The renderer details after the
restart show `interrupted` / app-closed / resumable / next step "Write report" / Google
ADK / `qwen3:8b` / Local Ollama, and `completed` after resuming.

## 7. SQLite integrity

- **Transactions:** startup recovery, resume, retry re-queue, source saves (row and text)
  and the report insert are atomic. Step completion is a separate write by design, and the
  steps that cause side effects are idempotent on repeat: sources are de-duplicated by URL
  and content hash, and the report by D1's comparison.
- **Real SIGKILL:** after a kill, the database opens, migrates and passes `integrity_check`.
- **No partial report:** the report row is either absent or complete (one insert). A
  `running` or `interrupted` task's report is never presented as the task's final output;
  the task output and `reportId` are written only when the task completes.
- **Compatibility:** existing databases need no migration.
- **Usage accounting (unchanged):** a model call interrupted before its step completed is
  counted when it ran, so a repeated call adds a usage row.

## 8. Legacy / ADK parity

Every matrix item runs on both engines. The existing parity suite (identical requests and
stored results) passes unchanged.

## 9. Automated results

| Check                               | Result                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm format` / `pnpm format:check` | pass                                                                                          |
| `pnpm typecheck`                    | pass                                                                                          |
| `pnpm lint`                         | pass                                                                                          |
| `pnpm test`                         | 81 files, **1,103 tests passed** (was 1,081; +22). The process-crash matrix takes about 17 s. |
| `pnpm build`                        | pass; the harness is not bundled                                                              |

## 10. Verified vs pending

- **Verified by automated tests (Linux container):** everything in §4–§8.
- **Verified manually:** nothing in this phase.
- **Not yet verified:**
  - the same suite on Windows (it uses `fork`, SIGKILL and `Atomics.wait`, all supported by
    Node on Windows, but not run there yet)
  - a real Electron window close or quit with a running task
  - the renderer UI itself after a restart (Vue rendering is checked by typecheck and build;
    the data it shows is tested)

## 11. Remaining risks

- **Abort-ignoring operations:** they delay Pause and Cancel until they return.
- **Repeated calls are counted:** an interrupted model call that is repeated adds a usage
  row.
- **The process tests depend on Vite's dev-server API** (`createServer` + `ssrLoadModule`);
  a Vite major upgrade could require adjusting the loader (test-only).

## 12. Manual Windows acceptance checklist

Use a test task with a harmless goal, and remote inference only if approved.

1. Run `pnpm test` on Windows. Confirm 1,103 passing, including `lifecycle/process-crash.test.ts`.
2. **Quit during a task:** start Research on ADK; while it is on an early step, close the
   app window. Restart: the task shows Interrupted ("the application stopped"), Resume
   continues at the same step, and Task Details still shows Google ADK.
3. **Pause, change Settings, Resume:** pause a task, switch Settings → Research engine to
   the other engine, resume. The task completes and Task Details shows the original engine.
4. **Cancel:** cancel during the fetch steps. The status changes to Cancelled within
   seconds, and Resume and Retry are not offered.
5. **Report check:** open the report: one version, "via Local/Remote Ollama" as configured.
6. **Read-only database check:** run `pnpm acceptance:db "<path to research.db>"`.
   Expect `quick_check` ok and no step left running.

## 13. Windows follow-up (first run on Windows)

The first `pnpm test` on Windows: 1,099 of 1,103 passed. The 4 failures were the two
**self-kill** scenarios (web fetch, report save) on both engines. They were a harness
portability bug, not an app defect:

- **Cause:** a process that sends itself SIGKILL ends via `TerminateProcess` on Windows,
  so the parent sees `code 1, signal null` instead of `signal SIGKILL`.
- **Fix:** the child writes a marker file just before the self-kill, and the harness
  accepts either form of abrupt termination. Parent-initiated kills already passed on
  Windows.
- **Check here:** with a simulated Windows-style end (exit code 1, no signal), all 12 pass.

The same run showed misleading stderr: "Research task crashed: The database connection is
not open" and "Could not write the execution log". This is what a normal quit produces
(`will-quit` closes SQLite while a task runs). The workflow now detects a closed database
and logs one line instead ("Research task … stopped: the database was closed (app shutting
down). It can be resumed after the next start."). Genuine crashes are still logged as
errors. A regression test checks this, and the full suite now prints none of those lines.

Files: `apps/desktop/src/main/lifecycle/{test-fixtures,process-crash.test}.ts`,
`packages/agent-runtime/src/research/{workflow,lifecycle-acceptance.test}.ts`.

Result here: 81 files, **1,103 tests passed**; typecheck, lint, format and build pass.
**Pending:** re-run `pnpm test` on Windows to confirm.
