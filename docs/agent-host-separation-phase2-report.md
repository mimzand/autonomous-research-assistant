# Agent Host Separation — Phase 2 Report

## Summary

- Status: **complete**
- `ChatController` (with `ChatEventSink`, `ChatControllerDeps`, `ChatUsage`, `toChatError`)
  now lives in `@rka/agent-host` and is exported from its entry. `apps/desktop/src/main/chat.ts`
  is **removed**: the only Electron-specific piece, the webContents → `ChatEventSink`
  adapter, was already created inline at the IPC boundary (`registerIpcHandlers` in
  `ipc.ts`) and stays there unchanged. The controller code is unchanged apart from its
  engine import and two doc comments; IPC, `@rka/shared` contracts and the renderer are
  untouched.

## Changes

- Moved (`git mv`; content unchanged except imports and doc comments)
  - `apps/desktop/src/main/chat.ts` → `packages/agent-host/src/chat-controller.ts`
    - Imports `ChatEngine` / `legacyChatEngine` from `./chat-engine.js` (was `@rka/agent-host`).
    - `ChatEventSink` doc now says the Electron adapter is created in `ipc.ts`;
      class doc says it runs in the main process as part of the in-process host.
  - `apps/desktop/src/main/chat.test.ts` → `packages/agent-host/src/chat-controller.test.ts`
    (includes the three `ChatController engine selection` cases Phase 1 left in desktop).
  - `apps/desktop/src/main/chat.integration.test.ts` →
    `packages/agent-host/src/chat-controller.integration.test.ts` (ChatController →
    AgentRuntime → real OllamaProvider → local fake Ollama HTTP server; no Electron, no
    desktop modules, so it belongs with the controller).
- Modified — host: `packages/agent-host/src/index.ts` (new exports below).
- Modified — desktop (imports only)
  - Production: `src/main/index.ts` (`ChatController` from the host; construction and
    `selectEngine` / `onUsage` wiring unchanged), `src/main/ipc.ts` (type import),
    `src/main/app-storage.ts` (`ChatUsage` type).
  - Tests: `ipc.test.ts`, `chat-engine.integration.test.ts`, `chat-engine.live.test.ts`,
    `chat-web-search.integration.test.ts`, `remote-ollama.test.ts`.
- Docs: `README.md` Chat playground flow now reads `ChatController (@rka/agent-host, in main)`.
- Deleted: `apps/desktop/src/main/chat.ts` (no thin adapter needed; see Summary).
- No dependency or lockfile changes (the host already depended on everything the
  controller and its tests use).

### Public API of `@rka/agent-host` (added this phase)

| Module               | Exports                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `chat-controller.ts` | `ChatController`, `toChatError`, types `ChatControllerDeps`, `ChatEventSink`, `ChatUsage` |

Names and signatures are identical to the old desktop module. `ActiveStream` stays private.

## Boundaries

- **electron imports in host?** None (`packages/agent-host/src` has no `from 'electron'`).
  The controller uses only `node:crypto` (`randomUUID`), `@rka/agent-runtime`,
  `@rka/model-provider`, `@rka/shared` and the host's own `chat-engine.ts`.
- **agent-runtime ↔ adk-runtime?** Still disconnected; no runtime package changed.
- **renderer/preload still shared-only?** Yes; no renderer or preload file changed.
- `ChatEventSink` remains the only abstraction between the controller and a renderer;
  Electron's `WebContents` is still reduced to `SenderLike` in `ipc.ts`.
- `security-guards.test.ts` needed no change: it already scans `packages/agent-host/src`
  (Phase 1), and none of its allow-lists referenced `chat.ts`.

## Checks run

- `pnpm typecheck`: **pass**
- `pnpm lint`: **pass** (0 warnings)
- `pnpm test`: **pass** — 87 files / 1170 tests (same totals: files moved, none added or
  dropped). The `agent-host` project now runs 5 files / 42 tests (was 3 files).
- `pnpm build`: **pass**
- `pnpm format:check`: only `docs/agent-host-separation-plan.md` is flagged (pre-existing,
  not touched in this phase); every file changed here is Prettier-clean.
- Live tests (`test:chat:ollama`): not run (need a real Ollama). Only import lines changed in
  `chat-engine.live.test.ts`; it typechecks and its file name (the script filter) is unchanged.

## Behaviour

- Intentional behaviour changes: **none**. Verified by the unchanged unit + integration
  suites now running in the host, and by `ipc.test.ts` in desktop:
  - one active stream (`busy` rejection), stop by `streamId`, `stopForSink` on window close;
  - Zod: `ChatStartRequestSchema` / `ChatStopRequestSchema` on input, `ChatEventSchema` on
    every emitted event, `ChatStartResultSchema` in the IPC handler;
  - `ModelProviderError` → `ChatErrorCode` mapping via `toChatError`;
  - `onUsage` once per completed reply (plus per tool round), never after cancel, errors
    in the recorder swallowed and logged;
  - engine captured once per request via `selectEngine`, legacy runtime by default.
- Follow-ups / known gaps for later phases:
  - Phase 3: dashboard / research-tools cores move; consider typing their OS deps as
    `Pick<HostPorts, …>`.
  - Phase 4: `createAgentHost` should construct `ChatController` (with
    `createAppChatEngines` + `createChatWebSearch`) so `index.ts` only passes `onUsage`
    (`chatUsageRecorder`, still in desktop `app-storage.ts`) and receives the controller.
  - Desktop tests that build a `ChatController` over full wiring (`chat-engine.*`,
    `chat-web-search.integration`, `remote-ollama`) stay in desktop because they use
    `RuntimeConfig` / `chatUsageRecorder`; they can migrate once `createAgentHost` exists.

## Risks / decisions

- **Full removal instead of a thin adapter.** The plan allowed either; the sink adapter
  already lives at the IPC boundary, so a desktop `chat.ts` would only have been a
  re-export.
- **File renamed to `chat-controller.ts`** in the host (not `chat.ts`) to sit clearly next to
  `chat-engine.ts`. Test files follow the same name.
- **`chat.integration.test.ts` moved too**, although the plan only asked for unit tests: it
  exercises only the controller over host dependencies and needs nothing from desktop.
- **Git staging:** the moves were made with `git mv`, but at the time of writing the index
  shows them as deletions + untracked files (the index was reset outside this task).
  Staging both sides together (`git add -A`) lets Git record them as renames again.
