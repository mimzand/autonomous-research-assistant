# Agent Process Separation — Phase 5 Report

## Summary

- Status: **complete**. In service mode, research tasks can be started, paused, resumed, cancelled and retried, and their progress observed, through the agent.
- With `AGENT_TRANSPORT=service`, the agent serves `tasks.startResearch`, `tasks.pause`, `tasks.resume`, `tasks.cancel` and `tasks.retry`. It broadcasts every research progress event to all connected shells as `ui.researchProgress`.
- Electron main proxies the five task channels. It fans `ui.researchProgress` out to every window on `IpcEvents.researchProgress`, through the same `BrowserWindow` loop the in-process app uses.
- Task rules are unchanged because the handlers call the same host Dashboard service as in-process IPC. That covers goal and model checks, engine pinning, the step machine, which actions a status allows, and interrupted-task recovery.
- The default `inprocess` mode is unchanged. Its only code change is that `broadcast` in `host-ports.ts` is now exported.

## Changes

**Agent (`apps/agent`)**

- `server.ts`
  - Tracks authenticated connections. A connection is added after its `system.hello` reply and removed when it closes.
  - New `AgentServer.broadcast(method, payload)` pushes an event to each of them through `AgentConnection.emit`. Each connection validates the event with `parseEvent`; an invalid event is logged and dropped. Unauthenticated sockets never receive events.
- `run.ts`: new `AgentServiceSet.attachEvents?(broadcast)`. `runAgent` calls it once the server is listening.
- `handlers.ts`: `researchHandlers(dashboard)` maps the five task methods to `dashboard.startResearch | pauseTask | resumeTask | cancelTask | retryTask`. These are the functions in-process IPC calls.
- `services.ts`
  - The host's `emitResearchProgress` port now sends `ui.researchProgress` through the attached broadcast. Before a server is attached, events are dropped; no client exists then.
  - The research handlers are served.
  - New option `webServices`, an injection seam so tests can use a scripted web.
  - New `whenTasksIdle()` for tests and shutdown.
  - Dialog ports still reject: backup and Research Tools are Phase 6.

**Electron (`apps/desktop/src/main`)**

- `service-ipc.ts`: `SERVICE_ROUTES` gains the five task channels (17 routes). Payloads are validated with `parseRequest` before they reach the agent, as for the other routes.
- `service-shell.ts`
  - New `broadcast` dependency.
  - Subscribes with `client.onEvent` and forwards only `ui.researchProgress` to `broadcast(IpcEvents.researchProgress, payload)`. The payload was already validated by `@rka/agent-client`, and the preload validates it again.
  - Log lines updated.
- `host-ports.ts`: `broadcast` is exported. `index.ts` passes it to the service shell, so both modes use the same window fan-out.

**Docs:** the README agent and transport bullets, and `agent-process-security.md` (Phase 5 status and broadcast validation in §7).

## Boundaries

- No `electron` in the agent. Ollama is the only model provider.
- The renderer still talks only to `window.api`; `RendererApi`, `IpcChannels` and the preload are unchanged.
- No dual SQLite open: Electron opens nothing in service mode, and the agent's runtime writes task, step, source and report state.
- Not done (deferred):
  - `storage.backup` still answers `not_implemented` (it needs `shell.chooseBackupPath`, Phase 6).
  - Research Tools, reverse dialogs, secrets and Settings are not implemented (Phases 6–7).
- Default `AGENT_TRANSPORT` is still `inprocess`.

## Checks run

| Check            | Result                       |
| ---------------- | ---------------------------- |
| `pnpm typecheck` | pass                         |
| `pnpm lint`      | pass (0 warnings)            |
| `pnpm test`      | pass: 103 files, 1,373 tests |
| `pnpm build`     | pass                         |

New and updated tests:

- `apps/agent/src/research.test.ts` (new, 5 tests). It runs the real agent services, TCP server and `AgentClient`, and the real research workflow and Ollama provider, against a fake Ollama that answers each research prompt by its `Task:` line. The web is scripted: no SearXNG, no network.
  - **Full run:** start, then progress broadcast to two shells (identical events) through `step-started` and `step-completed` events to `completed` (11/11 steps), with one report.
  - **Pause mid-step:** the `compare-findings` request is held, the task is paused, and the status becomes `interrupted`. A second pause and a retry are `rejected`. Resume continues to `completed` with a report.
  - **Cancel mid-step** (during `extract-evidence`) gives `cancelled`.
  - A start the runtime refuses (no `SEARXNG_URL`) gives `rejected` with "Web search…". Invalid params give `bad_request`. No events are sent in either case.
  - Progress emitted before a server is attached is dropped safely.
