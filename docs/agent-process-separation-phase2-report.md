# Agent Process Separation — Phase 2 Report

## Summary

- Status: **complete**
- Electron main can now reach the standalone agent. With `AGENT_TRANSPORT=service`
  it reads the agent state file, connects to `127.0.0.1`, authenticates with the
  `system.hello` token handshake and sends `system.ping` before anything else starts.
  It logs the result, or refuses to start with a clear message if the agent is
  unreachable. The default stays `inprocess`, which works exactly as before.
- The client lives in a new Node package, `@rka/agent-client`, shared by Electron main
  and `apps/agent` (`agent:ping`, tests). That avoids an app → app dependency.
- SQLite still opens in Electron main, and `createAgentHost` still runs all agent work
  in-process, in both modes. The renderer and preload are untouched.

## Changes

**Added**

- `packages/agent-client/` (`@rka/agent-client` → `@rka/agent-protocol`; Node, no Electron):
  - `src/client.ts`: moved from `apps/agent/src/client.ts` (`git mv`) and hardened.
    `connectAgent({ port, token, client, timeoutMs })` connects to `127.0.0.1`, sends
    the hello, validates the ack and returns an `AgentClient` with `ack`,
    `request(method, params)`, `onClose(listener)` and `close()`. Requests are typed by the method registry, and
    results are validated with `parseResult`. Every failure is an `AgentClientError`
    with a `code`: a protocol error code, or `not_running`, `state_file_invalid`,
    `connect_failed` or `connection_closed`. Each await has a deadline (connect,
    handshake and each request; default 10 s), so nothing hangs.
  - `src/state-file.ts`: `readStateFile` (missing / invalid / ok; 64 KiB cap; strict
    `AgentStateFileSchema`, so the host must be the literal `127.0.0.1`) and
    `isProcessAlive`. Moved here from `apps/agent` so client and server share one
    reader.
  - `src/connect.ts`: `connectFromStateFile(path, options)` reads and validates the
    file, refuses a dead pid, connects and returns `{ client, state }`. The returned
    `state` omits the token.
  - `src/test-fixtures.ts`: a scriptable fake agent on `127.0.0.1` (used by both test
    suites).
  - Tests: `client.test.ts` (9) and `connect.test.ts` (11).
- `apps/desktop/src/main/agent-transport.ts`:
  - `agentTransportFromEnv(env)`: unset or empty means `inprocess`; matching is
    case-insensitive; any other value throws
    `AGENT_TRANSPORT must be "inprocess" or "service" (got "…").`
  - `agentStateFilePath(...)`: `AGENT_STATE_FILE` if set; dev default
    `apps/agent/.agent-data/agent-state.json`; packaged default
    `<userData>/agent-state.json`.
  - `connectServiceAgent({ stateFile, appVersion, timeoutMs = 5 s })`: connects as
    client `{ kind: 'shell' }`, pings, and returns a one-line summary. On failure it
    closes the socket and throws an actionable error.
  - `agent-transport.test.ts` (10), including a real loopback round trip through a
    temp state file.

**Modified**

- `apps/desktop/src/main/index.ts`: `bootstrap` is now async and first awaits
  `connectAgentService()`. That function returns at once in `inprocess` mode. In
  `service` mode it logs `Agent service: connected to …`, warns on an unexpected
  disconnect and closes the client on `will-quit`. A failure rejects `bootstrap`, so
  the existing handler shows the error dialog and quits. This happens before
  `openAppStorage`, so a failed start never opens the database. Nothing after it
  changed.
- `apps/desktop/package.json`: devDependencies `@rka/agent-client` and
  `@rka/agent-protocol` (`workspace:*`, bundled like the other packages).
- `apps/agent`: `ping.ts` uses `connectFromStateFile`; `state-file.ts` keeps only the
  writer and the token-guarded remover, and re-uses the client's reader; `run.ts` and
  the tests import from `@rka/agent-client`; `package.json` depends on it.
- `eslint.config.js`: renderer, preload, `@rka/agent-protocol` and leaf packages may not
  import `@rka/agent-client`. `packages/agent-client` may not import `electron`, other
  `@rka/*` packages (except protocol/shared) or deep paths.
- `apps/desktop/src/main/security-guards.test.ts`: scans `packages/agent-client/src`
  (no process execution, no eval, no deletion, …).
- `README.md`: structure, boundary bullets, and an `AGENT_TRANSPORT` /
  `AGENT_STATE_FILE` table with a try-it line.
- `docs/agent-process-security.md`: Phase 2 status (client rejects non-loopback hosts
  and stale pids; the token never leaves the client).
- `pnpm-lock.yaml`: workspace links only; no new external dependency.

**Protocol / public API:** no schema changes. `RendererApi`, `IpcChannels` and
`app:get-info` are unchanged; the connectivity proof is the startup log line.

