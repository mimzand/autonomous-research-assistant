# ADK Migration — Phase 1 Report

_Safe migration preparation and `@google/adk` dependency spike. Date: 2026-11-12._

No production LLM call uses ADK yet. Chat, research and every other feature run on the existing code paths.

## 1. Repository

| Item                  | Value                                                 |
| --------------------- | ----------------------------------------------------- |
| Branch                | `Google-ADK-Migration` (existing branch, checked out) |
| Starting commit       | `6c69d5a05baee369800a387f981c5816a89e7091`            |
| Working tree at start | clean                                                 |

Changes are left uncommitted for review.

## 2. Baseline (before any change)

Run on Linux x64 with Node 22.23.4 and pnpm 12.16.1, after `pnpm install --frozen-lockfile`.

| Check               | Result                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | pass                                                                                           |
| `pnpm lint`         | pass                                                                                           |
| `pnpm format:check` | **fail**: `docs/adk-migration-assessment.md` (the Phase 0 document) was not Prettier-formatted |
| `pnpm test`         | pass: 48 files, 634 tests                                                                      |
| `pnpm build`        | pass                                                                                           |
| `pnpm package:dir`  | pass                                                                                           |

The only baseline failure came from the Phase 0 document. It was fixed by running Prettier on that file; no content changed.

## 3. Results after Phase 1

| Check                                         | Result                                          |
| --------------------------------------------- | ----------------------------------------------- |
| `pnpm typecheck`                              | pass                                            |
| `pnpm lint`                                   | pass                                            |
| `pnpm format:check`                           | pass                                            |
| `pnpm test`                                   | pass: 53 files, 663 tests (+5 files, +29 tests) |
| `pnpm build`                                  | pass                                            |
| `pnpm package:dir`                            | pass                                            |
| `pnpm install --frozen-lockfile` (fresh copy) | pass                                            |

## 4. Dependency changes

The only new direct dependency is `@google/adk` **2.4.0**, pinned exactly, in `packages/adk-runtime`. It is bundled into the main process, so it is not shipped in `node_modules`.

`pnpm-workspace.yaml` has three additions:

- **`allowBuilds: '@google/genai': false`:** its only install script is a no-op `echo`.
- **`allowBuilds: protobufjs: false`:** its postinstall only prints a version warning.
- **`ignoredOptionalDependencies: [dockerode]`:** `dockerode` is ADK's optional container code executor dependency. Excluding it also keeps out its native SSH stack (`ssh2`, `cpu-features`).

Lockfile effects on existing dependencies:

- **Versions:** no existing dependency changed version. Every importer resolves the same versions as before.
- **Peer-context keys:** only the keys changed, because optional peers are now present in the graph:
  - `supports-color@7.2.0` is now the optional peer of `debug`, which affects dev tooling only.
  - `@opentelemetry/api@1.10.0` is now the optional peer of `drizzle-orm` and `vitest`. Drizzle's tracing hook keeps `otel` undefined, so it stays a no-op.
- **Zod:** a single copy, `zod@4.6.7`, as before.

Known peer warning: inside ADK's own dependency tree, `@opentelemetry/api@1.10.0` is newer than its OpenTelemetry SDK packages declare (`<1.10.0`). The SDK is never activated (see §6), so it was left unchanged.

## 5. New and changed files

**New package `packages/adk-runtime`.** It does not depend on any other workspace package and never on the research workflow.

| File                | Purpose                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `src/adk.ts`        | The **only** module that imports `@google/adk`. Re-exports an approved allowlist only.    |
| `src/env.ts`        | Narrow environment sanitiser (see §6).                                                    |
| `src/runtime.ts`    | `loadAdkRuntime()`: sanitises the environment first, then dynamically imports the engine. |
| `src/engine.ts`     | The lazily loaded ADK-backed part.                                                        |
| `src/local-llm.ts`  | `LocalLlm`: the only model base class the guard accepts.                                  |
| `src/guards.ts`     | `assertSafeAgent()` and `createGuardedRunner()`.                                          |
| `src/self-check.ts` | Offline agent turn with a stand-in model (no Ollama, no network).                         |
| `src/*.test.ts`     | Environment, guard, network/telemetry and source-scan tests.                              |

