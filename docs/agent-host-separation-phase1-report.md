# Agent Host Separation — Phase 1 Report

## Summary

- Status: **complete**
- The Chat and Research engine selection modules now live in `@rka/agent-host`, together
  with the pure `taskModelsFor` helper they build on. Both were moved with `git mv`
  (history preserved) with no logic changes. Every desktop consumer (main, integration,
  live, lifecycle and bench code) imports them from `@rka/agent-host`; no compatibility
  shims remain in `apps/desktop/src/main`. `ChatController`, dashboard, research-tools
  and the `index.ts` wiring were not moved.

## Changes

- Moved (`git mv`, content otherwise unchanged except imports and two comment path fixes)
  - `apps/desktop/src/main/chat-engine.ts` → `packages/agent-host/src/chat-engine.ts`
  - `apps/desktop/src/main/research-engine.ts` → `packages/agent-host/src/research-engine.ts`
  - `apps/desktop/src/main/chat-engine.test.ts` → `packages/agent-host/src/chat-engine.test.ts`
  - `apps/desktop/src/main/research-engine.test.ts` → `packages/agent-host/src/research-engine.test.ts`
- Added
  - `packages/agent-host/src/task-models.ts` — `taskModelsFor`, moved verbatim from
    `apps/desktop/src/main/config/services.ts` (pure: `OllamaProvider` + `OllamaConfigSchema`,
    no Electron, no settings/appliers).
  - `docs/agent-host-separation-phase1-report.md` (this file).
- Modified — host
  - `packages/agent-host/src/index.ts` — exports below.
  - `packages/agent-host/package.json` — `zod` in `devDependencies` (same pin and pattern
    as `agent-runtime` / `adk-runtime`; the code is bundled by the desktop app).
- Modified — desktop (imports only unless noted)
  - Production: `src/main/index.ts`, `src/main/chat.ts`, `src/main/dashboard.ts`.
  - `src/main/config/services.ts` — `taskModelsFor` removed (plus its now-unused
    `TaskModelConfig` import). Ollama/web appliers and settings services stay.
  - Tests / tooling: `chat-engine.integration.test.ts`, `chat-engine.live.test.ts`,
    `chat-web-search.integration.test.ts`, `research-engine.integration.test.ts`,
    `research-engine.live.test.ts`, `remote-ollama.test.ts`, `lifecycle/test-fixtures.ts`,
    `lifecycle/process-crash.test.ts`, `config/services.test.ts`, `config/precedence.test.ts`,
    `src/bench/runner.ts`.
  - `chat.test.ts` — received the three `ChatController engine selection` cases that were
    in the old `chat-engine.test.ts` (they test the controller, which stays in desktop).
  - `security.test.ts` — received the `isAllowedSetting(AGENT_ENGINE / RESEARCH_ENGINE)`
    assertions from the old engine tests (`settings.env` allow-list is Electron-side).
  - `security-guards.test.ts` — see Boundaries.
