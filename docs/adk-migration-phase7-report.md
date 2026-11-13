# ADK Migration — Phase 7 Report

_Research model calls on Google ADK behind a feature flag. Date: 2026-11-13._

Research can now make its model calls through Google ADK (`OllamaLlm`) when
`RESEARCH_ENGINE=adk` is set. The default is legacy, and existing installations stay on it.

**What stays as it was:**

- The Research step machine is still the only orchestrator. It owns steps, ordering,
  checkpoints, pause/resume, cancellation, retries, recovery, tools, sources, reports,
  error classification and usage accounting.
- ADK only executes one model call at a time inside an existing step.
- No Research code changed: `packages/agent-runtime` and `packages/model-provider` are
  untouched.
- The database schema, IPC, preload, renderer and Chat are unchanged.

**Parity checks:**

- For every scenario tested, both engines send byte-identical Ollama requests and store
  identical Research data.
- In the packaged Linux app, the request log of the default build is identical to the
  baseline.

**Pending:** live Ollama, and Windows GUI verification of Research.

## 1. Research model call-site inventory

The step machine (`agent-runtime/src/research/workflow.ts`) has **one** model-call
function, `callModel`. It calls `generateObject(provider, { messages, options:
{ temperature: 0, maxTokens }, think: false }, schema, { signal })`, which calls
`provider.generate` once (non-streaming, JSON Schema format), extracts the JSON and
validates it with Zod.

| Step       | Uses the LLM | Schema                                | maxTokens | Calls per task              |
| ---------- | ------------ | ------------------------------------- | --------- | --------------------------- |
| `plan`     | yes          | `ResearchPlanSchema`                  | 900       | 1                           |
| `search`   | no           | — (tool `web_search`, code-driven)    | —         | 1 per question              |
| `select`   | no           | — (deterministic)                     | —         | 1                           |
| `fetch`    | no           | — (tool `fetch_source`, code-driven)  | —         | 1 per source                |
| `evidence` | yes          | `SourceEvidenceSchema`                | 1200      | 1 per source                |
| `analyze`  | yes          | `AnalysisSchema`                      | 1500      | 1                           |
| `report`   | yes          | `ReportDraftSchema`                   | 2000      | 1                           |
| `review`   | yes          | `ReviewSchema`                        | 800       | 1 per batch of 8 paragraphs |
| `save`     | no           | — (grounding, rendering, persistence) | —         | 1                           |

**Prompts.** Every prompt is `[system: SYSTEM_PROMPT, user: "Task: …"]`. After an
`invalid-response`, the retry adds a second user message with the rejection text.

**Retries and timeouts.**

- `modelRetries` sets the number of extra attempts. Codes `invalid-response`, `timeout`,
  `http-error` and `unavailable` are retried, with exponential backoff.
- Each attempt has its own `modelTimeoutMs` deadline (`AbortSignal.any` of the task signal
  and the deadline).

**Usage.** One `model_usage` row is written per _accepted_ answer, with purpose
`research:<step>`, the task and the step.

**Task isolation (existing).** At start, `taskModels.capture()` stores the Ollama
configuration in `task.input.model`. `taskModels.providerFor(captured)` rebuilds a provider
from it for every later call, including after Resume, Retry or a restart.

**Narrowest switch point:** the `ModelProvider` that `providerFor` returns. Nothing in
Research needs to change.

## 2. Engine abstraction and feature flag

**Abstraction.** The existing `ModelProvider` contract, as consumed by `generateObject`,
is the backend interface:

- `generate` (plain text or JSON);
- `CallOptions.signal` and `timeoutMs`;
- the model settings in the `GenerateRequest`;
- `GenerateResult` with usage;
- `ModelProviderError` codes.

**Legacy engine:** the task's `OllamaProvider` snapshot, exactly as before.

**ADK engine:** `AdkResearchModel` (`adk-runtime/src/research/adk-research-model.ts`).
`generate` runs the same request through `createGuardedRunner` → `LlmAgent` → `OllamaLlm`
→ the same `OllamaProvider` snapshot. There is no new HTTP client.

