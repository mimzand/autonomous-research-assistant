# Agent process security model

Security model for running the agent as a **standalone Node service** that the Electron
app (or a CLI) talks to over a local protocol. Part of
[agent-process-separation-plan.md](agent-process-separation-plan.md); the in-process app
is covered by [security.md](security.md), whose controls all remain in force.

**Status:** Phase 6 — the contract and frame codec live in `@rka/agent-protocol`; the
standalone server (`apps/agent`) serves the handshake, `system.ping`, the Dashboard
methods, Chat (`chat.start` / `chat.stop`, `chat.event` pushed to the shell),
`model.health`, the research task lifecycle (`ui.researchProgress` broadcast to
every authenticated shell), Research Tools and backup on loopback, and owns SQLite.
Dialogs, `openExternal` and secrets are reverse calls (`shell.*`) that the shell
answers. `@rka/agent-client` (Node) is the shared client. With `AGENT_TRANSPORT=service`
Electron main opens no database and proxies the Dashboard, Chat, model-health,
research task, Research Tools and backup channels to the agent. Settings and process
spawn have not moved yet. The Status column names the phase that implements (or
implemented) each rule.

## Process model

```text
Renderer ──(window.api, Zod IPC)──▶ Electron main (shell) ──(loopback, token)──▶ Agent service
 sandboxed, CSP connect-src 'none'   dialogs, safeStorage,      @rka/agent-protocol     createAgentHost,
                                     window fan-out                                     SQLite, Ollama, tools
```

| Party                                  | Trust                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent service                          | Trusted code. Sole owner of SQLite. Treats web content and model output as untrusted (unchanged).          |
| Shell                                  | Trusted code (Electron main, or a CLI/test client). Owns OS capabilities: windows, dialogs, `safeStorage`. |
| Renderer                               | Untrusted for the agent: it never sees the agent port, token or protocol.                                  |
| Other local processes of the same user | Can see open loopback ports; must be stopped by the token.                                                 |
| Other users / remote hosts             | Must not be able to connect at all.                                                                        |

## Threats

| Threat                                                                  | Control                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A remote host or another machine on the LAN connects to the agent       | Loopback-only bind                                                   |
| Another local process (or web page via DNS rebinding) talks to the port | Token handshake, binary framing, short handshake timeout             |
| The renderer (compromised by web content) reaches the agent directly    | No API, CSP `connect-src 'none'`, ESLint ban on the protocol package |
| Two processes write the database and corrupt it                         | Single DB writer                                                     |
| Secrets leak through logs, the state file or the renderer               | Secrets handling rules                                               |
| The new spawn capability is abused to run arbitrary programs            | Spawn allow-list                                                     |
| Malformed or oversized messages crash or confuse either side            | Zod on every envelope and payload, frame size cap                    |

## Controls

### 1. Loopback bind

| Rule                                                                                                                                                                                          | Where                                                                                                                                                | Status                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent listens on `127.0.0.1` only (`AGENT_LOOPBACK_HOST`), on an ephemeral port by default. Never `0.0.0.0`, `::`, `localhost` (may resolve elsewhere) or a LAN address.                  | `AgentStateFileSchema.host` is the literal `127.0.0.1`; `apps/agent/src/server.ts` listens with `host: AGENT_LOOPBACK_HOST` (no option to change it) | Done (Phase 1): `server.test.ts`; OS check shows the listener on `127.0.0.1` only. Client (Phase 2): a state file naming any other host is rejected before connecting (`connect.test.ts`) |
| No option to listen remotely. A future named-pipe transport must keep the same handshake and an owner-only ACL.                                                                               | —                                                                                                                                                    | Policy                                                                                                                                                                                    |
| Framing is length-prefixed binary (4-byte length + UTF-8 JSON), not HTTP. A browser request (e.g. DNS rebinding) is not a valid frame and is dropped before any method runs.                  | `FrameDecoder` / `encodeFrame` in `@rka/agent-protocol` (`MAX_FRAME_BYTES` 16 MiB)                                                                   | Done (Phase 1): `framing.test.ts`, `server.test.ts` (HTTP request → `bad_frame`, closed)                                                                                                  |
| Before the handshake the server accepts frames of at most 64 KiB (`HANDSHAKE_MAX_FRAME_BYTES`), so an unauthenticated client cannot make it buffer 16 MiB. At most 16 concurrent connections. | `server.ts`                                                                                                                                          | Done (Phase 1): `server.test.ts`                                                                                                                                                          |

