# Agent Process Separation — Phase 3 Report

## Summary

- Status: **complete** (Dashboard parity for the Phase 3 method set)
- With `AGENT_TRANSPORT=service`, the standalone agent owns SQLite. It opens
  `<data-dir>/data/research.db` (the userData layout), applies migrations, recovers
  interrupted tasks and builds `createAgentHost` on it. It serves the 11 methods the
  registry assigns to Phase 3: `tasks.counts|list|get|logs|runPersistenceCheck`,
  `sources.list|get`, `reports.list|get` and `storage.status|integrityCheck`.
- Electron main in service mode opens no database and builds no local host. It proxies
  those Dashboard channels over one long-lived `AgentClient`. Every other renderer
  channel answers `"<channel> is not available with AGENT_TRANSPORT=service yet. Unset
AGENT_TRANSPORT to use it."`
- The default `inprocess` mode is unchanged: local `createAgentHost` plus SQLite.

## Changes

**Added**

- `apps/agent/src/handlers.ts`: `RequestHandlers` type and `dashboardHandlers(dashboard)`,
  which maps the 11 Phase 3 methods to the host's `DashboardService`. That service
  validates payloads and results again with the `@rka/shared` schemas.
- `apps/agent/src/services.ts`: `openAgentServices({ dataDir, env, log })`. It opens
  the database, runs recovery (logging `Marked N task(s) as interrupted after an
unexpected shutdown.` as Electron does), builds an env-configured Ollama provider and
  web services, creates the host and returns `{ handlers, databasePath, recovery,
close }`. Shell ports (dialogs, `openExternal`) reject with "needs the desktop
  shell (reverse RPC, Phase 6)"; no Phase 3 method uses them.
- `apps/desktop/src/main/service-ipc.ts`: `SERVICE_ROUTES` (IPC channel → protocol
  method) and `registerServiceIpcHandlers`. It registers every `IpcChannels` entry with
  the same sender guard as in-process mode. The renderer payload is validated with
  `parseRequest`, then sent with a 60 s per-request timeout. The agent's result is
  validated by the client. `app:get-info` is answered locally; every other channel
  rejects clearly.
- `apps/desktop/src/main/service-shell.ts`: `startServiceShell`. It connects
  (handshake + ping, as in Phase 2), keeps the client, logs a disconnect, closes on
  `will-quit` and registers the service IPC handlers.
- Tests: `apps/agent/src/services.test.ts` (8, temp data dir, real TCP) and
  `apps/desktop/src/main/service-shell.test.ts` (8).

**Modified**

- `apps/agent/src/server.ts`: optional `handlers`. Requests after the handshake are
  validated with `parseRequest`, run asynchronously and checked with `parseResult`
  before sending. A thrown error is logged in the agent and answered as
  `internal` / `"<method> failed in the agent."`, without details. Unhandled methods
  still answer `not_implemented`.
- `apps/agent/src/run.ts`: `openServices` runs only after the live-agent check (a
  refused start never opens the database). Services are closed on stop and on any
  startup failure.
- `apps/agent/src/main.ts`, `cli.ts`: open the services for `--data-dir`, log the
  database path, and update the help text.
- `apps/agent/package.json`: depends on `@rka/agent-host`, `@rka/agent-runtime`,
  `@rka/model-provider`, `@rka/storage`, `@rka/tools` (workspace packages; no new
  external dependency).
- `packages/storage`: `appDatabasePath(dataDir)` (`<dataDir>/data/research.db`) so
  Electron and the agent cannot drift apart. `apps/desktop/src/main/app-storage.ts`
  uses it.
- `apps/desktop/src/main/app-storage.ts`: `openAppStorage` throws when
  `AGENT_TRANSPORT=service` (the code assertion).
- `apps/desktop/src/main/index.ts`: `bootstrap` branches. Service mode calls
  `startServiceShell`; in-process mode calls `startInProcessAgent`, which holds the
  previous code unchanged and returns the startup check to run after the window opens.
  Session hardening, window creation and the ADK probe are shared, in the same order.
- `apps/desktop/src/main/ipc.ts`: the sender guard is extracted as `createIpcGuard`
  (same logic), so both modes use it.
- `packages/agent-client`: `request(method, params, { timeoutMs })` per-call override.
  The startup ping keeps 5 s; Dashboard calls get 60 s. +1 test.
- Tests extended: `server.test.ts` (+1: served, failing and invalid-result handlers),
  `run.test.ts` (+2: services served and closed; not opened when another agent is
  live), `app-storage.test.ts` (+2: guard).
- Docs: `README.md` (structure, boundaries, variable table, how to point the agent at
  the app's own data folder), `docs/agent-process-security.md` (status, §3 single
  writer).

**Protocol / public API:** no schema changes. `RendererApi`, `IpcChannels` and preload
are unchanged.

## Boundaries

