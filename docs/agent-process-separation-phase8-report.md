# Agent Process Separation — Phase 8 Report

## Summary

- Status: **complete**
- Electron now supervises the agent service: it starts the bundled agent as an Electron
  **utility process**, waits for its state file and handshake, and only then serves the
  renderer. On quit it stops the agent with `system.shutdown` (and kills it if it does
  not exit). The production default is `AGENT_TRANSPORT=service`, and a packaged app
  always uses it. The in-process host is no longer in the production bootstrap: it is a
  development-only module that production builds compile out. Packaging works, and the
  packaged smoke test passes **66/66** on the built Linux app. The agent opens SQLite
  through the same `better-sqlite3` binary, and Chat, ADK, research, forced-kill
  recovery and clean quit all go through the supervised agent. The Windows zip,
  cross-built here, passes the static checks (19/19) and the fuse check (RunAsNode still
  off). Standalone `pnpm agent:dev` / `agent:ping` are unchanged. The spawn allow-list
  has exactly one entry, pinned by `security-guards.test.ts`.

## Runtime decision: (a) Electron `utilityProcess`

The agent runs as `utilityProcess.fork('<app>/out/agent/main.js', fixedArgs)`.

| Question                         | Answer and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does it need `RunAsNode`?        | No. A utility process is a Chromium child process of the app executable (`--type=utility --utility-sub-type=node.mojom.NodeService`) with Node integration. It is not `ELECTRON_RUN_AS_NODE`. The fuse stays **disabled** (`verify-windows-build.mjs` on the Windows cross-build: `fuse RunAsNode — disabled`), and the smoke test's hostile start (`ELECTRON_RUN_AS_NODE=1`, `--inspect=0`) still has no effect.                                                                                                                                                                                                                                         |
| Does `better-sqlite3` load?      | Yes. The prebuilt binary is **Node-API**, so one file works in Electron's main process (as before), in the utility process and in plain Node (`pnpm agent:dev`; also `node out/agent/main.js` was tried). The agent bundle keeps `better-sqlite3` external. It resolves from `app.asar/node_modules`, and Electron's asar support redirects the `.node` file to `app.asar.unpacked`. Packaging is unchanged: `npmRebuild: false`, the same `asarUnpack`. Smoke: `agent opened SQLite in the user-data folder` (the agent's `[agent] Database: <userData>/data/research.db` log line), plus integrity check, reopen and WAL files in the user-data folder. |
| Does it load code from the asar? | Yes. The entry is inside `app.asar` (`OnlyLoadAppFromAsar` and asar integrity stay on). The smoke test checks `asar contains out/agent/main.js` and that ADK chat runs from the agent's lazy chunk.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Does it outlive the app?         | No. Smoke: `a forced kill of the app also ends its agent (no orphan)` (SIGKILL of the main process; the utility process is gone within the wait). If an agent ever does survive, the next start asks it to stop (see Startup).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Why not (b)?                     | (b) means shipping a Node binary, which is about 90 MB more, another runtime to patch, and a second ABI to keep in step. (a) needs neither and is not blocked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Changes

### Added

- `apps/desktop/src/main/agent-supervisor.ts`: the single spawn allow-list entry.
  - `agentEntryPath(appPath)` is `<app>/out/agent/main.js`.
  - `agentLaunchArgs` is `--data-dir <userData> --state-file <userData>/agent-state.json --port 0`.
  - `agentEnvironment` passes the app's environment minus `NODE_OPTIONS` and `ELECTRON_*`.
  - `createAgentSupervisor().start()` / `.stop()`. It does not import `electron`; the
    `utilityProcess.fork` adapter is injected.
  - Tests: `agent-supervisor.test.ts` (12).
- `apps/desktop/scripts/build-agent.mjs`: Vite SSR build of `apps/agent/src/main.ts` into
  `out/agent/main.js` (ES module; everything bundled except `better-sqlite3` and Node
  builtins; ADK and pdf.js as lazy chunks).
- `apps/desktop/src/main/dev-inprocess.ts`: the previous in-process wiring (moved from
  `index.ts` without changes) plus the ADK probe. It is imported only behind
  `import.meta.env.DEV`.
- `apps/desktop/src/main/vite-env.d.ts`: types for `import.meta.env.DEV`.

### Changed

- `apps/agent`: `system.shutdown` is served, to `shell` clients only, and only when the
  runner passes `onShutdown`. `cli`/`test` clients get `bad_request`, and an agent
  without it answers `not_implemented` as before. The agent replies, stops (closes the
  server and services, removes its state file), then `main.ts` exits. Tests:
  `run.test.ts` (+3). The agent also logs the `OLLAMA_NGROK_BYPASS_HOSTS` notices that
  the in-process app used to print.
- `agent-transport.ts`: modes are `service` (default; supervised), `external` (dev:
  attach to `pnpm agent:dev`, the old Phase 2–7 `service` behaviour) and `inprocess`
  (dev and tests). `resolveAgentTransport` makes a packaged app always use `service`
  and warns about a dev-only value. `connectServiceAgent` takes a `hint`.
- `index.ts`: there is no `createAgentHost`, `openAppStorage`, runtime config or ADK
  probe. `bootstrap` resolves the transport, then either starts and supervises the
  agent (`service`) or connects to one (`external`). It then registers the service IPC
  (`startServiceShell`) and runs the startup check through the agent (`model.health`,
  `researchTools.status`). The will-quit order is: close the shell connection, then
  `supervisor.stop()`, then quit.
- `service-shell.ts`: takes an already authenticated connection (`agent`) instead of
  connecting itself.
- `app-storage.ts`: `openAppStorage` refuses unless `AGENT_TRANSPORT=inprocess`, so it
  also refuses by default. Its tests and `process-crash.test.ts` now pass `inprocess`
  explicitly.
- `service-ipc.ts`: the message for a channel without a route no longer suggests
  unsetting `AGENT_TRANSPORT`.
- `apps/desktop/package.json`:
  - `build` = `electron-vite build && node scripts/build-agent.mjs`.
  - `dev` and `preview` build the agent first.
  - `package:*` run `pnpm run build`.
  - New `build:agent`.
- `scripts/smoke-packaged.mjs`: 10 new checks (static layout, agent process, argv,
  forced kill, clean quit), for 66 in total.
- `security-guards.test.ts`: the process ban stays global. Only `agent-supervisor.ts`
  may `fork` and only `index.ts` may use `utilityProcess` (one adapter line). The test
  pins the entry, the arguments and the single call, and checks that the supervisor
  imports no `electron` and passes no token. Its only `rmSync` is its own state file.
- Docs: `security.md`, `release.md`, `user-guide.md`, `agent-process-security.md`
  (spawn allow-list section, token row, single-writer rows), `settings.md` and `README.md`.

### Protocol / public API

- No schema change; `PROTOCOL_VERSION` stays **2**. `system.shutdown` was already in the
  registry (phase 8) and is now served.

## Startup and shutdown

1. **Startup (`service`).** If `<userData>/agent-state.json` exists, the supervisor
   tries a 2 s `shell` connection with its token. An agent that answers (left running by
   a crashed app) is asked to `system.shutdown`. An unreachable or invalid file is
   removed. The supervisor then forks the agent, waits up to 30 s for a state file
   written by **this child's pid**, and runs handshake + `system.ping`. Only then does it
   register IPC and open the window. If the child exits first, startup fails with its
   last stderr lines (error dialog, then quit, which also stops the child).
2. **Quit.** On `will-quit` (prevented once), the supervisor closes the shell's
   connection, sends `system.shutdown` on a new control connection, and waits 5 s for
   the exit. If the agent doesn't stop, it calls `kill()` (SIGTERM on POSIX, terminate on
   Windows) and removes the state file if the agent left it. Then the app quits.