### 2. Token and state file

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On every start the agent generates a fresh token of at least 32 random bytes (base64url, 43–128 chars; `AgentTokenSchema`) from a CSPRNG. Tokens are never reused across starts.                                                                                                                                                                                                                                                                                                                                             | Done (Phase 1): `token.ts` (`randomBytes(32)`), `runAgent`                                                                                                       |
| The agent writes `{ protocol, version, host, port, token, pid, startedAt }` (`AgentStateFileSchema`, strict) atomically (temp file + rename) to `<data-dir>/agent-state.json` or `--state-file`. POSIX: mode 0600 in a 0700 folder. Windows ignores the mode; the file inherits the data folder's ACL, which is per-user under the user profile / `%APPDATA%` (and the gitignored `apps/agent/.agent-data` in dev). No explicit Windows ACL is set: that would need `icacls` (process execution, banned) or a native module. | Done (Phase 1): `state-file.ts`, `state-file.test.ts`                                                                                                            |
| The supervising shell may instead pass the token to the child it starts (environment or stdin, never a command-line argument, which other users can read).                                                                                                                                                                                                                                                                                                                                                                   | Phase 8                                                                                                                                                          |
| The first frame must be a `system.hello` request carrying the token (`parseHello`). Anything else, a malformed hello, or no hello within `HANDSHAKE_TIMEOUT_MS` (5 s) closes the connection with `unauthorized`.                                                                                                                                                                                                                                                                                                             | Done (Phase 1): `server.test.ts`                                                                                                                                 |
| The server compares tokens in constant time (`crypto.timingSafeEqual` on equal-length buffers; a different length is compared against itself) and answers every mismatch with the same `Invalid token.`.                                                                                                                                                                                                                                                                                                                     | Done (Phase 1): `token.ts`, `server.test.ts`                                                                                                                     |
| A well-formed hello with another protocol version gets `unsupported_version`, so upgrades fail clearly. This reveals only the version, never whether the token was right.                                                                                                                                                                                                                                                                                                                                                    | Contract: Phase 0                                                                                                                                                |
| Error messages name schema paths, never values, so a rejected hello cannot echo its token (`describeIssues`).                                                                                                                                                                                                                                                                                                                                                                                                                | Contract: Phase 0 (tested)                                                                                                                                       |
| A stale state file (agent crashed) is detected by a dead `pid` or a failed handshake; clients never trust the file alone. On start the agent refuses if the file's `pid` is alive and replaces it otherwise. On clean shutdown (SIGINT/SIGTERM/SIGBREAK) it removes the file, only if it still holds this run's token.                                                                                                                                                                                                       | Agent: done (Phase 1), `run.test.ts`, `state-file.test.ts`. Client: done (Phase 2), `connect.test.ts` (dead pid → `not_running`, closed port → `connect_failed`) |
| The agent logs never contain the token (port, pid and state-file path only).                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Done (Phase 1): `main.ts`, `server.ts`                                                                                                                           |

### 3. Single database writer

| Rule                                                                                                                                                                 | Status                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In service mode only the agent opens `better-sqlite3` (migrations, recovery, every read and write). Electron proxies dashboard/storage/task calls over the protocol. | Done (Phase 3): `services.ts`, `service-ipc.ts`; `services.test.ts`, `service-shell.test.ts`. Chat usage is written by the agent (Phase 4, `chat.test.ts`)                     |
| Electron asserts it does not call `openAppStorage` / `openStorage` when `AGENT_TRANSPORT=service` (code assertion + test).                                           | Done (Phase 3): `openAppStorage` throws in service mode (`app-storage.test.ts`); the service path never calls `openStorage` (`service-shell.test.ts`, storage mocked to throw) |
| No dual-write path ships: the in-process host is removed from the production bootstrap at cutover.                                                                   | Phase 8                                                                                                                                                                        |
| The agent keeps SQLite journaling and the existing recovery on open, so an agent crash cannot leave a half-written database.                                         | Done (Phase 3): same `openStorage` (WAL) and `recoverInterruptedTasks` on open (`services.test.ts`)                                                                            |