- `checkHealth` and `checkModel` are delegated unchanged.
- `generateStream` is refused, since Research never streams.
- Desktop wraps it in `LazyAdkResearchModel`, which loads ADK on the first call, after the
  environment is sanitised.

**Flag:** `research.engine` = `legacy | adk`, set with the `RESEARCH_ENGINE` variable
(`main/research-engine.ts`):

| Property        | Behaviour                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default         | `legacy`. Unset or empty → legacy.                                                                                                                     |
| Validation      | Zod enum, trimmed and case-insensitive. Unknown values → legacy with a logged warning.                                                                 |
| Independence    | Independent of Chat's `AGENT_ENGINE` (tested).                                                                                                         |
| Where it is set | `settings.env` (already allowed through the `RESEARCH_` prefix; the runtime config ignores keys it does not know), `.env`, or the process environment. |
| Not changed     | No UI, IPC, settings-registry or schema change.                                                                                                        |
| Observability   | When a task starts, the main process logs `Research engine for the new task: legacy/adk`.                                                              |

## 3. Durable engine selection

The flag is read **once, when a task starts**, inside `capture()`.

**How the engine is pinned:**

- An ADK task's captured model configuration gets one extra key,
  `task.input.model.config.researchEngine = "adk"`.
- That JSON is already the task's durable, opaque configuration snapshot, owned by the
  main process.
- No schema or contract change is involved: the column is JSON, and the IPC type is
  `Json`.

**How each kind of task resolves:**

| Task                                            | Engine                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Legacy task                                     | Stores nothing new: its input is byte-identical to Phase 6 (tested).                                                     |
| Any task without a pin (every pre-Phase 7 task) | Legacy.                                                                                                                  |
| Task with a `model` capture                     | `providerFor(captured)` follows the **stored pin**, never the current flag, on Resume, Retry and recovery after restart. |
| Task without a `model` capture (older tasks)    | Keeps using the live legacy provider, as before.                                                                         |

**Unknown stored engine.** A value this version does not know (for example, after a
downgrade) is **never** run on another engine. That task's model calls fail with a clear
message.

## 4. Prompt and context compatibility

**Unchanged:** prompts, evidence excerpts, source ids, URLs, titles and the untrusted-data
markers come from the existing prompt builders.

**How the ADK engine sends a request:**

- **System prompt:** the request's system message becomes the system instruction in a
  `beforeModelCallback`. It is not an agent `instruction`, so ADK applies no
  `{placeholder}` template processing (tested with literal braces).
- **Earlier messages:** appended to a fresh in-memory session as ordinary events, through
  the public API.
- **Last user message:** passed as `newMessage`.
- **Agent:** no tools, no `outputSchema`, no `outputKey`, no sub-agents; transfers are
  disabled, so ADK adds no identity or transfer prompt.

**Generation settings:**

- `temperature` → `temperature`, `maxTokens` → `maxOutputTokens`, `think: false` → no
  thinking.
- The JSON Schema goes into `responseJsonSchema`, the same object `generateObject` built.
- Context size, sampling defaults, timeouts, auth and model come from the same snapshot.

**Result:** the HTTP bodies Ollama receives are identical for every call site, including
retry-with-feedback requests and Persian, German and emoji text (tested).

**Refused rather than altered** (`unsupported`; Research never sends these):

- tools;
- a per-request `repeatPenalty` (no GenAI field);
- more than one system message;
- tool messages;
- empty earlier messages (ADK would drop them);
- a different model name.

## 5. Structured output validation

- The final model text goes back to the existing `generateObject`, which runs the same
  `extractJson` and the **same Zod schema**. ADK's `outputSchema` is not used.
- `OllamaLlm` additionally requires parseable JSON. To keep the legacy error and retry
  feedback **identical**, its error is mapped back to the legacy text,
  `Model did not return valid JSON (got: "…").` (tested by byte comparison).
- Valid JSON that breaks the schema is rejected by `generateObject` with the legacy
  message. Nothing is invented or filled in.
- **Generation failure vs validation failure:** both stay `invalid-response`, the code the
  workflow uses for retry-with-feedback. Server errors keep their own codes.