**Desktop app:**

- **`src/main/adk-probe.ts` (+ test):** loads ADK after the window is created and logs the self-check result. It never throws, and the app works without ADK.
- **`src/main/index.ts`:** one import and one non-blocking `probeAdkRuntime()` call.
- **`package.json`:** `@rka/adk-runtime` added as a devDependency, because it is bundled.
- **`src/main/security-guards.test.ts`:** the existing guards now also scan `packages/adk-runtime/src`. No guard was weakened.

**Unchanged:** renderer, preload and IPC contracts. The production preload and renderer bundles are byte-identical to the baseline build.

## 6. Environment and telemetry

These variable names come from reading the installed `@google/adk@2.4.0` `dist/esm` source.

| Group                 | Variables                                                                                                                                                                                                                                 | Action  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| OTLP export           | `OTEL_EXPORTER_OTLP_ENDPOINT`, `…_TRACES_ENDPOINT`, `…_METRICS_ENDPOINT`, `…_LOGS_ENDPOINT`                                                                                                                                               | removed |
| Gemini / Vertex / GCP | `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GENAI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_AGENT_ENGINE_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | removed |
| ADK feature flags     | `ADK_ENABLE_*`, `ADK_DISABLE_*`                                                                                                                                                                                                           | removed |
| Forced                | `OTEL_SDK_DISABLED=true`, `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`                                                                                                                                                                    | set     |

All other variables are untouched. Only variable names are logged, never values.

ADK's `maybeSetOtelProviders()` is never called automatically. A test asserts that no OpenTelemetry tracer, meter or logger provider is registered.

**Network test (`network.test.ts`):**

- **Transports intercepted before ADK loads:** `fetch`, `http`/`https`/`http2`, `net.connect`, `net.Socket#connect` (covers undici and any raw TCP), `tls.connect`, `dgram`, `dns` and `WebSocket`.
- **Result:** loading ADK and running an agent turn, with OTEL and Google variables set, made **0** attempts.
- **Control tests:** they show that the interceptors catch each transport, and that they catch a real Gemini call made through ADK.

## 7. Electron smoke tests

All smoke tests ran on Linux x64 with Electron 44.10.1 (Node 24.22.1) under Xvfb.

| Test                                                        | Result                                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged `linux-unpacked`, non-root, OS sandbox on          | starts; log: `ADK runtime: @google/adk 2.4.0 loaded, self-check passed in 15 ms; removed 2 environment variable(s): OTEL_EXPORTER_OTLP_ENDPOINT, GOOGLE_API_KEY.` |
| Dev mode (`electron-vite dev`)                              | starts; same ADK log (10 ms)                                                                                                                                      |
| Renderer isolation                                          | `require`, `process`, `module`, `ipcRenderer` undefined; `window.api` frozen with the same 10 keys; production CSP unchanged                                      |
| Chat (existing path, against a local Ollama stand-in)       | 5 deltas + `done`; text identical to baseline                                                                                                                     |
| Task lifecycle (persistence check through the step machine) | `completed` with `check`, `generate`, `verify` steps; identical to baseline                                                                                       |
| Storage integrity check                                     | ok                                                                                                                                                                |
| Baseline vs Phase 1 (packaged)                              | normalised IPC results identical; identical Ollama request sequence                                                                                               |
| Outbound connections (`strace -e connect`)                  | identical to baseline: `127.0.0.1:11434` (Ollama stand-in) and the test sandbox's local HTTPS proxy (contacted by Chromium in both builds)                        |

**Not verified:** running the app on Windows. A Windows build was produced (portable zip) but could not be launched in this environment.

## 8. Bundle and package size

