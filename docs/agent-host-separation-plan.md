# Agent Host Separation Plan

Logical / package separation only. Agents stay **in-process** inside Electron main.
No utility process, no sidecar, no new agent↔main RPC.

**Status:** Phase 5 complete — all phases (0–5) implemented; see
`docs/agent-host-separation-phase0-report.md` … `phase5-report.md`. Process separation was
not part of this plan and is not done (§9).
**Master workflow:** run one phase → paste the phase report back into the planning chat → unlock the next phase.

---

## 1. Goal

Move agent composition out of `apps/desktop/src/main` into a new workspace package
`@rka/agent-host`, so Electron becomes a thin shell:

| Electron owns                                    | `@rka/agent-host` owns                                   |
| ------------------------------------------------ | -------------------------------------------------------- |
| Window, session, CSP                             | Engine selection (Chat / Research: legacy \| adk)        |
| Preload + Zod IPC                                | `ChatController`                                         |
| `safeStorage` / `userData` path                  | Dashboard + Research Tools **cores** (OS ports injected) |
| Native dialogs / `shell.openExternal`            | `createAgentHost(...)` composition root                  |
| Thin bootstrap that builds ports + registers IPC | Wiring of Ollama, tools, storage, runtimes               |

**Non-goals**

- Process isolation / Electron `utilityProcess`
- Changing renderer IPC contracts in `@rka/shared`
- Changing ADK or Legacy engine behaviour
- New LLM providers (Ollama only)
- Unrelated refactors

---

## 2. Why a new package (not `@rka/agent-runtime`)

Existing ESLint DAG forbids either runtime depending on the other:

```text
@rka/shared
    ▲
@rka/model-provider / @rka/tools / @rka/storage
    ▲
@rka/agent-runtime ──╳──► @rka/adk-runtime   (forbidden either way)
    ▲                         ▲
    └──── @rka/agent-host ────┘   ← may depend on both
              ▲
         apps/desktop main        ← thin Electron adapter only
```

Today `chat-engine.ts` and `research-engine.ts` import **both** runtimes. They cannot
move into either runtime package without breaking the boundary. Composition in
`apps/desktop/src/main/index.ts` is the remaining coupling.

`@rka/agent-runtime`’s package description already says it is Electron-agnostic and
may later run in a utility process. This plan only prepares the **logical** host; it
does **not** introduce a second process.

---

## 3. Current architecture (as of this plan)

```text
Renderer (Vue, sandboxed)
  └── preload (window.api)
        └── IPC (Zod contracts in @rka/shared)
              └── Electron main = composition root
                    ├── ChatController + chat/research engine selectors
                    ├── AgentRuntime (@rka/agent-runtime)
                    ├── AdkRuntime (@rka/adk-runtime) — lazy via loadAdkRuntime()
                    ├── OllamaProvider (@rka/model-provider)
                    ├── ToolRegistry + web tools (@rka/tools)
                    └── Storage SQLite (@rka/storage)
```

### Coupling inventory (move candidates)

| File under `apps/desktop/src/main/`                              | Role                                            | Target                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `chat-engine.ts` (+ unit/integration/live tests)                 | Chat engine select + web search gateway wiring  | `@rka/agent-host`                                       |
| `research-engine.ts` (+ tests)                                   | Research engine pin + `researchTaskModelsFor`   | `@rka/agent-host`                                       |
| `chat.ts` (+ tests)                                              | `ChatController`, `ChatEventSink`, usage        | `@rka/agent-host`                                       |
| `dashboard.ts` (+ tests that are host-agnostic)                  | Tasks/sources/reports/storage façade            | `@rka/agent-host` (inject `chooseBackupPath`)           |
| `research-tools.ts` (+ tests)                                    | Research Tools playground                       | `@rka/agent-host` (inject `chooseFile`, `openExternal`) |
| `config/services.ts` pieces used by engines (`taskModelsFor`, …) | As needed for engines / host                    | Prefer host; leave Electron-only config in main         |
| Wiring block in `index.ts`                                       | Storage→provider→tools→runtime→engines→services | `createAgentHost` in host                               |

### Stays in Electron main

| File / concern                                | Why                                     |
| --------------------------------------------- | --------------------------------------- |
| `window.ts`, `security.ts`, `ipc.ts`, preload | Shell / trust boundary                  |
| `app-storage.ts`                              | `safeStorage` + `userData`              |
| `env.ts`, settings file next to userData      | Electron paths                          |
| Dialog / shell adapters                       | OS UI                                   |
| Thin `bootstrap()` in `index.ts`              | Builds ports, calls host, registers IPC |