3. **Unexpected exit.** This is logged ("Agent service stopped unexpectedly …"), and
   requests fail until the app restarts.

## Default matrix

| Build                                | `AGENT_TRANSPORT` unset                                                                      | `service`  | `external`                   | `inprocess`                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ---------- | ---------------------------- | ---------------------------------------------------- |
| Packaged / `package:dir` / `preview` | supervised agent                                                                             | supervised | ignored, warning, supervised | ignored, warning, supervised (code not in the build) |
| `pnpm dev`                           | supervised agent (`out/agent` built)                                                         | supervised | attach to `pnpm agent:dev`   | in-process host in Electron main (old path)          |
| Tests                                | n/a: tests use `@rka/agent-host`, `openAppStorage({ env: inprocess })` or the agent directly |            |                              |                                                      |
| `pnpm agent:dev`                     | standalone agent, no Electron (unchanged)                                                    |            |                              |                                                      |

`service` is also the dev default, so the production path is exercised daily. `inprocess`
remains available on request, as the prompt asked.

## Boundaries

- **Who opens SQLite?** Only the agent, in every mode except dev `inprocess`. The
  production main bundle contains no agent host, no `better-sqlite3` reference and no
  ADK (smoke: `Electron main bundle has no in-process agent, SQLite or ADK`;
  `out/main/index.js` is one 294 KB file).