In-process mode (the default) is unchanged and its Electron process is the only writer.
Nothing yet stops a developer from running the in-process app and an agent on the same
data folder at once (the dev agent uses its own `apps/agent/.agent-data` by default).
SQLite's locking prevents corruption, but whichever process opens second marks the
other's running tasks as interrupted during recovery, so this setup is unsupported. A
cross-process lock arrives with supervision (Phase 8).

### 4. Secrets

| Rule                                                                                                                                                                                  | Status                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safeStorage` encryption and decryption stay in Electron. The agent never imports `electron`.                                                                                         | Policy (ESLint)                                                                                                                                                                                                                                                                                          |
| The agent obtains a secret only through the reverse call `shell.getSecret` on an authenticated connection. Keys are limited to `SECRET_SETTING_KEYS` (today only `ollama.authToken`). | Contract: Phase 0. Port: Phase 6 (`shell-ports.ts`): asked of the requesting connection if it declared `shell`, else the newest `shell` connection, never a `cli`/`test` client (`shell-ports.test.ts`). No consumer until Phase 7; in service mode the shell has no secret store yet and answers `null` |
| Secrets are held in agent memory only: never written to the state file, SQLite in plaintext, logs, error messages or protocol events.                                                 | Phase 6 / 7. Phase 6: a failing shell handler answers a generic `internal` message and the client never logs `shell.getSecret` error details (`client.test.ts`)                                                                                                                                          |
| No protocol method returns a secret to the shell, and nothing on the protocol is forwarded to the renderer except the existing `@rka/shared` DTOs, which contain no secrets.          | Contract: Phase 0                                                                                                                                                                                                                                                                                        |
| `settings.setSecret` is not a protocol method: the shell encrypts and stores it; Phase 7 decides whether ciphertext lives in SQLite or stays in Electron.                             | Phase 7                                                                                                                                                                                                                                                                                                  |
| The Ollama token is still sent only over HTTPS or to loopback (`canSendCredentials`), now from the agent process.                                                                     | Phase 7                                                                                                                                                                                                                                                                                                  |
| The session token itself is a secret: not logged, not sent to the renderer, not included in error messages.                                                                           | Agent: done (Phase 1, `server.test.ts`). Client: done (Phase 2): the token stays inside `@rka/agent-client`; `connectFromStateFile` returns the state without it (`connect.test.ts`, `agent-transport.test.ts`). Renderer: never receives it (client lives in Electron main only)                        |

### 5. Spawn allow-list (intent)

Shipped code may not use `child_process`, `spawn`, `exec`, `fork` or `worker_threads`
today (`security-guards.test.ts`). Process separation needs **one** narrow exception,
added in Phase 8 and nowhere else:

- Only a single supervisor module in Electron main may start a process, and only the
  agent entry resolved from the app's own install directory (fixed path, fixed
  arguments). No user-, settings-, web- or model-supplied strings reach the command
  line. No `shell: true`.
- The exception is an explicit allow-list entry in `security-guards.test.ts` naming
  that one file; every other shipped file (including `apps/agent` and all packages)
  keeps the existing ban. Agent tools still never get a shell.
- The supervisor starts the agent before UI calls that need it, restarts it with a
  bounded policy, and stops it on quit.
- Packaged builds have the `RunAsNode` fuse **off** (see [security.md](security.md)),
  so the agent cannot simply run as `ELECTRON_RUN_AS_NODE`. Phase 8 must pick and
  evidence a runtime (Electron `utilityProcess` speaking the same protocol, or a
  shipped Node binary) together with a `better-sqlite3` build for that runtime, and
  must not weaken the fuse.
- In standalone/dev mode (`pnpm agent:dev`) nothing is spawned by the app.

### 6. Renderer isolation preserved

| Rule                                                                                                                                                            | Where                              | Status                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| The renderer keeps talking only to Electron through the frozen `window.api`; `RendererApi` and `IpcChannels` do not change shape for the process split.         | `@rka/shared`, `preload/index.ts`  | Unchanged                                                    |
| Renderer and preload must not import `@rka/agent-protocol` or `@rka/agent-client`.                                                                              | `eslint.config.js`                 | Phase 0/2 (lint)                                             |
| No preload function exposes the agent port, token, state-file path or a generic protocol call.                                                                  | `preload/index.ts`                 | Policy; tested Phase 2+                                      |
| Production CSP `connect-src 'none'` keeps the page from opening any socket or `fetch`, including to `127.0.0.1`.                                                | `electron.vite.config.ts`          | Unchanged                                                    |
| Local file paths from dialogs travel agent ↔ shell only (both trusted) and never reach the renderer, which still sees opaque tokens (Research Tools guarantee). | `researchTools.*`, `shell.choose*` | Contract: Phase 0; served Phase 6 (`research-tools.test.ts`) |

### 7. Message validation

- Every frame is decoded with `decodeEnvelope` (Zod `EnvelopeSchema`: `id`, `kind`
  `req | res | event | error`, `method`, `payload`; unknown keys rejected).
- Every request, result and event payload is validated against the method's schema in
  `PROTOCOL_METHODS` (`parseRequest`, `parseResult`, `parseEvent`). Payload schemas are
  the `@rka/shared` schemas already used for renderer IPC.
- Each method has a fixed direction: the agent never serves `shell.*`, the shell never
  serves agent methods; a method in the wrong direction is `unknown_method`.
- Methods in the registry that a build does not serve yet answer `not_implemented`.
- Events are validated on both sides: the agent refuses to send a `chat.event` that
  fails `parseEvent` (logged, dropped), and `@rka/agent-client` drops any pushed event
  that fails `parseEvent` before a listener sees it. Electron forwards only these
  validated `ChatEvent`s to the window that started the stream, as in-process
  (Phase 4: `server.test.ts`, `client.test.ts`, `service-chat.test.ts`).
- Broadcast events (`ui.researchProgress`, Phase 5) go only to connections that
  completed the token handshake, and each one is validated with `parseEvent` the same
  way. Electron fans them out to every window on `IpcEvents.researchProgress`, where
  the preload validates them again (`server.test.ts`, `service-shell.test.ts`).
- Reverse calls (`shell.*`, Phase 6): the agent validates outgoing params with
  `parseRequest(…, 'toShell')`, correlates the answer by request id **and** method on
  the same connection, and validates the result with `parseResult`. An unmatched
  `res`/`error` is logged and ignored. Each call has a timeout (dialogs
  `SHELL_DIALOG_TIMEOUT_MS` = 10 min, others 30 s) and fails with `shell_unavailable`
  as soon as its connection closes, so no operation waits for a vanished shell. The
  shell validates each request with `parseRequest(…, 'toShell')` (agent methods are
  `unknown_method`) and its own result with `parseResult` before sending
  (`shell-ports.test.ts`, `research-tools.test.ts`, `client.test.ts`).
- Dialogs and `openExternal` go only to the connection whose request is being served
  (tracked with `AsyncLocalStorage`), never to another client. `openExternal` is
  checked twice: the agent's Research Tools service opens only public http(s) URLs it
  returned from a search or fetch, and the Electron port still refuses non-http(s)
  URLs (`isSafeExternalUrl`). The save dialog (overwrite confirmation) stays in Electron.
- Web content and model output inside payloads stay untrusted data, exactly as today;
  the protocol carries no instructions.

## Out of scope

- Multi-user machines with hostile local users who can read the user's own files: they
  can read the state file and token, as they could already read the database.
- Transport encryption on loopback: traffic never leaves the machine; the token prevents
  other processes from issuing calls.