- Docs: `README.md` (one sentence: engines now live in the host), `docs/security.md`
  (control → file table path `desktop/main/chat-engine.ts` → `agent-host/src/chat-engine.ts`;
  Prettier re-padded that table's columns, which accounts for the rest of its diff).
- `pnpm-lock.yaml` — `zod` devDependency entry for `packages/agent-host`.
- Deleted: none beyond the moved files.

### Public API of `@rka/agent-host` (added this phase)

| Module               | Exports                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat-engine.ts`     | `AgentEngineSchema`, `AGENT_ENGINE_ENV`, `DEFAULT_AGENT_ENGINE`, `parseAgentEngine`, `legacyChatEngine`, `adkChatEngine`, `createChatEngineSelector`, `createAppChatEngines`, `createChatWebSearch`, types `AgentEngine`, `ChatEngine`, `ChatEngineSelectorOptions`, `ChatWebSearch` |
| `research-engine.ts` | `ResearchEngineSchema`, `RESEARCH_ENGINE_ENV`, `DEFAULT_RESEARCH_ENGINE`, `PINNED_ENGINE_KEY`, `parseResearchEngine`, `pinnedEngine`, `researchTaskInfo`, `researchTaskModelsFor`, types `ResearchEngine`, `ResearchTaskModelsOptions`                                               |
| `task-models.ts`     | `taskModelsFor`                                                                                                                                                                                                                                                                      |

Names are identical to the old desktop exports. `HostPorts` types from Phase 0 are unchanged.
`LazyAdkResearchModel` / `UnknownEngineModel` remain private to `research-engine.ts`.

## Boundaries

- **electron imports in host?** None (`packages/**` has no `from 'electron'`; ESLint rule from
  Phase 0 still applies).
- **agent-runtime ↔ adk-runtime?** Still disconnected. The only package importing both is
  `@rka/agent-host` (`chat-engine.ts`, `research-engine.ts`), which is exactly the reason the
  host exists. `pnpm lint` passes with the Phase 0 rules unchanged.
- **renderer/preload still shared-only?** Yes; no renderer or preload file changed.
- **Security guards follow the code.** `security-guards.test.ts` scans a fixed list of
  source roots and allow-lists files by path. Without an update, moving the engines would
  have silently taken them _out_ of the scan. Changes:
  - `packages/agent-host/src` added to the scanned roots.
  - The two allow-list entries for `apps/desktop/src/main/chat-engine.ts` (the only
    `withToolCalling()` caller and the only `streamChatWithTools` consumer outside
    agent-runtime) now point to `packages/agent-host/src/chat-engine.ts`. The guards are as
    strict as before: still exactly one file each.
  - Scanning the host surfaced `openExternal(url: string)` in the Phase 0 type-only
    `ports.ts` (matches `openExternal\s*\(`). It is allow-listed with a comment; the only
    real `shell.openExternal` call is still in `apps/desktop/src/main/index.ts` / `window.ts`.

## Checks run

- `pnpm typecheck`: **pass** (root + all workspace projects).
- `pnpm lint`: **pass** (0 warnings).
- `pnpm test`: **pass** — 87 files / 1170 tests. The test count is unchanged on purpose:
  the 9 tests of the old desktop `chat-engine.test.ts` are now 5 in the host, 3 in
  `chat.test.ts` and 1 in `security.test.ts`; `research-engine.test.ts` keeps all 8.
  A first run had 2 `src/bench/bench.test.ts` failures (a 5 s timeout and a retry count
  of 2 instead of 0, i.e. a slow fake Ollama under parallel load); the file passed 25/25
  alone and the full suite passed on re-run without code changes to it.
- `pnpm build`: **pass**. The main bundle still contains the engine code (log strings
  `Chat engine: …`, `Research engine for the new task`, pin key `researchEngine`).
- `pnpm format:check`: only `docs/agent-host-separation-plan.md` is flagged. That file was
  not touched in this phase (`git diff HEAD` is empty for it); all files changed here are
  Prettier-clean. Left as is to avoid editing the plan without being asked.
- Live tests (`test:chat:ollama`, `test:research:ollama`, `bench:research:ollama`): not run
  (need a real Ollama). Their files only had import lines changed, they typecheck, and
  their file names are unchanged so the `chat-engine` / `research-engine` filters in the
  root `package.json` scripts still match.

## Behaviour

- Intentional behaviour changes: **none**.
  - `AGENT_ENGINE` / `RESEARCH_ENGINE` parsing, defaults and warning text: unchanged code.
  - `chat.webSearch` + ToolGateway policy (`web_search` only, `CHAT_TOOL_LIMITS`,
    `withToolCalling()` snapshot per request): unchanged code; guard tests still pin it.
  - Research pinning (`researchEngine` key in `task.input.model.config`, legacy tasks
    byte-identical, unknown pins never run on another engine, no ADK→legacy fallback):
    unchanged code; covered by the moved unit tests and the desktop integration tests.
  - Zod validation where it existed (`AgentEngineSchema`, `ResearchEngineSchema`,
    `TaskModelConfigSchema`, `OllamaConfigSchema`): unchanged.
- No IPC contract, `@rka/shared` or renderer change.
- Follow-ups / known gaps for later phases:
  - Phase 2: `ChatController` still imports `ChatEngine` / `legacyChatEngine` from the host;
    moving it will make that an internal import. The three controller engine-selection
    tests now in `apps/desktop/src/main/chat.test.ts` should move with it.
  - `chat-engine.ts` / `research-engine.ts` still default to `process.env` when no
    `readFlag` / `env` is passed (unchanged behaviour). Production always passes the
    effective setting; Phase 4 can decide whether the host should stop reading
    `process.env` itself.
  - Integration tests that need `RuntimeConfig` / dashboard / `ChatController`
    (`*-engine.integration.test.ts`, `chat-web-search.integration.test.ts`,
    `remote-ollama.test.ts`, lifecycle) stay in desktop until those modules move.

## Risks / decisions

- **`taskModelsFor` moved, not copied.** It had no Electron or settings coupling, and its
  only non-engine users were desktop tests, so it was removed from `config/services.ts`
  instead of leaving a re-export. `services.test.ts` / `precedence.test.ts` import it from
  the host.
- **Engine unit tests were split, not moved whole.** Cases that exercise `ChatController`
  or the Electron `settings.env` allow-list stay in desktop, because those modules have not
  moved; everything engine-only moved to the host.
- **`security-guards.test.ts` scope was extended** (new root + one allow-list entry) as
  described above. Without that, Phase 1 would have weakened two Phase 8.2 guards.
- **Docs:** updated only the living `README.md` and `docs/security.md` table. Historical
  phase reports (`adk-migration-*`, `phase8.*`) still cite the old desktop paths and were
  left as written records.
- `@rka/agent-host` exports `adkChatEngine` and `createChatEngineSelector` in addition to
  the names listed in the plan, because they were public exports of the desktop module.
  `createChatEngineSelector` is used by the host unit tests; `adkChatEngine` currently has
  no caller outside `chat-engine.ts` and could be made private later.
