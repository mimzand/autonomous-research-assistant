# Agent Process Separation — Phase 0 Report

## Summary

- Status: **complete**
- The agent ↔ shell contract is frozen in a new package, `@rka/agent-protocol`:
  handshake (hello/ack with token), connection state file, request/response/event/error
  envelopes, error codes, framing constants, and a typed registry of every planned method
  (shell → agent and reverse agent → shell) whose payloads are the existing `@rka/shared`
  schemas. The security model is in
  [agent-process-security.md](agent-process-security.md). Nothing imports the package
  yet, so the desktop app's runtime behaviour is unchanged.

## Changes

**Added**

- `packages/agent-protocol/` — `package.json` (deps: `@rka/shared`, `zod` 4.6.7 — same
  version already used across the workspace), `tsconfig.json` (no Node types, like
  `@rka/shared`), `vitest.config.ts`
  - `src/index.ts` — single package entry
  - `src/errors.ts` — `PROTOCOL_ERROR_CODES`, `ProtocolErrorSchema`, `describeIssues`
    (issue paths only, never values)
  - `src/envelope.ts` — `EnvelopeSchema` (`id`, `kind: req|res|event|error`, `method`,
    `payload`; strict), `decodeEnvelope`, `encodeEnvelope`, framing constants
  - `src/handshake.ts` — `HelloRequestSchema`, `HelloAckSchema`, `AgentTokenSchema`,
    `AgentStateFileSchema`, `parseHello`, protocol name/version, loopback host,
    handshake timeout
  - `src/methods.ts` — `PROTOCOL_METHODS` registry, `parseRequest`, `parseResult`,
    `parseEvent`, derived types (`RequestParams<M>`, `RequestResult<M>`,
    `EventPayload<E>`, `ParsedRequest`, …)
  - `src/{envelope,handshake,methods}.test.ts` — 73 tests
- `docs/agent-process-security.md`
- `docs/agent-process-separation-phase0-report.md` (this file)

**Modified**

- `eslint.config.js` — new block for `packages/agent-protocol/src` (no Node built-ins,
  no Electron, only `@rka/shared`); `@rka/agent-protocol` added to the renderer,
  preload and leaf-package ban lists.
- `apps/desktop/src/main/security-guards.test.ts` — `packages/agent-protocol/src` added
  to the scanned roots (no-process-execution and other guards now cover it).
- `README.md` — structure line + one boundary bullet for the package.
- `pnpm-lock.yaml` — workspace link for the new package only (no new external packages).

**Protocol decisions frozen in this phase**

| Topic               | Decision                                                                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framing             | Length-prefixed: 4-byte unsigned big-endian length + UTF-8 JSON, one envelope per frame, max 16 MiB. Chosen over NDJSON because a stray HTTP/browser request fails at the header immediately.                                                                                                  |
| Handshake           | Not a separate message type: the first frame must be a `req` for `system.hello` (params `HelloRequest` with token); success is a `res` with `HelloAck`; failure is an `error` envelope (`unauthorized` or `unsupported_version`) and the connection closes. One envelope shape for everything. |
| Version             | `PROTOCOL_VERSION = 1`; `HelloAck.version` is the literal 1.                                                                                                                                                                                                                                   |
| Token               | ≥ 32 random bytes, base64url (43–128 chars). Constant-time comparison is the server's job (Phase 1); `parseHello` checks shape and version only.                                                                                                                                               |
| State file          | `{ protocol, version, host: "127.0.0.1", port, token, pid, startedAt }`; `host` is a literal, so a non-loopback file is rejected.                                                                                                                                                              |
| Directions          | Each method has one receiver (`toAgent` / `toShell`). `shell.*` and `ui.*` and all events go to the shell; everything else to the agent. A method in the wrong direction is `unknown_method`.                                                                                                  |
| Empty values        | No params = `{}` (strict); no result = `null`.                                                                                                                                                                                                                                                 |
| Unattributed errors | `error` envelope with method `system.error` and a fresh id, then close.                                                                                                                                                                                                                        |
| Not yet served      | A registered method that a build does not implement answers `not_implemented`. Each registry entry records the planned `phase`.                                                                                                                                                                |

**Method registry (54 entries)**

- `system.hello`, `system.ping` (Phase 1), `system.shutdown` (Phase 8)
- `chat.start`, `chat.stop`, event `chat.event` (Phase 4)
- `tasks.counts|list|get|logs|runPersistenceCheck` (Phase 3);
  `tasks.startResearch|pause|resume|cancel|retry` (Phase 5)