---

## 4. Hard constraints (every phase)

Copy these into every Claude prompt (also restated per phase):

1. **Ollama only** — no Claude / Gemini / OpenAI cloud inference; do not send prompts/docs to cloud model APIs.
2. **Packages must not import `electron`.**
3. **Single package entry:** `exports["."]` → `src/index.ts`; no deep `@rka/*/*` imports.
4. **`@rka/agent-runtime` must not depend on `@rka/adk-runtime` and vice versa.**
5. **Renderer / preload may import only `@rka/shared`** (plus `electron` in preload).
6. **Zod-validate** external input; keep IPC contracts in `@rka/shared` stable unless a phase explicitly requires a shared-type move (prefer not).
7. **Do not execute shell commands** from agent tools; no file deletes; write actions need approval paths already in place.
8. **No process split** in this plan.
9. **No unrelated refactors**; do not overwrite unrelated user work.
10. After meaningful changes run: `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` (or the narrowest equivalent that still covers touched packages). Prefer `pnpm check` when the phase claims completion.
11. Follow `CLAUDE.md` engineering and agent standards.
12. Write a **phase report** at the end (template in §7).

---

## 5. Phases overview

| Phase | Name                          | Outcome                                                              |
| ----- | ----------------------------- | -------------------------------------------------------------------- |
| **0** | Scaffold + HostPorts contract | Empty `@rka/agent-host` + ports types + ESLint/workspace/README      |
| **1** | Extract engines               | `chat-engine` + `research-engine` live in host; desktop imports them |
| **2** | Extract ChatController        | Chat session control in host; sinks stay injectable                  |
| **3** | Extract host services         | Dashboard + Research Tools cores in host with OS ports               |
| **4** | Extract composition root      | `createAgentHost`; `index.ts` thin adapter                           |
| **5** | Boundaries + acceptance       | ESLint harden, docs sync, thin-main checklist, full `pnpm check`     |

**Rule:** do not start phase _N+1_ until phase _N_ report is reviewed and accepted.

---

## 6. Phase details + Claude prompts

Each prompt below is **self-contained**. Paste **only that phase’s prompt** into a fresh Claude session (with repo access). Do not ask Claude to implement later phases in the same run.

---

### Phase 0 — Scaffold + HostPorts contract

**Goal:** Create `@rka/agent-host` with ports/types only. No behaviour move.

**In scope**

- New package under `packages/agent-host/` mirroring sibling packages (`package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`).
- `HostPorts` (or equivalent) interface documenting injectable OS/app capabilities the host will need later: e.g. event fan-out to UI, backup/file dialogs, open external URL, encryption availability / secret accessors as **types only** if needed for the contract comment — keep the first cut minimal and honest.
- Workspace + desktop `devDependencies` entry for `@rka/agent-host`.
- ESLint: ban `@rka/agent-host` from renderer/preload; allow host to depend on agent-runtime + adk-runtime + leaf packages; host must not import `electron`; agent-runtime/adk-runtime must still not import host or each other.
- Update root `README.md` package map / DAG to include `@rka/agent-host` and note that engines will move here.
- Minimal smoke test that the package exports compile (e.g. type-only or trivial export test).

**Out of scope**

- Moving `chat-engine`, `ChatController`, dashboard, research-tools, or `index.ts` wiring.
- Behaviour changes.

