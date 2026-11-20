# Agent Host Separation — Phase 4 Report

## Summary

- Status: **complete**
- `@rka/agent-host` now exports `createAgentHost`. It is the composition root of the agent
  and builds these pieces:
  - the source store, and the tool registry with the web tools;
  - the agent runtime, with Research task models and progress forwarding;
  - the Chat engines, Chat web search and `ChatController`;
  - the Dashboard and Research Tools services.
- `apps/desktop/src/main/index.ts` is now a thin Electron adapter:
  - it opens storage and builds `RuntimeConfig`, the live Ollama provider and the web
    services;
  - it builds one `HostPorts` from Electron (new `host-ports.ts`) and calls `createAgentHost`;
  - it wires Settings, the settings fan-out and IPC, and handles session, menu, window and
    the ADK probe.
- No utility process. No IPC contract, renderer or `@rka/shared` change. No intentional
  behaviour change.

## Changes

- Added — host
  - `packages/agent-host/src/agent-host.ts`
    - `createAgentHost(deps)` returns `{ runtime, chat, dashboard, researchTools, tools }`.
      The wiring was moved from `index.ts` with its comments.
    - `forwardResearchProgress(emit)` turns a runtime `ResearchEvent` into a call to
      `emitResearchProgress`. It forwards only events that pass
      `ResearchProgressEventSchema`.
  - `packages/agent-host/src/agent-host.test.ts` (6 tests). It uses fake ports, in-memory
    storage, a real Ollama provider with a scripted `fetch`, and real web services. The tests
    check that:
    - the web tools are registered;
    - no setting is read while the host is being built;
    - Chat streams through the selected engine, reads the engine and web-search flags once
      per request, and reports usage;
    - Backup and file-pick go through the injected dialog ports;
    - an unseen URL is refused before `openExternal` is called;
    - progress events are forwarded when valid and dropped when invalid.
- Modified — host
  - `packages/agent-host/src/index.ts` exports `createAgentHost`, `forwardResearchProgress`
    and the types `AgentHost`, `AgentHostDeps`, `AgentHostPorts` and `AgentHostSettings`.
- Added — desktop
  - `apps/desktop/src/main/host-ports.ts` exports
    `createElectronHostPorts(config): HostPorts`. It is the Electron implementation of all
    eight ports:
    - window broadcast for research progress and settings changes;
    - the save dialog for backups, with `backupDialogOptions` and the saved folder or
      Documents;
    - the PDF/DOCX open dialog, and the folder dialog;
    - `isSafeExternalUrl` followed by `shell.openExternal`;
    - `safeStorage.isEncryptionAvailable`, and `config.getSecret`.

    The `backupDirectory` helper moved here from `index.ts`, unchanged. The dialog and shell
    code is the same code that was inline in `index.ts`.

- Modified — desktop
  - `src/main/index.ts` (about 130 lines of wiring removed, about 25 added):
    - Builds `ports` once and passes them to `createAgentHost`, together with the settings
      accessors (`toResearchDefaults`, `engine.chat`, `engine.research`, `chat.webSearch`)
      and `onChatUsage: chatUsageRecorder(storage)`.
    - `SettingsService` gets `chooseFolder: ports.chooseFolder`.
    - `config.onChange` still parses with `SettingsChangedEventSchema` and logs, then calls
      `ports.emitSettingsChanged`.
    - `registerIpcHandlers` gets `host.runtime`, `host.chat`, `host.dashboard` and
      `host.researchTools`. `checkStartup` uses `host.runtime`.
    - No longer imports `shell`, `node:fs`, `backupDialogOptions`, `isSafeExternalUrl`, or
      any runtime, tools or engine factory.
  - `src/main/security-guards.test.ts`: in the `openExternal(` allow-list, `index.ts` is
    replaced by `host-ports.ts`. The `packages/agent-host/src/ports.ts` entry is removed,
    because the property syntax adopted in Phase 3 no longer matches the pattern.
- Docs: `README.md` structure lines for `src/main` and `agent-host`.
- No dependency or lockfile changes.

### Public API of `@rka/agent-host` (added this phase)

| Module          | Exports                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `agent-host.ts` | `createAgentHost`, `forwardResearchProgress`, types `AgentHost`, `AgentHostDeps`, `AgentHostPorts`, `AgentHostSettings` |

`AgentHostDeps`:

- `storage`, `modelProvider` (`OllamaProvider`) and `webServices` (`ReconfigurableWebServices`)
  are owned and kept in sync with Settings by the shell.
- `settings` is a set of per-use accessors.
- `ports` is a `Pick<HostPorts, 'emitResearchProgress' | 'chooseBackupPath' | 'chooseFile' | 'openExternal'>`.
- `onChatUsage` is optional.