## Package placement

| Option                                 | Verdict                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Desktop imports `@rka/agent`           | Rejected: app → app dependency, and it would pull the server into the Electron bundle         |
| Client inside `@rka/agent-protocol`    | Rejected: that package is deliberately Node-free (ESLint) so any runtime can use the contract |
| Copy of the client in `apps/desktop`   | Rejected: two handshake implementations would drift                                           |
| **New `packages/agent-client` (Node)** | Chosen: one client for desktop, CLI and tests. The writer and remover stay in `apps/agent`    |

## Boundaries

- **Who opens SQLite?** Electron main, in-process, in both modes. The agent still opens
  no database.
- **Can renderer reach the agent port?** No. The client runs in Electron main only.
  Preload exposes nothing new. Renderer and preload cannot import `@rka/agent-client`
  or `@rka/agent-protocol` (ESLint). Production CSP stays `connect-src 'none'`.
- **child_process / spawn allow-list status:** unchanged, no exceptions. Electron does
  not start the agent; in service mode it must already be running (`pnpm agent:dev`).
- **electron imports in agent packages?** None. ESLint forbids `electron` in `apps/agent`
  and `packages/agent-client`.
- **Token handling:** read from the state file inside `connectFromStateFile`, sent only
  in the hello, never returned, logged or put in error messages (tested).

## Checks run

| Check               | Result                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | pass                                                                                  |
| `pnpm lint`         | pass                                                                                  |
| `pnpm test`         | pass: 98 files, 1323 tests (30 new: 9 client, 11 connect, 10 desktop transport)       |
| `pnpm build`        | pass                                                                                  |
| `pnpm format:check` | fails only on `docs/agent-process-separation-plan.md` (pre-existing, not edited here) |

**Manual verification (Windows, PowerShell)**

1. `pnpm agent:dev` → `[agent] Listening on 127.0.0.1:18558 (pid 15388).`
2. `$env:AGENT_TRANSPORT='service'; pnpm dev` → main logs
   `Agent service: connected to 127.0.0.1:18558 (agent pid 15388, v0.1.0, protocol 1); handshake + ping 11 ms.`
   The agent logs `Client authenticated (shell).` Ollama startup check and UI are normal.
3. Agent force-killed while the app runs → main logs
   `Agent service disconnected: The agent closed the connection.` (the app keeps running;
   nothing depends on the connection yet).
4. Agent stopped (stale state file left by the forced kill) → the app refuses to start
   within a second:
   `AGENT_TRANSPORT=service, but the agent service is not reachable. The agent state file …\apps\agent\.agent-data\agent-state.json is stale: process 15388 is not running. Start it with "pnpm agent:dev", or unset AGENT_TRANSPORT to run in-process.`
   (logged and shown in the startup error dialog). The missing-file and closed-port
   cases fail the same way (`connect.test.ts`, `agent-transport.test.ts`).
5. `AGENT_TRANSPORT` unset → no agent log line, normal start (in-process unchanged).

## Behaviour

- **Intentional changes?** Only with `AGENT_TRANSPORT=service`: a startup handshake +
  ping, one log line, and a refusal to start if the agent is unreachable.
- **Flag defaults?** `AGENT_TRANSPORT=inprocess`. Effective mode for all existing users
  and tests: in-process.

## Risks / decisions

- **The flag is read from the process environment (and the dev `.env`) only.** It is
  not in the `settings.env` allow-list: service mode needs a hand-started agent, so
  it is a developer switch for now. Phase 8 decides how the installed app chooses its
  transport.
- **Packaged builds honour the variable too.** Without a running agent they refuse to
  start, which is the requested failure mode. The packaged state-file default
  (`<userData>/agent-state.json`) is provisional until Phase 8 decides where a
  supervised agent writes its file.
- **No reconnect.** A lost connection is logged once. Nothing uses the connection after
  startup yet, so reconnection and backoff belong to the phase that routes real calls.
- **Connect timeout is 5 s in Electron** (10 s default in the client), so a hung
  listener delays startup by at most a few seconds before the error dialog.
- **Stale detection still uses pid liveness**, so a reused pid passes the file check.
  It then fails at connect or handshake (`connect_failed` / `unauthorized`), never
  hangs.
- **Proof is log-only.** `app:get-info` was not extended, to keep the renderer contract
  frozen.
- **Dev-only renderer glitch seen once:** the first service-mode run coincided with
  Vite's "re-optimizing dependencies" reload, and the renderer logged `window.api`
  undefined. It did not recur on reruns in either mode and is unrelated to the
  transport, which runs in main before the window exists.
- **Intermittent unrelated test** `bench.test.ts > progress log` (see Phase 1 report)
  did not fail in this phase's runs; still worth a separate look.
