# Agent Process Separation — Phase 1 Report

## Summary

- Status: **complete**
- `apps/agent` (`@rka/agent`) is a standalone Node service that listens on `127.0.0.1`
  (ephemeral port by default), writes the connection state file, authenticates clients
  with the `system.hello` token handshake and answers `system.ping`. Every other
  registered method answers `not_implemented`. The byte frame codec was added to
  `@rka/agent-protocol` (Node-free) so the Phase 2 Electron client reuses it. Verified
  manually: `pnpm agent:dev` in one terminal, `pnpm agent:ping` in another →
  `Pong from agent pid 16264 on 127.0.0.1:1149 (handshake + ping 12 ms, …)`. No
  SQLite, no `createAgentHost`, no Electron; the desktop app is unchanged.

## Changes

**Added**

- `packages/agent-protocol/src/framing.ts` — `encodeFrame(envelope)` and
  `FrameDecoder` (incremental; 4-byte big-endian length + UTF-8 JSON; adjustable
  `maxFrameBytes`; strict UTF-8; first error poisons the decoder). Uses only
  `Uint8Array`, `DataView`, `TextEncoder`/`TextDecoder`, so the package stays free of
  Node imports. `framing.test.ts` (11 tests).
- `apps/agent/` — `package.json`, `tsconfig.json`, `vitest.config.ts`, and:
  - `src/server.ts` — `startAgentServer({ token, port, agentVersion, handshakeTimeoutMs, log })`
  - `src/token.ts` — `generateToken` (32 CSPRNG bytes, base64url), `tokensEqual` (`timingSafeEqual`)
  - `src/state-file.ts` — atomic write, validated read, token-guarded remove, pid liveness
  - `src/run.ts` — `runAgent`: stale-file check → token → server → state file; idempotent `stop()`
  - `src/cli.ts` — `--data-dir`, `--state-file`, `--port` (default 0), `--help`; Zod-validated
  - `src/main.ts` — entry (`pnpm agent:dev`); clean shutdown on SIGINT/SIGTERM/SIGBREAK
  - `src/client.ts` — minimal `connectAgent` (handshake, typed `request`, timeouts), used by tests and `ping.ts`
  - `src/ping.ts` — dev check (`pnpm agent:ping`)
  - tests: `server.test.ts` (13, real TCP), `state-file.test.ts` (8), `run.test.ts` (12)

**Modified**

- `package.json` — `agent:dev`, `agent:ping` (`pnpm --filter @rka/agent run …`; `run` is
  required because `ping` is a built-in pnpm command).
- `vitest.config.ts` — `apps/agent` project.
- `eslint.config.js` — `apps/agent` is Node-side; may not import `electron`, the desktop
  app, or deep `@rka/*/*` paths.
- `apps/desktop/src/main/security-guards.test.ts` — `apps/agent/src` scanned by all
  guards (no process execution, no eval, …). One deletion allow-list entry,
  `apps/agent/src/state-file.ts`, pinned to a single `rmSync(path` behind the token check.
- `packages/agent-protocol/src/index.ts` — exports the codec.
- `.gitignore` — `.agent-data/` (dev state file holds a live token).
- `README.md` — scripts table, structure, boundary bullet.
- `docs/agent-process-security.md` — status per control updated to what is now implemented.
- `pnpm-lock.yaml` — workspace link + `tsx@4.23.15` (already in the lockfile via vite;
  no new package downloaded).

**Protocol / public API:** no schema changes. New exports `encodeFrame`, `FrameDecoder`.

**Server behaviour (frozen rules from Phase 0, now enforced)**

| Situation                                             | Response                                                            | Connection |
| ----------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| First frame is not a `system.hello` request           | `error unauthorized` (echoes id/method)                             | closed     |
| Malformed hello                                       | `error unauthorized` "Malformed system.hello."                      | closed     |
| Hello with another `version`                          | `error unsupported_version`                                         | closed     |
| Wrong token (any length)                              | `error unauthorized` "Invalid token."                               | closed     |
| No hello within 5 s                                   | `error unauthorized` "Handshake timed out." (`system.error`)        | closed     |
| Frame > 64 KiB before / > 16 MiB after the handshake  | `error bad_frame` (`system.error`)                                  | closed     |
| Invalid UTF-8 / JSON / envelope                       | `error bad_frame` (`system.error`)                                  | closed     |
| After hello: unknown method, `shell.*`, client event  | `error unknown_method`                                              | open       |
| After hello: invalid params                           | `error bad_request` (paths only)                                    | open       |
| After hello: second `system.hello`                    | `error bad_request` "Already authenticated."                        | open       |
| After hello: registered but unserved (e.g. `tasks.*`) | `error not_implemented`                                             | open       |
| After hello: `system.ping`                            | `res { nonce?, agentTime }` (result validated against `PongSchema`) | open       |