## Boundaries

- **Electron imports in the host?** None. `agent-host.ts` imports only `@rka/*` packages and
  local modules. `console.info` is used for the Chat tool-call audit line, as before.
- **agent-runtime ↔ adk-runtime?** Still disconnected; neither package changed.
- **Renderer and preload still shared-only?** Yes; untouched.
- **What stays in Electron:**
  - `openAppStorage` and recovery logging;
  - `RuntimeConfig`, the env and `settings.env` paths, and the ngrok transport warnings;
  - the Ollama provider factory and the `ollamaApplier` / `webApplier` registrations;
  - `SettingsService` and `OllamaSettingsService`, including `chooseFolder`;
  - the settings-changed fan-out, `registerIpcHandlers` and `isTrustedSender`;
  - session permissions and spellchecker, the menu, the window, `checkStartup` and
    `probeAdkRuntime`.
- **Security guards:** the `openExternal(` allow-list now has three call sites: Electron
  `host-ports.ts`, `window.ts` and the host's `research-tools.ts`. Before this phase,
  `index.ts` and `ports.ts` were also allowed, so the guard is now stricter. The
  `registry.execute(`, `withToolCalling()` and `streamChatWithTools` allow-lists are
  unchanged.

## Checks run

- `pnpm typecheck`: **pass**
- `pnpm lint`: **pass** (0 warnings)
- `pnpm test`: **pass**, 88 files / 1176 tests (was 87 / 1170; the difference is the new
  `agent-host.test.ts`). The `agent-host` project now runs 7 files / 66 tests.
- `pnpm build`: **pass**
- `pnpm format:check`: only `docs/agent-host-separation-plan.md` is flagged. It was already
  flagged and is left untouched.

## Behaviour

- Intentional behaviour changes: **none**. Each item below has the same code path and wiring:
  - **Research progress fan-out:** events are Zod-validated, then sent to every window that
    is not destroyed. The same `safeParse` and loop are now split between
    `forwardResearchProgress` and `broadcast`.
  - **Settings fan-out:** `SettingsChangedEventSchema.parse`, then the log line, then a
    broadcast to every window.
  - **Recovery logging** and the "Web search is off…" startup hint are unchanged and stay
    in `index.ts`.
  - **Engine flags:** `engine.chat` is read per Chat request. `engine.research` is read when
    a task is created and then pinned. The new test confirms that neither is read while
    the host is being built.
  - **Chat web search:** same gateway wiring, the same `chat.webSearch` and
    search-configured checks, and the same audit log line (never the query).
  - **Research Tools and Dashboard:** same services and ports. File paths still stay in
    the main process behind tokens with a TTL. `openExternal` is checked twice: by the
    service (public, already-seen http(s) URLs) and by Electron (`isSafeExternalUrl`). Backup
    overwrite confirmation is still owned by the Electron save dialog.
  - **IPC:** `registerIpcHandlers` and the Zod validation in each route are unchanged.
- Follow-ups for later phases:
  - **Phase 5:** harden the ESLint DAG.
    - Consider dropping `HostSecretsPort`, or using it. The desktop implements it, but the
      host does not read it, because the provider's `getAuthToken` is wired by the shell.
    - Consider moving `emitSettingsChanged` and `chooseFolder` out of `HostPorts`, since
      only desktop uses them.

## Risks / decisions

- **`AgentHostPorts` is a `Pick` of four ports, not the full `HostPorts`.** The host takes
  only what it uses, so the tests need just four fakes. Desktop passes the full `HostPorts`
  object, which satisfies the `Pick`.
- **Provider and web services are injected, not created by the host.** The shell owns the
  settings appliers (`ollamaApplier`, `webApplier`), Disconnect state and the access token.
  Creating the provider in the host would have moved `RuntimeConfig` concerns, which are out
  of scope.
- **Settings are passed as accessors, not as `RuntimeConfig`.** This keeps `RuntimeConfig`
  in desktop and keeps "read on use" visible in the type.
- **Desktop tests that build the graph by hand were not converted.**
  - `ipc.test.ts` injects a fake `ModelProvider` and a fixed Chat stream id (`newId`).
    `createAgentHost` deliberately accepts neither.
  - `chat-web-search.integration.test.ts` and `chat-engine.integration.test.ts` need a
    fake fetcher, or the case where no web search is set up at all.
  - The research integration and lifecycle tests build runtimes with custom task models.

  Converting any of these would mean a large rewrite or widening the host API only for
  tests. The composition itself is covered by `agent-host.test.ts`, and the build and
  typecheck cover how `index.ts` uses it.

- **The "Web search is off" log stays in desktop.** It is a startup hint about Settings,
  not agent behaviour.