**Acceptance**

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` pass.
- Desktop can `import` from `@rka/agent-host` (even if unused beyond a type or re-export probe — prefer a real dependency declaration without dead production wiring).
- No `electron` import in the new package.

#### Claude prompt — Phase 0

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Host Separation Phase 0 only**: scaffold `@rka/agent-host` and the HostPorts contract. Do NOT move chat/research engines, ChatController, dashboard, research-tools, or the composition root yet.

## Context
- Product: Windows Electron + Vue research assistant; Ollama only; packages under packages/*, app under apps/desktop.
- Goal of the whole effort (later phases): logical/package separation so Electron main becomes a thin shell; agents stay in-process (NO utility process).
- Master plan: docs/agent-host-separation-plan.md
- Why a new package: chat-engine.ts and research-engine.ts import BOTH @rka/agent-runtime and @rka/adk-runtime. Those two packages must never depend on each other (ESLint DAG). Composition today lives in apps/desktop/src/main/index.ts.

## Target package layout (mirror siblings)
- packages/agent-host/package.json — name `@rka/agent-host`, private, type module, single export "." → src/index.ts
- dependencies (workspace:*): @rka/shared, @rka/model-provider, @rka/tools, @rka/storage, @rka/agent-runtime, @rka/adk-runtime (declare now even if Phase 0 barely uses them)
- tsconfig extends ../../tsconfig.base.json; vitest.config.ts like agent-runtime
- src/index.ts exports HostPorts (and any small related types)
- description: Electron-agnostic agent host composition layer (in-process; not a separate process)

## HostPorts (Phase 0)
Define a clear TypeScript interface for capabilities Electron will inject later. Keep it minimal but aligned with real call sites in apps/desktop/src/main/index.ts:
- emitResearchProgress / emitSettingsChanged (or a generic sendToUi) — UI fan-out without BrowserWindow
- chooseBackupPath, chooseFile, chooseFolder — return string | null
- openExternal(url: string) — Promise<void>
- Optional: encryptionAvailable, getSecret — only if you can type them without pulling Electron types
Do NOT implement adapters. Types + JSDoc referencing future Electron adapters are enough.
Add a tiny unit test that imports the package entry and asserts the export surface exists (or type-level smoke).

## Wiring
- Add dependency from apps/desktop to @rka/agent-host (devDependencies, same pattern as other @rka/* packages).
- Update eslint.config.js:
  - Ban @rka/agent-host from renderer and preload (alongside other runtime packages).
  - Ensure packages/*/src cannot import electron (already global) and cannot deep-import @rka/*/*.
  - Do NOT let agent-runtime or adk-runtime import @rka/agent-host.
  - Leaf packages still depend only on @rka/shared.
- Update README.md Structure / Package boundaries to show @rka/agent-host above both runtimes and below Electron main.
- pnpm-workspace already includes packages/* — no change needed unless something else is required.

## Constraints
- Ollama only; no cloud LLM APIs.
- No electron imports in packages.
- No behaviour changes to Chat/Research/IPC.
- No process split.
- No unrelated refactors.
- TypeScript strict; small testable modules; Zod already used elsewhere — not required for HostPorts itself.

## Definition of Done
1. Package exists and is typecheck-clean.
2. ESLint boundaries updated; pnpm lint passes.
3. README DAG updated.
4. pnpm test and pnpm build pass.
5. Write docs/agent-host-separation-phase0-report.md using the report template in docs/agent-host-separation-plan.md §7.

## Out of scope
Moving any engine/controller/service code; createAgentHost implementation; IPC changes.
```

---

### Phase 1 — Extract engines

**Goal:** Move Chat and Research engine selectors into `@rka/agent-host`.

**In scope**

- Move `apps/desktop/src/main/chat-engine.ts` → `packages/agent-host/src/…`
- Move `apps/desktop/src/main/research-engine.ts` → host (including `researchTaskInfo`, pinning helpers)
- Move or relocate `taskModelsFor` (from `config/services.ts`) if research-engine needs it without pulling Electron-only config — prefer host-owned helper; leave Ollama/web appliers in main if they stay Electron-wired
- Update all desktop imports/tests (unit/integration/live/bench) to import from `@rka/agent-host`
- Re-export from desktop **only if** needed for a short compatibility shim; prefer deleting shims in the same phase if cheap

**Out of scope**

- Moving `ChatController`, dashboard, research-tools, or full `index.ts` composition
- Changing engine behaviour / flags / pinning semantics

**Acceptance**

- Behaviour identical (same schemas, env vars `AGENT_ENGINE` / `RESEARCH_ENGINE`, pinning key)
- Engine unit tests live with the host (or still pass from desktop importing host)
- `pnpm check` (or typecheck+lint+test+build) passes
- Host still has zero `electron` imports

#### Claude prompt — Phase 1

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Host Separation Phase 1 only**: move Chat and Research engine selection modules into `@rka/agent-host`. Do NOT move ChatController, dashboard, research-tools, or createAgentHost yet.

## Prerequisites
Phase 0 must already exist: packages/agent-host with HostPorts, workspace/ESLint/README wiring. Read docs/agent-host-separation-plan.md and docs/agent-host-separation-phase0-report.md if present.