- `sources.list|get`, `reports.list|get`, `storage.status|integrityCheck` (Phase 3);
  `storage.backup` (Phase 6, needs `shell.chooseBackupPath`)
- `researchTools.status|checkSearch|search|fetchUrl|pickFile|extractFile|saveSource|openUrl|cancel` (Phase 6)
- `settings.get|validate|update|reset|testSearxng` (Phase 7)
- `model.health|testConnection|connectionState|connect|disconnect|listModels|showModel|testModel|effectiveConfig` (Phase 7)
- Events `ui.researchProgress` (Phase 5), `ui.settingsChanged` (Phase 7)
- Reverse: `shell.chooseBackupPath|chooseFile|chooseFolder|openExternal|getSecret|encryptionAvailable` (Phase 6)

All request/result/event payloads are the `@rka/shared` schema objects themselves
(e.g. `PROTOCOL_METHODS['chat.start'].params === ChatStartRequestSchema`, asserted in a
test). New schemas were written only where no shared schema exists: hello/ack/state
file, ping/pong, and the reverse `shell.*` payloads (path results, secret key/value,
encryption flag). A test maps every `IpcChannels` entry to a protocol method or marks it
shell-only, so a new renderer channel fails the test until it is classified.

## Boundaries

- **Who opens SQLite?** Electron main, in-process, exactly as before. No change in this phase.
- **Can renderer reach the agent port?** There is no agent port yet. Renderer and preload
  are now also barred by ESLint from importing `@rka/agent-protocol` (verified: an import
  from `src/renderer` fails lint).
- **child_process / spawn allow-list status:** unchanged — no exceptions. The new package
  is in the `security-guards.test.ts` scan. The Phase 8 allow-list intent is documented in
  `agent-process-security.md` §5.
- **electron imports in agent packages?** None. `@rka/agent-protocol` cannot import
  `electron` or any Node built-in (ESLint; verified with a `node:fs` probe).

## Checks run

| Check               | Result                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`    | pass (root + 9 workspace projects, including the new package)                                                                                   |
| `pnpm lint`         | pass (0 warnings)                                                                                                                               |
| `pnpm test`         | pass — 91 files, 1249 tests (73 new in `@rka/agent-protocol`)                                                                                   |
| `pnpm build`        | pass                                                                                                                                            |
| `pnpm format:check` | fails only on `docs/agent-process-separation-plan.md`, a pre-existing file not edited in this phase. All files changed here are Prettier-clean. |

## Behaviour

- **Intentional changes?** None at runtime. No app code imports the new package, and the
  desktop bundle is unaffected. Lint rules and one guard-test root list were extended.
- **Flag defaults?** No `AGENT_TRANSPORT` flag yet (Phase 2). Effective mode: in-process.

## Risks / decisions

- **Deviation — `settings.apply`:** the plan's table lists `settings.apply`; the registry
  instead mirrors the existing Settings IPC (`settings.get|validate|update|reset|testSearxng`).
  `settings.setSecret` and `settings.chooseBackupFolder` are intentionally **not**
  protocol methods (safeStorage and the folder dialog stay in Electron). Phase 7 may
  revise this when it picks the settings authority; the version stays 1 until a
  breaking change ships.
- **Deviation — `model.*` scope:** the plan lists `model.health`; the registry also maps
  all `ollama:*` IPC channels to `model.*`, so Phase 7 has no gaps.
- **Handshake as a method:** hello/ack travel as `system.hello` req/res rather than
  special frames. Keeps one envelope shape; `parseHello` enforces "first message".
- **Codec not implemented:** framing constants are frozen, but the byte-level
  encoder/decoder belongs with the Phase 1 server/client (it needs a transport); the
  JSON layer (`decodeEnvelope`/`encodeEnvelope`) is implemented and tested.
- **Packaging risk surfaced early:** packaged builds turn the Electron `RunAsNode` fuse
  off, so Phase 8 cannot run the agent via `ELECTRON_RUN_AS_NODE`; it must use
  `utilityProcess` (same protocol) or a shipped Node binary, each with a matching
  `better-sqlite3` build. Recorded in the security doc §5.
- **Reverse-call payloads carry local paths** (`shell.choose*`). Acceptable because both
  ends are trusted processes; paths still never reach the renderer.