## Boundaries

- **Who opens SQLite?** Electron main, in-process, as before. The agent opens no database
  (`--data-dir` only locates the state file for now).
- **Can renderer reach the agent port?** No. Nothing in the desktop app knows about the
  agent; production CSP stays `connect-src 'none'`; renderer/preload cannot import
  `@rka/agent-protocol` (ESLint).
- **child_process / spawn allow-list status:** unchanged — no exceptions. `apps/agent/src`
  is now covered by the no-process-execution guard. The agent is started by hand
  (`pnpm agent:dev`); Electron does not start it.
- **electron imports in agent packages?** None; ESLint forbids `electron` in `apps/agent`.

## Checks run

| Check               | Result                                                                                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | pass (includes `apps/agent`)                                                                                                                                                                                                                                                                                      |
| `pnpm lint`         | pass (0 warnings)                                                                                                                                                                                                                                                                                                 |
| `pnpm test`         | pass — 95 files, 1293 tests (44 new: 11 codec, 33 agent). See risk on `bench.test.ts` below.                                                                                                                                                                                                                      |
| `pnpm build`        | pass                                                                                                                                                                                                                                                                                                              |
| `pnpm format:check` | fails only on `docs/agent-process-separation-plan.md` (pre-existing, not edited here); all files changed in this phase are Prettier-clean                                                                                                                                                                         |
| Manual              | `agent:dev` + `agent:ping` OK; second `agent:dev` refused ("Another agent (pid …)"); `Get-NetTCPConnection` shows the listener on `127.0.0.1` only; after a forced kill, `agent:ping` fails with `ECONNREFUSED` and the next `agent:dev` replaces the stale file and pings OK; `--port abc` → usage error, exit 2 |

## Behaviour

- **Intentional changes?** None in the desktop app. New standalone process available via
  `pnpm agent:dev` / `pnpm agent:ping`.
- **Flag defaults?** No `AGENT_TRANSPORT` flag yet (Phase 2). Effective mode: in-process.

## Risks / decisions

- **Codec location:** in `@rka/agent-protocol`, not `apps/agent`, so Electron main can
  import it in Phase 2 without depending on another app. `TextEncoder`/`TextDecoder` are
  declared module-locally because the package compiles without DOM/Node typings.
- **Pre-handshake limit (64 KiB) and 16 connections** are server policy, not protocol
  constants; a hello is a few hundred bytes.
- **`tsx` as the dev runner:** Node 24's type stripping cannot resolve the workspace's
  `.js` → `.ts` import specifiers. `tsx` is dev-only; Phase 8 decides the packaged runtime
  (the `RunAsNode` fuse is off, see security doc §5).
- **Windows ACL:** no explicit owner-only ACL is applied (needs `icacls` = process
  execution, or a native module). The state file relies on the per-user ACL of its folder
  (user profile / `%APPDATA%`; dev default `apps/agent/.agent-data`, gitignored). Mode
  0600/0700 applies on POSIX. Revisit in Phase 8 if the data dir can be shared.
- **Stale detection uses pid liveness** (`process.kill(pid, 0)`); a reused pid can cause
  a false "another agent is running" refusal. The message names the file; deleting it or
  using `--state-file` resolves it. Clients still rely on the handshake, never the file alone.
- **Clean-shutdown removal** is tested through `runAgent().stop()`; the Ctrl+C signal path
  itself was not exercised in automation (Windows offers no way to send SIGINT to another
  console process from a test). A forced kill leaves the file, which the next start replaces.
- **Token delivery by CLI was not added.** The token is generated per start and published
  only in the state file; supervisor delivery (env/stdin) is Phase 8 per the security doc.
- **`apps/agent/src/client.ts`** is a minimal reference client for tests and `agent:ping`.
  Phase 2 may move its logic into the desktop `AgentClient` (or a shared Node module);
  it must keep the same framing/handshake.
- **Intermittent unrelated test:** `apps/desktop/src/bench/bench.test.ts > progress log`
  failed in 2 of 3 full-suite runs with `stopReason: 'start-refused'` (the Research start
  readiness/health check against the benchmark's fake Ollama server). It passes in
  isolation and passed in the final full run. The benchmark shares no code, ports or files
  with `apps/agent`; it is likely timing-sensitive under parallel load. Not changed in this
  phase (out of scope); worth a separate look.