## What to move
From apps/desktop/src/main/:
- chat-engine.ts (and its co-located unit tests that purely test engines — prefer packages/agent-host/src)
- research-engine.ts (and research-engine*.test.ts that test engines/pinning/researchTaskInfo)
- Any helper research-engine imports from config/services.ts (e.g. taskModelsFor). If taskModelsFor is entangled with Electron/settings appliers, extract ONLY the pure helper into the host and leave Ollama/web appliers in main.

Public API should continue to export (names may stay the same):
- AgentEngineSchema, parse helpers, createAppChatEngines, createChatWebSearch, legacyChatEngine, ChatEngine types
- ResearchEngineSchema, researchTaskModelsFor, researchTaskInfo, pinning helpers, env constants

## Desktop updates
- apps/desktop/src/main/index.ts, chat.ts, dashboard.ts, ipc tests, integration/live/bench tests: import engines from `@rka/agent-host` instead of relative paths.
- Remove vacated files from main once imports are updated.
- Do not change IPC contracts or renderer code unless an import path forces a type re-export — prefer importing types from `@rka/agent-host` or `@rka/shared`.

## Constraints
- Preserve behaviour: legacy|adk flags, AGENT_ENGINE / RESEARCH_ENGINE, chat.webSearch + ToolGateway policy, research engine pinning in task model config.
- @rka/agent-runtime must NOT import @rka/adk-runtime (host may import both).
- No electron in packages.
- Ollama only; no process split; no unrelated refactors.
- Validate with Zod where those modules already do.

## Tests
- Move engine-focused unit tests into packages/agent-host when practical.
- Keep Electron/integration/live tests in apps/desktop but point them at the host exports.
- Run pnpm typecheck, pnpm lint, pnpm test, pnpm build (and live tests only if already required by CI/scripts you touch — do not expand live scope).

## Definition of Done
1. Engines live in @rka/agent-host and are exported from its index.
2. Desktop no longer owns chat-engine.ts / research-engine.ts implementations.
3. Checks pass.
4. Write docs/agent-host-separation-phase1-report.md (§7 template).

## Out of scope
ChatController move; dashboard/research-tools move; createAgentHost; IPC redesign.
```

---

### Phase 2 — Extract ChatController

**Goal:** Move chat session control into the host; keep renderer sinks injectable.

**In scope**

- Move `ChatController`, `ChatEventSink`, `ChatUsage`, `toChatError`, related helpers from `chat.ts`
- Host must not depend on Electron `webContents` — keep `ChatEventSink` as the port
- Update `app-storage.ts` / usage recorder imports if they reference `ChatUsage` from main
- Update ipc.ts and tests to import controller from host

**Out of scope**

- Moving dashboard / research-tools / full composition
- Changing ChatEvent schema or one-stream-at-a-time policy

**Acceptance**

- Same IPC behaviour for `chat:start` / `chat:stop` / `chat:event`
- Unit tests for ChatController pass from host or desktop
- No electron in host

#### Claude prompt — Phase 2

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Host Separation Phase 2 only**: move ChatController into `@rka/agent-host`. Do NOT extract dashboard/research-tools or createAgentHost yet.

## Prerequisites
Phases 0–1 done: engines already live in @rka/agent-host. Read docs/agent-host-separation-plan.md and phase0/phase1 reports if present.

## What to move
From apps/desktop/src/main/chat.ts:
- ChatController class
- ChatEventSink, ChatControllerDeps, ChatUsage
- toChatError (and any pure helpers)
Update consumers:
- apps/desktop/src/main/index.ts (still constructs ChatController with selectEngine from host engines)
- apps/desktop/src/main/ipc.ts
- apps/desktop/src/main/app-storage.ts (ChatUsage type)
- chat*.test.ts / integration / live tests

## Design rules
- ChatEventSink remains the abstraction for sending ChatEvent to a renderer. Electron webContents adapters stay in desktop (or inline in index/ipc).
- ChatController continues to: one active stream; Zod-validate start/stop payloads via @rka/shared; map ModelProviderError to ChatErrorCode; call onUsage once per completed reply.
- selectEngine?: () => ChatEngine comes from host engine APIs (already moved in Phase 1).

## Constraints
- No electron imports in @rka/agent-host.
- Do not change ChatEvent / ChatStartRequest contracts in @rka/shared.
- Ollama only; no process split; no unrelated refactors.
- Keep behaviour identical.

## Tests
Move pure ChatController unit tests into the host if they do not need Electron. Leave IPC registration tests in desktop.
Run pnpm typecheck, pnpm lint, pnpm test, pnpm build.

## Definition of Done
1. ChatController exported from @rka/agent-host.
2. apps/desktop/src/main/chat.ts removed or reduced to a thin Electron sink adapter only (prefer full removal if sinks are created at IPC boundary).
3. Checks pass.
4. Write docs/agent-host-separation-phase2-report.md (§7 template).

## Out of scope
dashboard/research-tools move; createAgentHost; engine behaviour changes.
```