- **Can the renderer reach the agent port?** No. This is unchanged: the CSP is
  `connect-src 'none'` (smoke: renderer `fetch` blocked), and the token and client exist
  only in Electron main.
- **child_process / spawn allow-list:** `child_process`, `spawn`, `exec` and
  `worker_threads` are banned everywhere. `fork` is allowed only in `agent-supervisor.ts`
  (one call, fixed entry and arguments), and `utilityProcess` only in `index.ts` (one
  adapter line). The agent and all packages start nothing.
- **electron imports in agent packages?** None (unchanged ESLint rule). The supervisor
  does not import `electron` either.
- **Loopback only:** the agent still binds `127.0.0.1` on an ephemeral port (smoke:
  state file `127.0.0.1`, protocol 2).
- **Token:** never passed to the child. The agent generates it and writes the owner-only
  state file; the shell reads it. The child's arguments travel over Electron's IPC, not
  the OS command line. Smoke: `agent token and paths are not on the process command
line`.

## Checks run

- `pnpm typecheck`: pass
- `pnpm lint` (`--max-warnings=0`): pass
- `pnpm test`: **108 files, 1,427 tests, all pass**
- `pnpm build`: pass (renderer, main, preload and `out/agent`)
- `pnpm format:check`: flags only `docs/agent-process-separation-plan.md`, which is the
  user's plan and is left unedited on purpose.

### Packaged proof (`pnpm package:dir`, Linux x64, Electron 44.10.1)

`xvfb-run -a pnpm smoke:packaged`, with a temporary user-data folder, a fake Ollama and a
fake SearXNG: **66/66 checks passed**. Excerpt:

```text
PASS  asar contains out/agent/main.js
PASS  Google ADK is bundled with the agent (lazy engine chunk) — out/agent/chunks/engine-….js
PASS  Electron main bundle has no in-process agent, SQLite or ADK
PASS  fuses: ELECTRON_RUN_AS_NODE and --inspect have no effect
PASS  agent service supervised by the app (transport service, handshake + ping) — Agent service: connected to 127.0.0.1:41033 (agent pid 5925, v0.1.0, protocol 2); handshake + ping 12 ms.
PASS  state file: loopback, protocol 2, agent pid is not the app — 127.0.0.1:41033 v2 pid 5925
PASS  agent opened SQLite in the user-data folder
PASS  agent is a utility process of the app (not ELECTRON_RUN_AS_NODE) — --type=utility --utility-sub-type=node.mojom.NodeService; parents 5925 > 5895 …; app 5895
PASS  agent token and paths are not on the process command line — 15 args
PASS  Legacy Chat streams a reply — {"type":"done",…}
PASS  ADK Chat streams a reply (ADK loads from the package) — {"type":"done",…}
PASS  Research task created — {"status":"ok",…}
PASS  a forced kill of the app also ends its agent (no orphan) — pid 5925
PASS  restart after the kill: a new agent replaces the stale state file
PASS  database integrity check after the kill — {"ok":true,…}
PASS  normal quit stops the agent cleanly (system.shutdown, state file removed) — pid 6013
PASS  database reopens after a normal quit; task still cancelled
PASS  SQLite files only in the user-data folder — research.db, research.db-shm, research.db-wal
66/66 checks passed.
```