## 6. Cancellation, timeouts and retries

| Case                              | Behaviour (both engines, identical stored state)                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before a model call               | No request is sent. The task is `cancelled` and has no usage rows.                                                                                                                                             |
| During a request                  | The HTTP request is aborted. The step fails with "Cancelled by the user.". No output, no usage, no report. An aborted ADK request never returns a result: ADK's `INVOCATION_ABORTED` is mapped to `cancelled`. |
| Between generation and validation | Same as legacy: the answer that already arrived is validated and checkpointed, then the task stops before the next step.                                                                                       |
| Between validation and checkpoint | Synchronous in the existing step loop (no `await` in between), so cancellation cannot fall there. Unchanged.                                                                                                   |
| Pause during a call, then Resume  | The step is repeated on its pinned engine. Finished steps are not repeated.                                                                                                                                    |
| Shutdown or crash                 | See §7.                                                                                                                                                                                                        |

**Timeouts:** the deadline aborts the call. The workflow classifies it as `timeout` and
retries it within `modelRetries` (tested with a hanging call).

**Retries:**

- ADK adds no retries: one `generate` call is one HTTP request (request counts are equal on
  both engines).
- The ADK engine never falls back to legacy. If ADK cannot load, the step fails with a
  controlled message.

## 7. Workflow persistence and crash recovery

**Unchanged:** all persistence (steps, checkpoints, sources, evidence, reports, logs and
usage) is the existing code.

| Scenario                                                                     | Result (tested)                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ADK task, crash during `write-report`, restart with `RESEARCH_ENGINE=legacy` | Resumes on **ADK**. Only `write-report` and `review-report` run; nothing earlier is replayed. One report, one report usage row. |
| Legacy task, restart with `RESEARCH_ENGINE=adk`                              | Resumes on legacy; ADK is never loaded.                                                                                         |
| Task created before Phase 7 (Phase 6 capture), resumed with `adk`            | Legacy.                                                                                                                         |
| Paused task, flag changed in either direction                                | Resumes on its pinned engine. The next new task uses the new flag.                                                              |
| Failed ADK task, Retry after the flag changed                                | Only the failed step runs again, on ADK. No duplicate sources, reports or usage.                                                |
| Validation fails until the budget is used up                                 | The step fails with no output. No report, no usage row for that step.                                                           |

## 8. Evidence and citation integrity

Grounding is unchanged and runs on the model output of both engines. Model output stays
untrusted until the pipeline validates it. With the same fixture model output, both
engines stored identical reports, in which:

- invented evidence ids (`E99`, `E77`) are dropped;
- invented `[3]` markers and the injected link `evil.example` are removed;
- a quote that is not in the page ("COP of 10") is discarded;
- the unsupported paragraph is listed as "Removed (not supported by the sources)";
- only stored sources are cited.

## 9. Usage accounting

The same rows are recorded through the same code (tested by comparing all usage rows):

- one `model_usage` row per **accepted** answer;
- provider `ollama`, the model name reported by Ollama, prompt and completion tokens,
  durations;
- purpose `research:<step>`, linked to the task and the step;
- none for rejected, cancelled or failed attempts, so there is no double counting on
  retries.

**Total tokens:** not stored separately (the existing schema has prompt and completion
tokens). That is unchanged.

**Errors:**

- Errors map back to the same `ModelProviderError` codes and messages. The workflow
  classifies and redacts them as before.
- An ADK-internal failure reports only `The ADK research engine failed (CODE).`, with no
  internal message, path or stack.

## 10. Security guards

**Earlier guards:** every Phase 1–6 guard still passes. The facade allowlist is unchanged.

**New guards (`adk-runtime/src/security.test.ts`):**

- `adk-runtime/src/research/` must not mention tools, `RegistryTool`, `allowedTools`,
  `allowToolCalls`, `BaseTool`, `outputSchema`, `outputKey` or `subAgents`.
- `packages/agent-runtime` must never import ADK or `@rka/adk-runtime`, so the step machine
  stays the orchestrator.