---

### Phase 3 — Extract host services (dashboard + research-tools)

**Goal:** Move service cores into the host; inject OS ports.

**In scope**

- Move `createDashboardService` / types; keep `chooseBackupPath` injected
- Move `createResearchToolsService` / types; keep `chooseFile` and `openExternal` injected
- Update ipc.ts and tests
- Align HostPorts with the real deps interfaces (refine Phase 0 types if needed)

**Out of scope**

- Full `createAgentHost` extraction (may still wire services in `index.ts`)
- Changing Research Tools security (path tokens, TTL, SSRF, openExternal allowlist)

**Acceptance**

- Same Zod in/out behaviour for dashboard and research-tools IPC
- Host has no electron / dialog / shell imports
- Checks pass

#### Claude prompt — Phase 3

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Host Separation Phase 3 only**: move Dashboard and Research Tools service cores into `@rka/agent-host`, with OS capabilities injected. Do NOT extract createAgentHost / thin index.ts yet (wiring may remain in desktop index).

## Prerequisites
Phases 0–2 done (host package, engines, ChatController). Read docs/agent-host-separation-plan.md and prior phase reports.

## What to move
From apps/desktop/src/main/:
- dashboard.ts → host (createDashboardService, DashboardDeps, DashboardService type)
- research-tools.ts → host (createResearchToolsService, ResearchToolsDeps, constants like PLAYGROUND_TASK_KIND if exported)
Update ipc.ts, index.ts, and tests to import from @rka/agent-host.

## Ports (must stay injected from Electron)
- chooseBackupPath: () => Promise<string | null>
- chooseFile: () => Promise<string | null>
- openExternal: (url: string) => Promise<void>
Refine HostPorts in the host package so these match. Electron dialog/shell implementations remain in apps/desktop/src/main/index.ts (or tiny adapter modules next to it).

## Security — do not regress
- Research Tools: file paths never cross IPC (token TTL); local extract never saved as model-bound source inappropriately; openExternal only for safe http(s) URLs (existing checks may stay in Electron adapter AND/OR service — keep current guarantees).
- Dashboard backup overwrite confirmation remains the responsibility of the injected chooser.

## Constraints
- No electron in host.
- No IPC contract changes in @rka/shared unless absolutely required (prefer none).
- Ollama only; no process split; no unrelated refactors.
- Preserve Zod parse/response validation behaviour.

## Tests
Move host-agnostic unit tests into packages/agent-host. Keep tests that stub dialogs in desktop or pass fake ports into host tests.
Run pnpm typecheck, pnpm lint, pnpm test, pnpm build.

## Definition of Done
1. Dashboard + Research Tools cores exported from @rka/agent-host.
2. desktop index only supplies port implementations + constructs services via host factories.
3. Checks pass.
4. Write docs/agent-host-separation-phase3-report.md (§7 template).

