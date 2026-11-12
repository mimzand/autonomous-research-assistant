# ADK Migration Assessment — Phase 0

_Autonomous Research Assistant → Google ADK for TypeScript_
_Date: 2026-11-12 · Status: **awaiting approval** · No application code was changed and no dependencies were installed in the repository._

---

## 0. Summary

- **ADK TypeScript can run inside this app.** `@google/adk@2.4.0` (latest, 2026-10-28) imports and runs on Node 22.23 (the dev machine) and is compatible with Node 24.22.1, which Electron 44.10.1 embeds. All transitive `engines` are satisfied. The highest floor is `@mikro-orm/core` at `>= 22.17.0`.
- **We need a custom Ollama adapter.** There is no Google-maintained Ollama integration for ADK TS. The only community package, `adk-ollama@1.0.0`, ignores ADK's `abortSignal`, has a single release, one maintainer and no public repository. The adapter (`OllamaLlm extends BaseLlm`) should reuse the existing `OllamaProvider` transport for timeouts, auth token handling, the TLS/host policy and errors.
- **ADK TS has no durable workflow engine yet.** Its `Workflow` class says it is a _"Phase 2 subset"_ in which _"replay/checkpointing … are added in later phases"_. The existing SQLite-persisted step machine (plan → search → select → fetch → evidence → analyze → report → review → save) is therefore the only component that delivers pause, resume, retry and crash recovery today. **It must remain the outer orchestrator.** ADK replaces the _LLM-calling inside_ each step, not the step machine itself.
- **Structured output must keep our own Zod validation.** ADK only _logs_ an output that fails `outputSchema`. It still stores the invalid value in session state. For non-Gemini models that also have tools, it injects a synthetic `set_model_response` tool instead of setting a response schema.
- **ADK's database sessions cannot reuse our SQLite.** `DatabaseSessionService` is built on MikroORM. A `SqliteSessionService extends BaseSessionService` on Drizzle/better-sqlite3 is straightforward and keeps a single DB.
- **The Electron process model does not need to change.** ADK runs in the main process next to the current runtime. The renderer, preload and IPC contracts can stay unchanged.

---

## 1. Current architecture (as audited)

### 1.1 Repository layout

pnpm 12 workspace, TypeScript 6 strict, ESLint 10, Prettier, Vitest 5 (~498 test cases).

| Package | Role |
|---|---|
| `apps/desktop` | Electron 44.10.1 shell: `src/main` (composition root, IPC, config, chat, research tools, security), `src/preload` (sandboxed CJS bridge), `src/renderer` (Vue 3.5 + Vite 8). |
| `packages/shared` | Platform-neutral Zod contracts: IPC channels, chat, settings, dashboard, research-tools, `Result` helpers. |
| `packages/model-provider` | `ModelProvider` interface + `OllamaProvider` (`/api/chat`, `/api/tags`, `/api/show`, `/api/version`), NDJSON streaming, request scopes/timeouts, `generateObject` (Zod → JSON Schema → `format`, tolerant JSON extraction, Zod validation). |
| `packages/tools` | Typed tool contract and `ToolRegistry` (input/output Zod validation, approval gate, timeouts, cancellation, never throws), web tools `web_search` / `fetch_source`, SearXNG provider, SSRF-safe fetcher (IP policy, URL canonicalisation), HTML / PDF (`unpdf`) / DOCX (`fflate` + `htmlparser2`) extraction. |
| `packages/storage` | better-sqlite3 13 + Drizzle 0.45: embedded migrations (`0000_initial`, `0001_task_logs`), repositories, transactions, recovery, integrity check/backup. |
| `packages/agent-runtime` | `createAgentRuntime`: chat streaming, persistence check, and the research agent (`research/workflow.ts`, ~1,350 lines) with prompts, schemas, grounding and failure classification. |

### 1.2 Electron main / preload

- `main/index.ts` bootstraps the app:
  1. Loads `.env` and `settings.env` (dev only).
  2. Opens SQLite with migrations and recovery.
  3. Builds the runtime config (defaults < env < SQLite settings, applied live).
  4. Creates the Ollama provider, web services, tool registry and agent runtime.
  5. Registers IPC handlers and creates the window.