| Artifact                                | Baseline (bytes) | Phase 1 (bytes) |                                Change |
| --------------------------------------- | ---------------: | --------------: | ------------------------------------: |
| `out/main` total                        |        2,890,335 |       5,770,327 |                            +2,879,992 |
| `out/main/index.js` (loaded at startup) |          767,435 |         834,212 | +66,777 (Zod modules shared with ADK) |
| `chunks/engine-*.js` (ADK, lazy)        |                — |       2,550,826 |                                   new |
| `chunks/src-*.js` (`node-fetch`, lazy)  |                — |         213,976 |                                   new |
| other new lazy chunks                   |                — |          48,413 |                                   new |
| `out/preload`, `out/renderer`           |                — |               — |                        byte-identical |
| `app.asar`                              |        4,898,711 |       7,783,986 |                +2,885,275 (+2.75 MiB) |
| Linux unpacked app                      |      296,805,554 |     299,690,829 |                               +0.97 % |
| Windows unpacked app                    |      343,605,163 |     346,487,404 |                               +0.84 % |
| Windows portable zip                    |      143,930,155 |     144,458,693 |                **+528,538 (+0.37 %)** |

The Windows NSIS installer needs Wine to build, so its size was not measured. Because it is compressed like the zip, its increase is expected to be similar (about 0.5 MB).

## 9. Security review of the bundle

- **ADK modules bundled (200):** `UnsafeLocalCodeExecutor`, `ContainerCodeExecutor`, `AgentEngineSandboxCodeExecutor` and `LocalEnvironment` are **not in the bundle**. They were tree-shaken because nothing imports them.
- **`child_process` (3 references), all from `google-auth-library@10.9.1`:**
  - Dependency path: `@rka/adk-runtime → @google/adk@2.4.0 → @google/genai@2.32.0 / direct → google-auth-library@10.9.1`.
  - `auth/pluggable-auth-handler.js` runs executable-sourced external-account credentials.
  - `auth/googleauth.js` falls back to `gcloud config config-helper` for the project id.
  - Both run only when Google authentication runs, which requires a Gemini or Vertex model.
  - Blocked by: the `LocalLlm`-only guard, the facade not exporting Gemini, removal of `GOOGLE_APPLICATION_CREDENTIALS` (the credentials file that configures executables), and the source-scan tests.
- **`vm`:** from `jsonpath-plus@10.4.0`, used only by the Gemini streaming aggregator (`JSONPath.toPathArray`, which parses paths and evaluates nothing). Unreachable without a Gemini model.
- **Bundled but unreachable:** `models/google_llm.js` (Gemini), `apigee_llm.js`, `built_in_code_executor.js` (Gemini server-side execution), and `google_search_tool.js` / `url_context_tool.js` (inert module-level singletons). They are bundled because `LlmAgent` references them.
- **Regression tests added:**
  - The guard rejects `UnsafeLocalCodeExecutor`, `BuiltInCodeExecutor`, `ContainerCodeExecutor`, Gemini instances, model-name strings, missing models, any tool (`GOOGLE_SEARCH`, `FunctionTool`, `AgentTool`), planners, unsafe sub-agents and non-LLM agents.
  - Runners never get plugins, artifact, memory or credential services.
  - Only `adk.ts` imports `@google/adk`, and its exports match an allowlist.
  - No shipped source names any prohibited ADK class.
  - No shipped source imports a Google client library.

## 10. Remaining risks

- Windows runtime behaviour, the dev/packaged startup on Windows and the NSIS installer size still need verification on a Windows machine.
- ADK load time inside Electron was not measured separately. It is off the startup path (loaded after the window opens); the self-check itself takes 10–15 ms.
- Gemini and Google-auth code is bundled but unreachable. A future ADK upgrade could change what `LlmAgent` pulls in, so the bundle should be re-inspected on every ADK upgrade.
- The OpenTelemetry peer-range warning inside ADK's dependency tree.
- The startup `ADK runtime:` log line and self-check are temporary Phase 1 instrumentation.