## Out of scope
createAgentHost extraction; moving RuntimeConfig / SettingsService / app-storage; process split.
```

---

### Phase 4 — Extract composition root (`createAgentHost`)

**Goal:** Move the wiring currently in `bootstrap()` into the host; Electron `index.ts` becomes a thin adapter.

**In scope**

- Implement `createAgentHost(deps)` (name may vary) that:
  - Accepts already-opened `Storage` (or a storage factory port), `ModelProvider` / reconfigurable web services / config accessors as needed
  - Builds source store, tool registry, `createAgentRuntime`, engine selectors, ChatController, dashboard, research-tools
  - Returns handles needed by IPC registration
- Thin `apps/desktop/src/main/index.ts`: load env, openAppStorage with safeStorage, create RuntimeConfig, create Ollama provider + appliers, build HostPorts from BrowserWindow/dialog/shell, call `createAgentHost`, `registerIpcHandlers`, window lifecycle
- Keep settings/ollama settings services in desktop if they are tightly bound to Electron; only move what is clearly host composition

**Out of scope**

- Process split
- Rewriting RuntimeConfig
- Changing startup recovery semantics

**Acceptance**

- App boots and wires identically
- `index.ts` no longer inlines engine/runtime construction beyond calling the host
- Checks pass; smoke of packaging scripts still coherent (no broken imports)

#### Claude prompt — Phase 4

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Host Separation Phase 4 only**: extract `createAgentHost` composition so apps/desktop/src/main/index.ts becomes a thin Electron adapter. Do NOT introduce a utility process or change IPC contracts.

## Prerequisites
Phases 0–3 done: host has engines, ChatController, dashboard, research-tools. Read docs/agent-host-separation-plan.md and prior reports.

## Target design
Electron main (index.ts) should roughly:
1. installConsoleRedaction, single-instance lock, load env/settings files
2. openAppStorage({ userDataDir, cipher: safeStorage })
3. createRuntimeConfig(...)
4. create Ollama provider + web services + register config appliers (may stay in desktop if still Electron-tied)
5. Build HostPorts from BrowserWindow / dialog / shell / safeStorage
6. const host = createAgentHost({ storage, modelProvider, webServices, config ports, hostPorts, ... })
7. registerIpcHandlers(ipcMain, { runtime: host.runtime, chat: host.chat, dashboard: host.dashboard, researchTools: host.researchTools, settings... })
8. windows, security session, startup probes (ADK probe may stay in desktop)

createAgentHost lives in @rka/agent-host and must not import electron.

## What to move into createAgentHost
From today’s index.ts wiring (inspect current file):
- createSourceStore, createToolRegistry(createWebTools(...))
- createAgentRuntime({ ..., taskModels: researchTaskModelsFor(...), onResearchEvent via port })
- ChatController + createAppChatEngines + createChatWebSearch
- createDashboardService / createResearchToolsService with injected ports

## What stays in Electron
- app-storage, window, security, ipc registration, env/settings file paths
- dialog/shell implementations of ports
- SettingsService / OllamaSettingsService if still coupled to RuntimeConfig + Electron folder picker (OK to leave)
- probeAdkRuntime, checkStartup, Menu, session CSP

## Constraints
- Preserve research progress fan-out and settings change fan-out behaviour (via ports).
- Preserve recovery logging for interrupted tasks.
- Ollama only; packages Electron-agnostic; no process split; no unrelated refactors.
- Keep Zod validation and existing error messages where user-visible.

## Tests
Update desktop tests that constructed the old graph manually to use createAgentHost with fake ports where helpful.
Run pnpm typecheck, pnpm lint, pnpm test, pnpm build.

## Definition of Done
1. createAgentHost exported from @rka/agent-host.
2. index.ts bootstrap is visibly thinner; no duplicated engine/runtime wiring left outside the host.
3. Checks pass.
4. Write docs/agent-host-separation-phase4-report.md (§7 template).

## Out of scope
ESLint final harden beyond what’s needed; process separation; settings UI changes.
```

---

### Phase 5 — Boundaries + acceptance

**Goal:** Harden architecture rules and prove the thin-main end state.

**In scope**

- ESLint: ensure desktop main does not need to import `@rka/adk-runtime` for production paths if only the host should (probe may still import loadAdkRuntime — document exception or move probe behind host API)
- Prefer: production composition imports `@rka/agent-host` + leaf packages as needed; avoid re-implementing engines in main
- README + `docs/user-guide.md` short note if architecture description is stale; keep this plan’s status updated
- Thin-main checklist (document evidence in the phase report):
  - [ ] No `chat-engine.ts` / `research-engine.ts` / `ChatController` implementation left in main
  - [ ] No `createDashboardService` / `createResearchToolsService` implementation left in main
  - [ ] `createAgentHost` is the composition entry for agent wiring
  - [ ] Host has zero `electron` imports
  - [ ] agent-runtime ╳ adk-runtime still holds
  - [ ] Renderer/preload still only `@rka/shared`
- Full `pnpm check`

**Out of scope**

- New features
- Process split

#### Claude prompt — Phase 5