- The window is fully isolated: `contextIsolation`, `sandbox`, `nodeIntegration: false` and `webSecurity`. The production CSP uses `connect-src 'none'`, so the renderer has no network access.
- The preload exposes a typed bridge only. Channel names live in `shared/src/ipc.ts`, which has 44 invoke channels and 3 events (`chat:event`, `research:progress`, `settings:changed`).
- Security guard tests scan shipped sources and forbid `child_process`, `worker_threads`, `eval`, model pull/delete endpoints and file deletion.

### 1.3 Renderer

- Vue 3 Composition API. There is **no vue-router**: navigation is a reactive `useNavigation()` section switch.
- Pages: Chat, Tasks / TaskDetail, Research Tools, Knowledge, Reports, Storage, Settings.

### 1.4 Chat and streaming

- `main/chat.ts` `ChatController` handles chat requests:
  - The renderer sends the full turn history (`ChatStartRequestSchema`, last turn must be from the user).
  - Main streams `GenerateChunk`s from `runtime.streamChat` as validated `ChatEvent`s.
  - One active stream at a time, aborted via `AbortController`.
  - Usage is persisted to `model_usage`.
- Chat is **stateless on the server** (no chat tables) and **has no tools**.

### 1.5 Research agent

- Runs as a deterministic, persisted **step machine**. Every step is a `task_steps` row (`kind`, `input`, `output`, `status`, `attempts`), and later steps are derived from completed outputs.
- Resume continues at the first unfinished step and never repeats completed work.
- Failure handling:
  - Errors are classified as transient, offline, model or fatal.
  - Retries use exponential backoff.
  - Per-source failures are non-fatal.
  - Pause and cancel are supported.
- LLM calls use `generateObject` with Zod schemas. Steps: plan, evidence per source, analyze, report draft, review.
- **Tools are called by code, not by the model.** Code chooses `web_search` and `fetch_source` through the registry, so there is no model-driven function calling today.
- Grounding: `grounding.ts` indexes evidence, grounds claims to stored source excerpts and renders the Markdown report with citations. It never invents sources.

### 1.6 Persistence

- Tables: `tasks`, `task_steps`, `sources`, `source_contents`, `reports` (versioned, `cited_source_ids`), `model_usage`, `settings` (with `is_secret`), `approvals`, `task_logs`.
- Startup recovery marks running tasks and steps as `interrupted`. `ResumePlan` provides completed steps, remaining steps and pending approvals.

### 1.7 Settings and secrets

- Runtime settings live in SQLite and `.env` supplies initial defaults only. This already satisfies global rule 8.
- Secrets (`secret.ollama.authToken`) are encrypted with Electron `safeStorage` (DPAPI on Windows) and cached in main-process memory. The renderer only sees `{ set: boolean }`.
- The auth token is not sent over plain HTTP to non-local hosts.

---

## 2. Google ADK TypeScript — verified findings

The findings below come from the published `@google/adk@2.4.0` tarball (type definitions and ESM source) and from runnable spikes in an isolated scratch directory using a fake `BaseLlm`. **ADK Python documentation was not used as evidence.**