- **Who opens SQLite?** In service mode: the agent only. Electron's `openAppStorage`
  throws, and the service path never reaches `openStorage`. Tests run it with
  `@rka/storage` mocked to throw. In-process mode: Electron main, as before.
- **Can renderer reach the agent port?** No. The renderer still calls the same
  `window.api` channels; Electron main forwards them. No preload or CSP change.
- **child_process / spawn allow-list status:** unchanged, no exceptions. The agent is
  still started by hand (`pnpm agent:dev`).
- **electron imports in agent packages?** None (ESLint). The agent imports
  `@rka/agent-host` and its dependencies, all Electron-free.

## Checks run

| Check               | Result                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | pass                                                                                  |
| `pnpm lint`         | pass                                                                                  |
| `pnpm test`         | pass: 100 files, 1345 tests (22 new: agent 11, desktop 10, client 1)                  |
| `pnpm build`        | pass                                                                                  |
| `pnpm format:check` | fails only on `docs/agent-process-separation-plan.md` (pre-existing, not edited here) |

**Manual verification (Windows, PowerShell)**

1. `pnpm agent:dev` →
   `[agent] Database: …\apps\agent\.agent-data\data\research.db`, then
   `Listening on 127.0.0.1:56984`. better-sqlite3 loads under plain Node.
2. `$env:AGENT_TRANSPORT='service'; pnpm dev` → `Agent service: connected to
127.0.0.1:56984 (…); handshake + ping 20 ms.` and `Agent service: the agent owns the
database and serves the Dashboard. …`. Startup channels the Chat page calls
   (`model:get-health`, `settings:get`, `research:status`) were rejected with the
   intended message.
3. Electron's own database (`%APPDATA%\Autonomous Research Assistant\data`) was not
   touched during the service-mode run. Its `research.db-shm` kept its earlier
   timestamp, and changed only when the app was next started in-process.
4. Against the same running agent, a CLI client (same `@rka/agent-client`):
   `tasks.counts` 0 → `tasks.runPersistenceCheck` ok → `tasks.list` 1 ("Persistence
   check · …"), `storage.status.path` = the agent database, `storage.integrityCheck`
   ok, `tasks.startResearch` → `not_implemented`.
5. In-process (variable unset) → normal start: `Startup check: Ollama … ready`.

Not verified by me: clicking through the Dashboard in the window. It opened on a
monitor I could not capture. The renderer-to-agent path is covered by
`service-shell.test.ts` (IPC → proxy) and `services.test.ts` (protocol → database),
and step 4 exercised the live agent.

## Behaviour

- **Intentional changes?** Service mode only. The Dashboard reads come from the agent's
  database; the persistence check writes there. Chat, Settings / Ollama management,
  model health, Research Tools, research start/pause/resume/cancel/retry and backup
  reject with a clear message. In-process mode: none.
- **Flag defaults?** `AGENT_TRANSPORT=inprocess`.

## Risks / decisions

- **Service mode is a partial app until Phases 4–7.** Every feature that needs the
  local host (Chat, Settings, Research Tools, research actions) depends on SQLite
  today (settings, usage, tasks), so Electron cannot serve it without a second writer
  or a second settings authority. It rejects instead. The Chat page (the start page)
  shows these errors; the Dashboard works. Acceptable for a development-only flag.
- **Research actions deferred.** `tasks.startResearch|pause|resume|cancel|retry` are
  Phase 5 in the registry. Serving `startResearch` now would run research without
  progress events (`ui.researchProgress`, Phase 5), which is not identical behaviour.
  `storage.backup` needs the reverse `shell.chooseBackupPath` (Phase 6).
- **Agent settings come from the environment only** (Phase 7 gap). The agent ignores
  values saved in the Settings page and has no Ollama access token (secrets are
  encrypted with Electron `safeStorage`). The agent also does not read `.env`, so
  set variables in its shell. No Phase 3 method calls Ollama or the web.
- **Separate dev database by default.** `pnpm agent:dev` uses
  `apps/agent/.agent-data/data/research.db`, so service mode starts with an empty
  Dashboard rather than risking the app's data. The README shows how to point the
  agent at the app's folder (`--data-dir` + `AGENT_STATE_FILE`). Running the
  in-process app on the same folder at the same time is unsupported: whichever opens
  second marks the other's running tasks interrupted. Supervision (Phase 8) brings a
  real lock.
- **No reconnect.** One connection for the app's lifetime. A lost connection is logged
  and later Dashboard calls fail with "The connection is closed." until restart.
- **Agent errors are generic over the wire** ("`tasks.get` failed in the agent.") per the
  protocol rule not to echo details. The full message is in the agent's console.
- **Untrusted senders are still rejected** before any proxying; the agent never sees a
  call the in-process app would have refused.
- **Electron logs each rejected channel** with a stack ("Error occurred in handler for
  …"). That is Electron's standard handler logging, and noisy only in service mode.