```text
You are the senior engineer for this monorepo (see CLAUDE.md).

## Task
Implement **Agent Host Separation Phase 5 only**: harden package boundaries, sync docs, and produce the acceptance report. No new features. No process split.

## Prerequisites
Phases 0–4 done. Read docs/agent-host-separation-plan.md and all phase reports.

## Work
1. Audit apps/desktop/src/main for leftover agent composition that should live in @rka/agent-host. Fix only clear leftovers from this separation (no drive-by refactors).
2. ESLint / import rules:
   - Confirm renderer/preload ban @rka/agent-host and other runtime packages.
   - Confirm packages cannot import electron.
   - Confirm agent-runtime and adk-runtime do not import each other or agent-host.
   - If main still imports @rka/adk-runtime only for probeAdkRuntime, either leave a documented exception or expose a thin host.probeAdk() — choose the smaller change; document it.
3. Update README Structure / Package boundaries to the final DAG (agent-host between runtimes and Electron).
4. Update docs/agent-host-separation-plan.md status to “Phase 5 complete” (or add a short completion note at the top).
5. Run full pnpm check (typecheck + lint + format:check + test + build). Fix failures caused by this work.

## Thin-main checklist (must be evidenced in the report)
- No chat-engine / research-engine / ChatController / dashboard / research-tools implementations left in main
- createAgentHost is the agent composition entry
- Host has zero electron imports
- agent-runtime ╳ adk-runtime still holds
- Renderer/preload → @rka/shared only

## Definition of Done
1. Checklist satisfied with file-path evidence.
2. pnpm check passes.
3. Write docs/agent-host-separation-phase5-report.md (§7 template) including residual risks and explicitly stating process separation is NOT done (out of scope).

## Out of scope
Utility process, IPC redesign, ADK behaviour changes, new tools/features.
```

---

## 7. Phase report template

Each phase writes `docs/agent-host-separation-phaseN-report.md`:

```markdown
# Agent Host Separation — Phase N Report

## Summary

- Status: complete | blocked | partial
- One-paragraph outcome

## Changes

- Files added / moved / deleted (paths)
- Public API changes on `@rka/agent-host`

## Boundaries

- electron imports in host? (must be none)
- agent-runtime ↔ adk-runtime? (must remain disconnected)
- renderer/preload still shared-only?

## Checks run

- pnpm typecheck: pass/fail
- pnpm lint: pass/fail
- pnpm test: pass/fail
- pnpm build: pass/fail
- (phase 5) pnpm check / format:check

## Behaviour

- Intentional behaviour changes? (should be none)
- Follow-ups / known gaps for later phases

## Risks / decisions

- Any deviation from docs/agent-host-separation-plan.md and why
```

When you paste the report into the planning chat, also note anything Claude skipped or reinterpreted so the next phase prompt can be adjusted.

---

## 8. Suggested order of operations (human)

1. Paste **Phase 0** prompt into Claude → review PR/diff + `phase0-report.md`
2. Paste report into planning chat → confirm → receive go-ahead for Phase 1 (prompt already in this file)
3. Repeat through Phase 5
4. After Phase 5, treat `@rka/agent-host` as the only place for new agent composition code

---

## 9. Residual future work (explicitly NOT this plan)

- Electron `utilityProcess` for agents (would need security-policy exception vs current `child_process` bans, plus a real host↔shell protocol)
- Moving `RuntimeConfig` / SettingsService into a shared package
- Deduplicating live/bench test graphs onto `createAgentHost` further than Phase 4/5 require

---

## 10. Reference paths

| Path                                       | Notes                                      |
| ------------------------------------------ | ------------------------------------------ |
| `CLAUDE.md`                                | Project standards                          |
| `apps/desktop/src/main/index.ts`           | Current composition root                   |
| `apps/desktop/src/main/chat-engine.ts`     | Phase 1 move                               |
| `apps/desktop/src/main/research-engine.ts` | Phase 1 move                               |
| `apps/desktop/src/main/chat.ts`            | Phase 2 move                               |
| `apps/desktop/src/main/dashboard.ts`       | Phase 3 move                               |
| `apps/desktop/src/main/research-tools.ts`  | Phase 3 move                               |
| `apps/desktop/src/main/ipc.ts`             | Stays; updates imports                     |
| `packages/agent-runtime`                   | Research step machine, ToolGateway — stays |
| `packages/adk-runtime`                     | Lazy ADK boundary — stays                  |
| `packages/shared/src/ipc.ts`               | Renderer↔main contracts — keep stable      |
| `eslint.config.js`                         | Architecture bans                          |
| `docs/phase8.1-tool-architecture-audit.md` | Tool/gateway architecture context          |
| `docs/adk-migration-assessment.md`         | Historical “stay in main process” decision |