| # | Question | Finding | Evidence |
|---|---|---|---|
| 1 | Package and version | `@google/adk` **2.4.0** (latest). Apache-2.0, repo `google/adk-js`. ESM + CJS builds. | npm registry |
| 2 | Node engine | No `engines` field. Transitive floors: `@mikro-orm/core >= 22.17.0`, `@google/genai >= 20`, OpenTelemetry `>= 20.6`. | package.json files |
| 3 | Electron compatibility | Electron 44.10.1 embeds **Node 24.22.1** (Chromium 152). This satisfies every floor. The dev machine runs Node 22.23.4, which also satisfies them. The spike ran on Node 22.23.4 with an import time of about 0.7 s. **Not yet run inside the Electron main process** (Phase 1). | releases.electronjs.org; spike |
| 4 | `BaseLlm` | `abstract generateContentAsync(llmRequest, stream?, abortSignal?) : AsyncGenerator<LlmResponse>` plus `abstract connect()`, which is live/bidi only, so we throw. Request and response types are `@google/genai` `Content`/`Part`/`GenerateContentConfig`. Agents accept `model: string \| BaseLlm`, so we pass an **instance**. | `models/base_llm.d.ts` |
| 5 | Maintained Ollama integration | **None from Google.** `adk-ollama@1.0.0` (community) is a single release from 2026-04 with no repo, and its `generateContentAsync` takes no abort signal. `adk-llm-bridge` targets OpenAI/Anthropic SDKs and peers `@google/adk <2`. Neither is acceptable. | npm, tarball |
| 6 | Custom adapter required | **Yes.** | — |
| 7a | Streaming | Partial `LlmResponse`s (`partial: true`) become partial events. The final aggregate is persisted to the session and partials are not. Requires `runConfig.streamingMode = SSE`. | spike: 2 partial + 1 final event, 4 persisted events |
| 7b | Tool calling | `functionCall` → `FunctionTool.execute` → `functionResponse` → next model turn works. ADK validates Zod (v4) parameters and returns errors to the model as `{error}`. Unknown tool names also return as `{error}` with a warning. Tool declarations are sent in **genai `Schema` format** (`type: "OBJECT"`, `minLength: "3"` as string, `additionalProperties` dropped), so the adapter must convert them to JSON Schema for Ollama. | spike |
| 7c | Structured output | `outputSchema` (Zod) becomes `config.responseSchema` (genai format) + `responseMimeType: application/json` when there are no tools. With tools on a non-Gemini model, ADK adds a `set_model_response` tool instead. **Invalid output is only logged and still written to state.** Keep `extractJson` + Zod validation in our code. | spike |
| 7d | Conversation history | ADK builds `contents` from session events (user/model/functionCall/functionResponse). Chat history can be seeded into a session or kept in a persistent session. | spike |
| 7e | Cancellation | `runner.runAsync({ abortSignal })` passes the signal to `generateContentAsync`. The run ended **in about 200 ms** with an `INVOCATION_ABORTED` error event, **not a thrown error**. The tool `Context` also exposes `abortSignal`. Real HTTP abort to Ollama is to be verified in Phase 3. | spike; `agents/context.d.ts` |
| 7f | Model configuration | Per-agent `generateContentConfig` (temperature, topP, topK, seed, maxOutputTokens, stopSequences). The adapter maps these to Ollama `options`. `num_ctx` and `think` need adapter-level config. | types |
| 8 | Sessions and state | `BaseSessionService` methods: `createSession`, `getSession`, `listSessions`, `deleteSession`, `appendEvent`. `Session = { id, appName, userId, state, events, lastUpdateTime }`. State uses scope prefixes (`app:`, `user:`, `temp:`), and `outputKey` writes the agent output into state. | `sessions/*.d.ts` |
| 9 | Reuse existing SQLite | `DatabaseSessionService` uses **MikroORM** (optional peer `@mikro-orm/sqlite`), so it is not reusable without a second ORM and driver. Writing our own Drizzle-backed `BaseSessionService` is small and keeps one DB, one migration system and one backup. | `sessions/database_session_service.d.ts` |
| 10 | Process model | ADK is plain Node with no native addons. It runs in the main process like the current runtime. No utility process is needed, and IPC is unchanged. | spike |

**Other verified facts:**

- **Telemetry:** OTLP exporters are enabled only when `OTEL_EXPORTER_OTLP_*` environment variables are set. No outbound requests were observed during import or runs (`fetch` instrumented).
- **Bundle contents:** `@google/adk` is not tree-shakeable (no `sideEffects` field, and the root index imports everything). A minimal bundle importing only `LlmAgent`, `Runner`, `BaseLlm`, `FunctionTool` and `InMemorySessionService` is **about 5.8 MB**. It **contains `child_process`**, which comes from `UnsafeLocalCodeExecutor` and `LocalEnvironment`. Docker (`dockerode`) is an optional dependency.
- **Install size:** a fresh install of `@google/adk` is about 216 MB in `node_modules` (226 packages), including `@google/genai`, `google-auth-library`, Vertex/AI Platform clients and OpenTelemetry.
- **Zod:** ADK requires `zod ^4.6.7`, which matches the repo's pinned `4.6.7`, so a single copy is used.

---

## 3. Target architecture

```
Renderer (Vue)  ──IPC (unchanged contracts)──►  Electron main
                                                 ├─ ChatController ──► ChatAgentService ─┐
                                                 ├─ Research step machine (KEPT)         │
                                                 │     └─ per-step LLM call ──► StepAgents┤
                                                 │                                         ▼
                                                 │                         ADK Runner + LlmAgent(s)
                                                 │                           ├─ OllamaLlm (BaseLlm adapter)
                                                 │                           │     └─ OllamaProvider transport (KEPT)
                                                 │                           ├─ RegistryTool (BaseTool → ToolRegistry, KEPT)
                                                 │                           └─ SqliteSessionService (Drizzle, NEW)
                                                 └─ Storage / Settings / safeStorage (KEPT)
```