The baseline before the cutover was 56/56 with the same harness. The existing checks
pass unchanged through the supervised agent, including Settings, environment
overrides, web search through the ToolGateway, Stop, recovery and the Chromium
net-log check.

### Windows package (cross-built on Linux, static only)

- `electron-builder --win zip --x64 -c.win.signAndEditExecutable=false`, then
  `smoke-packaged.mjs release/win-unpacked --target=win32-x64 --static-only`: **19/19**
  pass, including `out/agent/main.js` in the asar, the `win32-x64.node` binary, and no
  agent/SQLite/ADK in main.
- `verify-windows-build.mjs`: every fuse is as expected (RunAsNode, NodeOptions and
  Inspect disabled; asar integrity enabled), and the integrity hash matches. Three
  failures come from the cross-build itself: there is no rcedit metadata and no NSIS
  installer without Windows.
- **Not yet run on Windows.** Run `pnpm package:win`, `pnpm smoke:packaged` and
  `pnpm verify:win-build`, plus the new checklist items in `release.md` (second process
  in Task Manager, End task, loopback port).

### Development modes (electron-vite dev, xvfb)

- Unset: `Agent transport: service.`, then `[agent] Database: <userData>/data/research.db`,
  then `Agent service: connected …`, then `Startup check: …` (asked of the agent). After
  the run is stopped, no utility process is left and the state file is removed.
- `AGENT_TRANSPORT=inprocess`: `Agent transport: inprocess.`, then
  `Startup check: …`, then `ADK runtime: … self-check passed` (old path).
- `AGENT_TRANSPORT=external` with `pnpm agent:dev` running: connects to the dev agent;
  Electron creates no `data` folder.
- `pnpm agent:dev --data-dir <tmp>`, then `pnpm agent:ping --data-dir <tmp>`: `Pong from agent pid … on 127.0.0.1:…`.

## Behaviour

- **Intentional changes:**
  - The production app runs the agent in a second process.
  - The main process no longer runs the ADK self-check at startup; ADK loads in the
    agent when an ADK engine is used.
  - `AGENT_TRANSPORT=service` now means "supervised". Attaching to `pnpm agent:dev` is
    now `external`.
  - A packaged app ignores dev-only transport values (with a warning).
- **Unchanged:** the data folder and database (the agent uses `<userData>/data/research.db`,
  the same file as before), Settings rows and the encrypted token format (Phase 7), the
  renderer and its IPC contract, the CSP and fuses, Ollama only.

## Risks / decisions

- **No automatic restart (deviation from the plan's "bounded restart policy").** A crash
  of the agent is logged and needs an app restart, as a lost connection has since
  Phase 2. Restarting would also mean rebuilding the long-lived shell connection that
  the IPC handlers hold. This is left for a follow-up and listed in
  `agent-process-security.md`.
- **Agent code in `pnpm dev`** is built once at start (`build:agent`), with no watch.
  After changing agent code, restart `pnpm dev`. Main and renderer still hot-reload.
- **Stale or orphan state file.** The supervisor trusts a state file only after a
  successful token handshake, and removes it otherwise. A recycled pid can therefore no
  longer block startup in `service` mode.
- **Windows kill semantics.** `UtilityProcess.kill()` terminates without a signal on
  Windows, which is why the clean path is `system.shutdown`. SQLite's WAL plus recovery
  on open cover the kill path (smoke: integrity check after a forced kill).
- **`/proc` evidence is Linux-only.** On Linux, Chromium rewrites the utility process's
  title, so the argv check splits on spaces and the environment filter is covered by
  unit tests rather than `/proc/<pid>/environ`. On Windows, use the manual checklist.
- **Not in scope:** auto-update, code signing, and an `app://` protocol (these
  accepted risks are unchanged).