- `server.test.ts` (+1): broadcast reaches the authenticated client, an invalid broadcast event is dropped, and an unauthenticated socket receives only its handshake-timeout error.
- `run.test.ts` (+1): `attachEvents` receives the server's `broadcast`.
- `services.test.ts`: the served method list includes the five task methods; `tasks.startResearch` is no longer `not_implemented`.
- `service-shell.test.ts` (+2, updated):
  - the five channels are proxied with validated params, and invalid ones never reach the agent;
  - `ui.researchProgress` is broadcast on `IpcEvents.researchProgress` while other events are ignored;
  - 17 routes, and research no longer appears in the unavailable list.

Manual end to end used `node apps/desktop/scripts/fake-services.mjs`, the agent started with `OLLAMA_HOST=127.0.0.1:11435`, `OLLAMA_MODEL=fake-model:1b`, `SEARXNG_URL=http://127.0.0.1:8089` and `--data-dir %TEMP%\rka-phase5-e2e`, and Electron in service mode with a local DevTools port. The renderer's real `window.api.tasks` was driven from DevTools:

- `startResearch({ goal: 'short' })` was rejected with `Invalid params for tasks.startResearch…`, as in-process rejects with a Zod error.
- A valid start returned `ok`. `onProgress` received `task:running 0/11`, `step-started` and `step-failed:failed`. The fake model cannot write research plans, so the first step fails; this is documented in `fake-services.mjs`.
- `pause` on a failed task was `rejected`. `retry` returned `ok` and produced a new burst of progress events. `cancel` on a failed task was rejected with the runtime's own message.
- `counts()` showed `failed: 1`.

A full successful run with the window observing is covered by the automated test above. That test cannot use `fake-services.mjs`, which has no plan replies.

## Behaviour

| Behaviour                       | In-process                                                          | Service mode                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Start                           | `dashboard.startResearch` (goal, model and search readiness checks) | Same function in the agent; the result is passed through                                                        |
| Progress                        | `forwardResearchProgress` → `BrowserWindow` loop                    | Same filter in the host → `ui.researchProgress` broadcast → same `BrowserWindow` loop                           |
| Pause / resume / cancel / retry | runtime rules per status                                            | Same; rejections pass through unchanged                                                                         |
| Engine pinning                  | pinned at creation from `engine.research`                           | Pinned at creation from the agent's `RESEARCH_ENGINE` env                                                       |
| Interrupted recovery            | marked on open; resume never automatic                              | Same, when the agent opens the database (Phase 3)                                                               |
| Quit while a task runs          | `will-quit` closes SQLite; next start marks it interrupted          | Agent stop closes SQLite; next agent start marks it interrupted. Closing Electron does **not** stop agent tasks |

## Risks / decisions (intentional gaps)

- **Settings are env-only in the agent.** Research limits come from `loadResearchConfig(env)` (the `RESEARCH_*` variables), the research engine from `RESEARCH_ENGINE`, and SearXNG from `SEARXNG_URL`. Saved Settings and live reconfiguration arrive in Phase 7. The agent does not read `.env`.
- **Tasks outlive the window.** In-process, quitting the app ends a running task, and recovery marks it interrupted on next start. In service mode the agent keeps running the task after Electron quits, and the task completes in the agent's database. This is the intended effect of separation, but it is a visible difference; supervision and lifecycle are Phase 8.
- **Progress goes to every shell,** including a CLI client, just as in-process sends it to every window. Payloads are the existing `ResearchProgressEvent` DTO: status, step counts and a short message, with no secrets or local paths.
- **No replay:** a shell that connects mid-task sees only later events. The Dashboard already polls `tasks.get` and `tasks.logs`, so pages recover their state as they do in-process after a window reload.
- **Agent lost:** there is no reconnect (as in Phases 3–4). Task actions fail with `connection_closed`; the task itself continues or is recovered by the agent.
- **Timeouts:** task actions use the 60 s proxy timeout. `tasks.startResearch` awaits only the readiness check and task creation, not the run.
- `pnpm format:check` still reports only the user's `docs/agent-process-separation-plan.md`, which is intentionally not edited.
