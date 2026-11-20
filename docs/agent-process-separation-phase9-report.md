# Agent Process Separation — Phase 9 Report

## Summary

- Status: **complete** (acceptance)
- Agent process separation is done and accepted. In production, the agent service is
  a separate process: an Electron `utilityProcess` running the bundled `apps/agent`. It
  owns SQLite, Settings and the agent graph. Electron main is the shell: window, IPC
  proxy, supervisor, dialogs and `safeStorage`. It opens no database and contains no
  agent host. The same service runs without Electron through `pnpm agent:dev`. Every
  checklist item below is evidenced. The audit found only stale wording in live docs
  (fixed) and one evidence gap (a smoke check for the agent's own port, added). No
  production code changed. `pnpm check` passes end to end (exit 0). The packaged smoke
  passes **67/67**.

## Acceptance checklist

| #   | Item                                                               | Verdict  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Electron production does not open SQLite                           | **Pass** | <ul><li>The built `apps/desktop/out/main/index.js` (one file, ~294 KB) imports only `electron` and `node:{crypto,fs,net,path,url,util}`. I checked with a grep of its `from "…"` specifiers after `pnpm build`: there are 0 matches for `createAgentHost`, `better-sqlite3`, `openStorage`, `recoverInterruptedTasks`, `ADK_VERSION` or `dev-inprocess`.</li><li>`openAppStorage` refuses unless `AGENT_TRANSPORT=inprocess` (`app-storage.ts`; `app-storage.test.ts`: refuses with `{}`, `service` and `external`).</li><li>A packaged app forces `service` (`resolveAgentTransport`; `agent-transport.test.ts`).</li><li>Smoke: `PASS Electron main bundle has no in-process agent, SQLite or ADK`.</li></ul>                                                                                                                                                                                     |
| 2   | Agent is the sole DB writer in service/packaged mode               | **Pass** | <ul><li>`apps/agent/src/services.ts` is the only production `openStorage` call site.</li><li>Smoke: `PASS agent opened SQLite in the user-data folder` (the agent's own `[agent] Database: <userData>/data/research.db` line) and `PASS SQLite files only in the user-data folder — research.db, research.db-shm, research.db-wal`.</li><li>Agents lock each other out through the state file: `run.test.ts` "refuses to start while the state file belongs to a live process". The supervisor stops an agent an earlier run left behind before starting its own (`agent-supervisor.test.ts`).</li><li>Electron's single-instance lock (`index.ts`).</li></ul>                                                                                                                                                                                                                                      |
| 3   | Renderer cannot connect to the agent port                          | **Pass** | <ul><li>CSP: production `connect-src 'none'` (`electron.vite.config.ts` `PRODUCTION_CSP`). Dev `connect-src 'self'` covers only the dev-server origin, never the agent's port (`renderer-isolation.test.ts`).</li><li>Smoke (new in this phase): `PASS renderer cannot connect to the agent port (CSP violation, nothing sent) — http://127.0.0.1:38459/`, plus `PASS CSP blocks network access from the renderer`.</li><li>No API: `window.api` is frozen and exposes no port, token or generic invoke (smoke `PASS context isolation … frozen window.api`; `security-guards.test.ts` preload checks). The agent client and token live only in Electron main.</li><li>ESLint (`eslint.config.js`): renderer and preload may not import `@rka/agent-client`, `@rka/agent-protocol`, `@rka/agent-host`, `@rka/storage` or other runtime packages, Node built-ins or `electron` (renderer).</li></ul> |
| 4   | Protocol authenticated on loopback                                 | **Pass** | <ul><li>`AGENT_LOOPBACK_HOST = '127.0.0.1'` and `PROTOCOL_VERSION = 2` (`packages/agent-protocol/src/handshake.ts`); the state file schema accepts only that host.</li><li>`server.test.ts`: binds loopback on an ephemeral port; refuses a weak token; completes the handshake; rejects a wrong token, and a token of another length without leaking it; rejects requests before the handshake; reports an unsupported protocol version; caps frames and drops HTTP.</li><li>Smoke: `PASS agent service supervised by the app … connected to 127.0.0.1:… (agent pid …, v0.1.0, protocol 2)`, `PASS state file: loopback, protocol 2`, `PASS agent token and paths are not on the process command line`.</li></ul>                                                                                                                                                                                  |
| 5   | Reverse ports work for dialogs and secrets                         | **Pass** | <ul><li>`apps/agent/src/shell-ports.test.ts`: asks the requesting shell; a cancelled dialog is null; times out; fails on disconnect; secrets only from a `shell` connection.</li><li>`research-tools.test.ts`: file pick through the shell dialog, backup to the dialog's path, never on another client.</li><li>`service-shell.test.ts`: "answers the agent dialog, link and secret requests with the Electron ports".</li><li>`settings.test.ts` (end to end): a stored ciphertext is decrypted through `shell.getSecret`, and `Authorization: Bearer` arrives on the next chat.</li><li>`secrets.test.ts`.</li></ul>                                                                                                                                                                                                                                                                             |
| 6   | `createAgentHost` not used from the Electron production bootstrap  | **Pass** | <ul><li>`index.ts` imports no `@rka/agent-host` value. The only path to `dev-inprocess.ts` (`createAgentHost`, `openAppStorage`, ADK probe) is `startInProcessForDevelopment()`, which throws unless `import.meta.env.DEV`; a production build removes that code (bundle grep in #1).</li><li>`security-guards.test.ts` pins the single `utilityProcess.fork` adapter.</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | `security.md` describes the spawn allow-list and the process model | **Pass** | <ul><li>`docs/security.md`, "Process model (Phase 8)" (utility process from the fixed `out/agent/main.js`, loopback, token, stopped on quit). Its Agent table row "No shell execution" names the supervisor as the one process start.</li><li>`docs/agent-process-security.md` §5 "Spawn allow-list (Phase 8)": runtime, single module, fixed entry and arguments, environment filter, startup and quit, no restart (deferred).</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | Standalone `agent:dev` documented                                  | **Pass** | <ul><li>`README.md`, "Agent service switches": `pnpm agent:dev` plus `AGENT_TRANSPORT=external`, and the `apps/agent` bullet (plain Node or utility process).</li><li>`agent-process-security.md` §5 (development row).</li><li>Run in Phase 8: `pnpm agent:dev --data-dir <tmp>`, then `pnpm agent:ping --data-dir <tmp>` gives `Pong from agent pid … on 127.0.0.1:…`.</li></ul>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | Process separation **is** done (unlike the host-only plan)         | **Pass** | <ul><li>Separate OS process: smoke `PASS agent is a utility process of the app (not ELECTRON_RUN_AS_NODE) — --type=utility --utility-sub-type=node.mojom.NodeService; parents <agent> > <app> …`.</li><li>Lifecycle: `PASS a forced kill of the app also ends its agent (no orphan)`, `PASS normal quit stops the agent cleanly (system.shutdown, state file removed)`.</li><li>The host-only plan (`agent-host-separation-plan.md`) kept the host in Electron main; that is now only the dev `inprocess` mode.</li></ul>                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | `pnpm check` passes                                                | **Pass** | `pnpm check` (typecheck, lint `--max-warnings=0`, `format:check`, test, build) exits 0: "All matched files use Prettier code style!", **108 test files, 1,427 tests passed**, and renderer, main, preload and agent bundles built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Changes

### Audit fixes (clear leftovers only)

- `README.md`: removed stale claims that contradicted the checklist:
  - "loopback protocol server (handshake + ping so far)"
  - "`createAgentHost` composition (in-process)"
  - "`@rka/agent-host` … runs in the Electron main process (no separate process)"
  - "`src/main` is a thin Electron adapter: storage, settings, the live Ollama provider…"
  - "settings come from the environment only for now"
  - "Only the (Electron) main process uses the provider / talks to Ollama / reads the file"

  The structure tree, the package diagram and those bullets now describe the agent
  service and the shell.

- `docs/settings.md`: the ngrok list is "an app-level trust list read at startup" (it
  was "a main-process trust list"; the agent reads it now).
- `docs/security.md`: the redaction row notes that the agent's output reaches the
  console only through Electron main's redacted console. Verified: the supervisor logs
  through `console` (`agent-supervisor.ts`, `deps.log ?? console`), which
  `installConsoleRedaction` patches.

### Evidence added

- `apps/desktop/scripts/smoke-packaged.mjs`: one check, "renderer cannot connect to the
  agent port". The renderer fetches `http://127.0.0.1:<agent port>/` and the check
  expects a `securitypolicyviolation` naming that URL. A plain failed fetch would not
  prove anything, because the agent drops HTTP. `docs/release.md` now shows 67 checks.

### Status

- `docs/agent-process-separation-plan.md`: Status is **Phase 9 complete**, with a link
  to this report. The locked-decisions table gains an "Outcome (Phase 8)" row:
  `utilityProcess` is the packaged runtime of model B, the service stays standalone,
  and the "later packaging option" the table anticipated applies. The file is now
  Prettier-formatted, so `format:check` is clean for the first time since Phase 0.

No production source, protocol or behaviour changed.

## Boundaries

- **Who opens SQLite?** Only the agent (`apps/agent/src/services.ts`) in `service`
  (default, and always when packaged) and `external`. Electron main opens it only in the
  dev `inprocess` mode, which a production build does not contain.
- **Can the renderer reach the agent port?** No: CSP (`connect-src 'none'`; violation
  proven in the smoke), no API surface, and ESLint bans.
- **child_process / spawn allow-list:** `child_process`, `spawn`, `exec` and
  `worker_threads` are banned everywhere. One `fork` exists, in `agent-supervisor.ts`
  (fixed entry `<app>/out/agent/main.js` and fixed arguments), and one `utilityProcess`
  adapter line in `index.ts`. `security-guards.test.ts` pins both.
- **electron imports in agent packages?** None (ESLint). `agent-supervisor.ts` does not
  import `electron` either (guard test).

## Checks run

- `pnpm check`: **pass** (exit 0)
  - typecheck: pass
  - lint (`--max-warnings=0`): pass
  - `format:check`: "All matched files use Prettier code style!"
  - test: 108 files, 1,427 tests, all pass
  - build: renderer, main, preload, then `Agent service built: …/out/agent/main.js`
- `pnpm package:dir` (Linux x64, Electron 44.10.1), then
  `xvfb-run -a node scripts/smoke-packaged.mjs`: **67/67 checks passed** (temporary
  user-data folder, fake Ollama and SearXNG, no real model).

## Behaviour

- **Intentional changes:** none. Docs, the plan status and one smoke check only.
- **Flag defaults:**

| Build            | `AGENT_TRANSPORT` unset       | `external` / `inprocess`                         |
| ---------------- | ----------------------------- | ------------------------------------------------ |
| Packaged         | supervised agent (`service`)  | ignored with a warning; `service`                |
| `pnpm dev`       | supervised agent (`service`)  | attach to `pnpm agent:dev` / old in-process host |
| `pnpm agent:dev` | standalone agent, no Electron | n/a                                              |

## Residual risks

- **No auto-restart or auto-reconnect.** If the agent exits or the shell connection
  drops, this is logged ("Agent service stopped unexpectedly …" / "Agent service
  disconnected …"), and requests fail until the app restarts. Recovery on the next
  start marks running research tasks as interrupted; they can be resumed. A bounded
  restart would also need the long-lived shell connection used by the IPC handlers to
  be rebuilt (deferred in Phase 8).
- **Tasks outlive the window until the agent stops.** Closing the last window quits the
  app on Windows/Linux, and the quit stops the agent (`system.shutdown`, up to 5 s, then
  kill). A research step that is running at that moment is cut off and recovered as
  interrupted. On macOS (not a target) the app, and so the agent, keeps running without
  a window until Quit.
- **Windows packaged smoke not re-run here.** This phase ran on Linux. The Windows zip
  was cross-built and checked statically in Phase 8 (19/19 static, all fuses as
  expected). Still needed on Windows: `pnpm package:win`, `pnpm smoke:packaged`,
  `pnpm verify:win-build`, and the `release.md` checklist items (second process in Task
  Manager, End task ends the agent, agent port on `127.0.0.1` only).
- **`/proc`-based smoke checks are Linux-only** (utility-process parentage, argv). On
  Windows they are skipped, and the manual checklist covers them.
- **Kill path on Windows.** `UtilityProcess.kill()` terminates without a signal. Only
  `system.shutdown` is a clean stop; WAL and recovery cover the rest (smoke: integrity
  check after a forced kill).
- **Development modes share wording with production.** `inprocess` and `external` stay
  available in dev and tests. Running `inprocess` on a folder an agent is serving is
  unsupported (documented in `agent-process-security.md` §3).
- **Local same-user attackers** can read the state file and token, as they could
  already read the database. This is out of scope (`agent-process-security.md`).

## Risks / decisions

- Deviation from the plan, carried from Phase 8: no bounded restart policy (see above).
- The plan's "Not chosen: `utilityProcess` as the primary model" stays true. The model is
  still a separate, standalone Node service. `utilityProcess` is only how the packaged
  app starts it, as the plan allowed.