**New code:** a new workspace package `packages/adk-runtime`, or a folder inside `agent-runtime`; to be decided in Phase 1. It would contain:

- `OllamaLlm`: the `BaseLlm` adapter, a genai ⇄ Ollama message mapper, a genai `Schema` → JSON Schema converter, a streaming aggregator, and abort/timeout and error-to-`errorCode` mapping.
- `RegistryTool`: an ADK `BaseTool` that delegates to the existing `ToolRegistry`, preserving approval, timeouts, Zod I/O and `Result` errors.
- `SqliteSessionService`.
- An event bridge from ADK `Event`s to the existing `ChatEvent` and research log events.
- A usage plugin or callback that records `model_usage`.

**Guard rails:**

- Agents always receive an `OllamaLlm` instance, never a model string, so the Gemini registry can never be reached.
- No code executors and no built-in Google tools.
- `OTEL_*` and `GOOGLE_*` variables are stripped or ignored.
- New guard tests enforce all of the above.

---

## 4. Existing features to preserve

- Chat: streaming, stop, error codes, usage recording, one stream at a time.
- Research tasks: start, pause, resume, cancel, retry of failed steps, crash recovery to `interrupted`, step logs, progress events, limits (questions, sources, steps), backoff/retry settings.
- Grounding: no invented sources, claims tied to stored excerpts, versioned reports with `cited_source_ids`.
- Research Tools page: manual search, fetch, file extract, save source, open URL, cancel.
- SearXNG health check, settings test, safesearch.
- SSRF-safe fetcher, IP policy, download limits; HTML/PDF/DOCX extraction.
- Settings: layered config with live apply, validate/reset, encrypted secrets, Ollama connect/disconnect/test, model list/show/test, effective config.
- Storage: status, integrity check, backup, migrations.
- Security: renderer isolation, CSP, IPC validation, console redaction, security guard tests.
- Ollama: local and remote servers (token over HTTPS only), structured-output version gate, thinking flag.

## 5. Components to replace

| Component | Replaced by | Notes |
|---|---|---|
| `runtime.streamChat` (direct `generateStream`) | ADK `Runner` + chat `LlmAgent` via `OllamaLlm` | Same `ChatEvent` stream to the renderer. |
| Per-step `generateObject` calls in `research/workflow.ts` (plan, evidence, analyze, report, review) | One `LlmAgent` per step kind, run via `Runner` with `outputSchema`; result **re-validated** with existing Zod schemas | Step machine, persistence, retries and grounding unchanged. |
| Ad-hoc prompt assembly | Agent `instruction` + session contents | Existing prompt text in `prompts.ts` reused verbatim initially. |

## 6. Components to reuse (unchanged or extended)

- **Extended:** `OllamaProvider` gains tool definitions, `tool_calls` parsing (streamed and non-streamed) and `role: "tool"` messages. Its transport, auth, scope, timeouts and errors are reused by the adapter.
- `generateObject` / `extractJson`, as the final validator.
- `ToolRegistry`, web tools, SearXNG, fetcher, extractors.
- Research step machine, failure classification, grounding, report rendering.
- Storage package and repositories, plus one new migration (see §9).
- Runtime config, settings service, `safeStorage` secrets.
- All IPC channels, preload and renderer (no contract changes planned).

---

## 7. Compatibility risks