- The Research module joins the allowlist of modules that may look at model function
  calls, and it only does so to reject them.

**Tools and approvals:**

- Research tools still run only through the step machine's `ToolRegistry` calls (identical
  searches and fetches; tested).
- No request carries `tools`, and no approval mechanism changed.

**Network and storage:**

- During ADK Research, `fetch` reached only the Ollama server, and telemetry is disabled.
- No `adk_*` rows are written (tested).

**Bundle:** unchanged. No code executors, `LocalEnvironment` or MikroORM.
`child_process` still comes only from `google-auth-library`.

## 11. Automated tests

| Check                      | Result                                        |
| -------------------------- | --------------------------------------------- |
| `pnpm typecheck`           | pass                                          |
| `pnpm lint`                | pass                                          |
| `pnpm format:check`        | pass                                          |
| `pnpm test`                | pass: 67 files, 906 tests (Phase 6: 64 / 867) |
| `pnpm build`               | pass                                          |
| `pnpm package:dir` (Linux) | pass                                          |

**New test files:**

- `apps/desktop/src/main/research-engine.integration.test.ts` (20 tests). Uses the real
  step machine, SQLite files, `ToolRegistry` and web tools over a scripted web, and the real
  `OllamaProvider` over HTTP to a fake Ollama. Each scenario runs on both engines and
  compares the requests and the stored data:

  | Group     | Covers                                                                                                                                   |
  | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
  | A–C, K, M | Default legacy; all 7 model calls through ADK; identical requests and data; grounding; code-controlled tools                             |
  | D, E, L   | Invalid JSON, schema mismatch, persistent invalid output, server error and missing model; identical feedback and budgets; no extra usage |
  | F         | Timeout; cancellation before, during and after generation; pause and resume                                                              |
  | G, H, N   | Flag changes while paused; restart recovery for ADK, legacy and pre-Phase 7 tasks; Retry                                                 |
  | P, Q      | Only Ollama contacted; no ADK session rows                                                                                               |

- `apps/desktop/src/main/research-engine.test.ts` (8 tests): flag parsing, independence
  from `AGENT_ENGINE`, capture byte-identical to Phase 6, pin over flag, unknown stored
  engine, ADK load failure with no fallback.
- `packages/adk-runtime/src/research/adk-research-model.test.ts` (10 tests):
  - request fidelity, including literal braces;
  - Zod validation stays with the caller;
  - identical invalid-JSON message, error mapping and redaction;
  - cancellation before and during a call;
  - refusals; no streaming.
- `security.test.ts`: one new guard and the updated allowlist.

**Chat (O):** all Phase 6 Chat tests pass unchanged, and no Chat code was modified.

## 12. Real Ollama tests

`pnpm test:research:ollama` (new) runs `apps/desktop/src/main/research-engine.live.test.ts`
on both engines, with the configured server and model, two fixture pages (no live
websites) and a temporary database. It pulls no models.

**Cases, run for each engine:**

1. A bounded end-to-end task covering plan, evidence, analysis, report and review. It
   checks that the task completes, the engine is pinned, every model step stored a
   validated output with one usage row, the report cites only fixture URLs, and no ADK
   session rows exist.
2. Cancellation during the plan model call.
3. A missing model is refused before a task is created.

**Invalid output:** a real model cannot be made to produce invalid output safely, so this
is covered deterministically (§11).

**Status: unverified against a real Ollama in this environment.** It was dry-run against a
stand-in server; 6 of 6 passed.

`test:chat:ollama` now runs only the Chat live tests. It is unchanged otherwise.

```powershell
cd C:\Users\zandm\Projects\Algoalliance\sample-agent
pnpm install
pnpm test:research:ollama
pnpm test:chat:ollama
pnpm test:adk:ollama
```

## 13. Windows Electron verification

**Linux (done).** Packaged app (Electron 44.10.1):

| Run                                        | Results                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Default                                    | Ollama request log identical to the baseline.                                                                                                  |
| `RESEARCH_ENGINE=adk` + `AGENT_ENGINE=adk` | Same request log as the Phase 6 ADK run. Chat, multi-turn and cancellation work, the persistence task completes, and database integrity is ok. |