| Risk | Severity | Mitigation |
|---|---|---|
| ADK assumes Gemini: genai `Schema` (uppercase types, string-typed numeric constraints, no `additionalProperties`) for tools and `responseSchema` | High | Schema converter with unit tests. Option to send the original Zod → JSON Schema (via the tool or agent's source schema) instead of the lossy genai schema. |
| `outputSchema` failures are only logged; invalid data reaches state | High | Never trust `outputKey` state. Parse the final text with `extractJson` + Zod. Keep the existing retry/classification path. |
| Non-Gemini + tools + `outputSchema` → synthetic `set_model_response` tool that small local models may misuse | Medium | Don't combine tools and `outputSchema` in one agent. Use separate tool-using and structuring agents. |
| Ollama tool calling quality varies by model (e.g. `qwen3:8b`), there are no tool-call IDs on older servers, and streamed tool calls need recent Ollama | High | Adapter synthesises IDs. Capability check via `/api/show` (`capabilities: tools`). Server version gate. Live tests against the user's Ollama version. Model-driven tools remain **opt-in**. |
| No durable workflow/checkpoint in ADK TS | High | Keep our step machine as the orchestrator. ADK is used per step. Re-evaluate when ADK TS ships replay. |
| `abortSignal` produces an `INVOCATION_ABORTED` **event**, not an exception | Medium | Event bridge maps it to the existing cancelled/paused paths. Tests cover pause vs cancel. |
| Bundle includes `child_process` (code executors) and Google Cloud clients | Medium (security review) | Either (a) bundle and add a test asserting no executor or Gemini usage, or (b) externalise `@google/adk` as a runtime dependency. Decide in Phase 1. Existing source-scan guards are unaffected because they scan repo sources only. |
| Install size (+~216 MB `node_modules`) and packaged size (+5–8 MB bundled) | Low–Medium | Measure the packaged installer in Phase 1. |
| `OTEL_EXPORTER_OTLP_*` env var would export traces, possibly including prompts | Medium | Strip `OTEL_*` from `process.env` in main before importing ADK. Guard test. |
| ADK is moving fast (2.0 → 2.4 in months) | Medium | Pin an exact version (repo convention). Keep the adapter behind our own interfaces. Contract tests catch upgrade breaks. |
| Electron runtime not yet exercised with ADK (ESM main bundle, winston logger installed at import) | Medium | Phase 1 smoke test in `pnpm dev` and `package:dir`. Route ADK logs through the existing redacting console. |
| `UnsafeLocalCodeExecutor` / `LocalEnvironment` exist in the library | Low (unused) | Never instantiated. Guard test greps our sources for these identifiers. |

## 8. Required dependencies

| Package | Version | Where | Justification |
|---|---|---|---|
| `@google/adk` | **2.4.0** (exact pin) | `agent-runtime` (or new `adk-runtime`), bundled into the desktop main process | The migration target |

- **Transitive (no direct dependency added):** `@google/genai` (types and `Content` helpers; makes no network calls unless a Gemini model is used), OpenTelemetry API, winston, lodash-es, etc.
- **Not needed:** `@mikro-orm/*`, `express`, `@modelcontextprotocol/sdk`, `@google-cloud/*` (all optional peers), `adk-ollama`, `ollama-js` (the existing provider already speaks the API).
- **No upgrades** to Node, Electron, TypeScript, Zod or Vite are required.

## 9. Expected database changes

New migration `0002_adk_sessions`. It is additive only; no existing table changes.

| Table | Columns |
|---|---|
| `adk_sessions` | `id` PK, `app_name`, `user_id`, `state` json, `created_at`, `updated_at`; index on (`app_name`, `user_id`, `updated_at`) |
| `adk_events` | `id` PK, `session_id` FK → `adk_sessions` (cascade), `seq`, `invocation_id`, `author`, `timestamp`, `event` json (full ADK Event incl. `actions.stateDelta`); unique (`session_id`, `seq`) |
| `adk_app_state` | `app_name` PK, `state` json |
| `adk_user_state` | (`app_name`, `user_id`) PK, `state` json |

- **Optional:** a `session_id` link on `task_steps`, or storage in step `input`/`output` JSON, to correlate research steps with ADK sessions. To be decided in Phase 5.
- **Settings keys:** `agent.engine` (`legacy` | `adk`, default `legacy` until parity), and later per-feature flags (e.g. `chat.tools.enabled`).
- **Unchanged:** `model_usage` (`purpose` values extended, e.g. `adk:chat`, `adk:research:plan`).

## 10. Proposed migration sequence

Each phase keeps the app runnable, runs `pnpm check`, and stops for approval.

1. **Baseline and dependency spike.**
   - Record baseline `pnpm check` results.
   - Add `@google/adk@2.4.0` and decide bundling vs externalising.
   - Add an env sanitiser for `OTEL_*`/`GOOGLE_*` and guard tests (no model strings, no executors).
   - Smoke-import ADK in the Electron main process (dev + `package:dir`) and measure size.
   - No behaviour change.
2. **Ollama provider: tool calling.**
   - Extend `ModelProvider` schemas with tool definitions, `tool_calls` and tool messages, streamed and non-streamed.
   - Add a capability check (`tools`).
   - Unit tests with fake fetch, plus live tests (`test:ollama`) that verify tool calling, streaming tool calls and structured output on the user's Ollama version and model.
3. **`OllamaLlm` adapter.**
   - Content/schema mapping, partial and aggregate streaming, abort, timeouts, usage → `usageMetadata`, errors → `errorCode`, `think` and `num_ctx` config.
   - Contract tests through a real ADK `Runner`, as in the Phase 0 spike.
4. **Tool bridge.**
   - Wrap `ToolRegistry` as an ADK `BaseTool`, mapping the approval gate to ADK confirmation or a returned error.
   - Propagate `Context.abortSignal`.
   - Tests for invalid input, timeout, cancellation and approval-required.
5. **`SqliteSessionService`, migration 0002, and a usage-recording plugin.**
   - Run ADK's session behaviour tests against both `InMemorySessionService` and ours.
6. **Chat on ADK behind `agent.engine`.**
   - Same IPC/`ChatEvent` contract and the legacy path kept.
   - Parity tests (stream, stop, errors, usage).
   - No tools in chat unless approved.
7. **Research LLM steps on ADK behind `agent.engine`.**
   - Migrate one step kind at a time (plan → evidence → analyze → report → review).
   - The step machine, recovery, retries and grounding are untouched.
   - Existing fixtures and lifecycle tests run against both engines.
8. **Optional agentic features (requires separate approval).**
   - Tool-using chat, and model-driven search/fetch inside the search step, with step-budget limits and untrusted-content handling.
9. **Cut-over and cleanup (requires approval).**
   - Make ADK the default.
   - Remove the legacy path only after parity is shown and with explicit approval.

## 11. Testing strategy

- **Baseline:** record `pnpm typecheck`, `lint`, `format:check`, `test` and `build` results before Phase 1. They were not run in Phase 0 because `node_modules` is not installed and installing was out of scope.
- **Unit tests:**
  - Schema converter (genai → JSON Schema, Zod round-trips).
  - Message mapper (all `Part` kinds).
  - Stream aggregator.
  - Error mapping.
  - Session service (event append order, state deltas with `app:`/`user:`/`temp:` scopes, stale updates).
  - Tool bridge.
- **Contract tests:** ADK `Runner` + `OllamaLlm` with a fake fetch serving recorded Ollama NDJSON. Covers text streaming, tool-call round trip, unknown tool, invalid args, structured output (valid, invalid, wrapped in `<think>`/fences), abort mid-stream and mid-tool, and timeouts.
- **Parity tests:** existing chat, research workflow and lifecycle suites parameterised over `agent.engine = legacy | adk`, with the same fixtures and expected step records, reports and citations.
- **Live tests (opt-in, `pnpm test:ollama`):** against local and remote Ollama. Covers tool calling, streamed tool calls, `format` schema, cancel and `num_ctx` on the configured model.
- **Security tests:**
  - Existing guards stay green.
  - New guards: no `LlmAgent` model given as a string, no code executors or built-in Google tools, `OTEL_*`/`GOOGLE_*` sanitised, no network calls to `*.googleapis.com` (fetch spy in tests).
- **Electron smoke test:** `pnpm dev` and `package:dir` start, chat streams, a research task runs, pauses, resumes and recovers after a forced quit. Manual checklist in `docs/manual-testing-research-agent.md`.

---

## 12. Open decisions for approval

1. **Bundle or externalise `@google/adk`.** Bundling keeps the current "only better-sqlite3 is external" convention. Externalising keeps the `child_process`-containing code out of our bundle but ships about 200 MB more `node_modules`.
2. **Package placement:** a new `packages/adk-runtime`, or a folder inside `packages/agent-runtime`.
3. **Chat history:** keep chat stateless (seed a per-stream session from renderer history; no behaviour change) or persist chat sessions in SQLite (new feature).
4. **Agentic tool use** (Phase 8): approve or defer.

## Appendix — Phase 0 spike (scratch only, not in repo)

- Fake `BaseLlm` + `LlmAgent` + `FunctionTool` (Zod v4) + `Runner` + `InMemorySessionService` on Node 22.23.4:
  - Tool round trip OK.
  - SSE partials OK.
  - Abort produced `INVOCATION_ABORTED` after 202 ms.
  - No outbound fetches.
  - Invalid structured output logged but stored.
  - Non-Gemini + tools + `outputSchema` → `set_model_response` injected.
- `adk-ollama@1.0.0` tarball inspected: `generateContentAsync(request, stream)` has no abort parameter.
- Electron 44.10.1 stack (releases.electronjs.org): Chromium 152.0.7977.169, Node 24.22.1, V8 15.2.