**Research in the GUI: pending.** A Research task needs SearXNG and public web pages
(`fetch_source` refuses loopback addresses), which this environment lacks. Node-based tests
do not verify the packaged Windows app.

**Checklist for Windows:**

1. **Legacy Research:** with SearXNG configured and no `RESEARCH_ENGINE`, run a task to
   completion. The log shows `Research engine for the new task: legacy`.
2. **ADK Research:** add `RESEARCH_ENGINE=adk` to
   `%APPDATA%\Autonomous Research Assistant\settings.env` (or
   `$env:RESEARCH_ENGINE="adk"; pnpm dev`) and restart. Run a task to completion. Its input
   contains `"researchEngine":"adk"`.
3. **Pause, resume, cancel:** pause and resume an ADK task; cancel another one.
4. **Restart:** start an ADK task, close the app mid-task, set `RESEARCH_ENGINE=legacy`,
   restart and Resume. The task finishes on ADK.
5. **Database:** run the integrity check in Storage.
6. **Chat:** check Chat with `AGENT_ENGINE` set to `legacy` and to `adk` (independent of
   Research).
7. **Rollback:** see §16.

## 14. Files changed

**Created:**

- `packages/adk-runtime/src/research/adk-research-model.ts`
- `packages/adk-runtime/src/research/adk-research-model.test.ts`
- `apps/desktop/src/main/research-engine.ts`
- `apps/desktop/src/main/research-engine.test.ts`
- `apps/desktop/src/main/research-engine.integration.test.ts`
- `apps/desktop/src/main/research-engine.live.test.ts`
- `docs/adk-migration-phase7-report.md`

**Modified:**

| File                                        | Change                                                      |
| ------------------------------------------- | ----------------------------------------------------------- |
| `apps/desktop/src/main/index.ts`            | `taskModels: researchTaskModelsFor(modelProvider)`          |
| `packages/adk-runtime/src/engine.ts`        | Exports.                                                    |
| `packages/adk-runtime/src/security.test.ts` | Research guards.                                            |
| `package.json`                              | `test:research:ollama`; `test:chat:ollama` limited to Chat. |
| `README.md`                                 | `RESEARCH_ENGINE` documented.                               |
| `.env.example`                              | `RESEARCH_ENGINE` documented.                               |

**Unchanged:** `agent-runtime`, `model-provider`, `storage` (schema), `shared` (IPC),
preload, renderer and Chat.

**Removed:** none.

## 15. Remaining risks

- **Pin location.** The engine pin lives inside the opaque model-configuration JSON. That
  needs no migration, but it means the engine is part of the "model configuration" a task
  keeps. A future dedicated column would need a migration.
- **Downgrade.** An ADK task resumed by a version that predates Phase 7 would run on legacy,
  because the old code ignores the key. Within Phase 7 and later, an unknown engine is
  refused.
- **Per-call overhead.** ADK builds an agent, a runner and an in-memory session for every
  model call (milliseconds; not benchmarked).
- **Adapter coupling.** The legacy-identical invalid-JSON message depends on the adapter's
  message prefix. A test fails if it changes.
- **Pending verification:** live Ollama (§12) and Windows GUI Research (§13). Phase 6
  Windows GUI verification is also still pending.

## 16. Exact rollback procedure

**Runtime (no code or data change):**

1. Remove the `RESEARCH_ENGINE` line from
   `%APPDATA%\Autonomous Research Assistant\settings.env` (or `.env`), or set
   `RESEARCH_ENGINE=legacy`. Remove any `RESEARCH_ENGINE` system or user environment
   variable.
2. Restart the app. New tasks then use legacy (the log shows
   `Research engine for the new task: legacy`).
3. **Tasks already started on ADK keep ADK** (by design). To move one to legacy, cancel it
   and start a new task.

**Code rollback:**

- Revert the Phase 7 commit. No migration is involved.
- After the revert, tasks started on ADK resume on legacy, because Phase 6 ignores the
  `researchEngine` key. Their stored data is the same format on both engines.
