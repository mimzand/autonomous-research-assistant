# Agent Process Separation — Phase 7 Report

## Summary

- Status: **complete**
- With `AGENT_TRANSPORT=service`, Settings and live reconfiguration belong to the agent
  service. It builds the same Runtime Configuration Manager as the in-process app (built-in
  < environment < saved) and registers the same live appliers for the Ollama provider and
  the web search/fetch services. Electron's Settings page is now a protocol client:
  `settings.*` and the remaining Ollama channels are proxied to the agent, and
  `ui.settingsChanged` is fanned out to every window. A change to the model, Ollama URL,
  web search/SearXNG or the access token applies to the next Chat or research request
  without a restart; `apps/agent/src/settings.test.ts` proves this end to end.
  Secrets still use `safeStorage` in Electron. Service mode used to have no secret store,
  so `shell.getSecret` always returned `null`; it now decrypts the stored ciphertext. The
  default transport is still `inprocess`, and in-process behaviour is unchanged.

## Secret persistence decision

**Ciphertext in SQLite, encrypted and decrypted only by Electron.** Plaintext is never
written anywhere.

| Step            | Where                      | What happens                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store           | Electron main              | `settings:set-secret` → `ServiceSettings.setSecret`. It validates with the same rule as in-process (`secretValueProblem`: no spaces; refused when OS encryption is unavailable). It then encrypts with `safeStorage` and sends `settings.storeSecret {key, ciphertext}`, or `ciphertext: null` to clear. The protocol schema is strict and rejects a `value` field. |
| Persist         | Agent (single DB writer)   | `settings.setSecretCiphertext('secret.ollama.authToken', base64)` writes the same row and format (`is_secret = 1`) as the in-process app, so a token saved in either mode works in the other.                                                                                                                                                                       |
| Use             | Agent memory               | The agent calls `shell.getSecret {key, ciphertext}`. Electron decrypts and answers `{value}` (or `null`) on the authenticated loopback connection. The value is kept in an in-memory map (`apps/agent/src/secrets.ts`) and read by the Ollama provider's `getAuthToken`.                                                                                            |
| Load at startup | Agent, first shell request | `withShellSecrets` waits until every stored secret has been decrypted before serving a request from a `shell` connection. Electron sends `settings.get` right after connecting, so the token is ready before the first chat. After a failure, decryption is retried only for a different shell connection, so a broken shell cannot slow down every request.        |

Why this shape:

- One format and one row in both modes. No dual-write, no migration, no plaintext.
- The agent never imports `electron` and holds no key. Without a connected desktop shell
  (for example a CLI client), stored secrets stay unreadable and requests go without a token.
- The rejected alternative (keeping ciphertext in Electron's own file) would have split
  Settings across two stores and broken the single-writer rule.

Invariants that hold:

- Plaintext is never in SQLite, logs, error messages, protocol events or the renderer.
- Logs name the key only. Decrypt errors are reported by error code only.
- A slow, older decrypt never overwrites a newer stored value (per-key version).
- The HTTPS/loopback rule (`canSendCredentials`) is unchanged and still decides whether
  the token is sent.

## Changes

### Moved (no logic change except the `SecretStore` seam)

- `apps/desktop/src/main/config/{runtime-config,env-overrides,services,settings-service}.ts`
  and their tests → `packages/agent-host/src/config/`. They are exported from
  `@rka/agent-host`, so the agent and Electron share one Runtime Configuration Manager and
  one set of appliers (no duplication). Desktop importers were updated.

### Added

- `apps/agent/src/secrets.ts`: `createAgentSecretStore`, which stores ciphertext, decrypts
  through the shell and keeps plaintext in memory only. Tests: `secrets.test.ts` (7).
- `apps/agent/src/settings.test.ts`: the DoD end to end test (3). It uses a real agent
  server, a real `AgentClient` as `shell` with a fake key store, and two fake Ollama
  servers.
- `apps/desktop/src/main/service-settings.ts`: the Settings client side for service mode.
  It encrypts secrets, decrypts on request, adds encryption availability to views and
  remembers the backup folder. It does not import `electron`.

### Changed

- `runtime-config.ts`: a `SecretStore` seam (`storageSecretStore` is the in-process
  default, with identical behaviour), `secretValueProblem` (shared validation) and
  `secretChanged`.
- `@rka/storage` settings repository: `setSecretCiphertext` / `getSecretCiphertext`
  (base64-validated; reading a plain row is refused). Tests added.
- `apps/agent/src/services.ts`: builds the config, provider and appliers. A live
  `webApplier` is used unless web services are injected (tests). The session-only Ollama
  connection flag is kept. It also builds the settings service (backup folder dialog via
  `shell.chooseFolder`) and broadcasts `ui.settingsChanged`.
- `apps/agent/src/handlers.ts`: `settingsHandlers` serve `settings.get`, `validate`,
  `update`, `reset`, `testSearxng`, `chooseBackupFolder` and `storeSecret`, plus
  `model.testConnection`, `connectionState`, `connect`, `disconnect`, `listModels`,
  `showModel`, `testModel` and `effectiveConfig`. Also adds `withShellSecrets`.
- `apps/agent/src/shell-ports.ts`: `getSecret(key, ciphertext)`.
- Electron `service-ipc.ts`: 14 new routes (41 in total), so every renderer channel is now
  served. Timeouts: dialog methods 15 min, network methods (SearXNG/Ollama tests, model
  list/show/test) 5 min. `settings:set-secret` goes through `ServiceSettings`.
- Electron `service-shell.ts` / `service-shell-ports.ts` / `index.ts`: serve
  `shell.getSecret` (decrypt) and `shell.encryptionAvailable` from `safeStorage`; forward
  `ui.settingsChanged`; send a startup `settings.get`. The backup dialog opens in the
  folder the agent reports.

### Protocol / public API

- `PROTOCOL_VERSION` 1 → **2**, because `shell.getSecret` params now carry `ciphertext`.
  Version-1 peers are refused at the handshake. Tests now use `PROTOCOL_VERSION` instead
  of a literal.
- New `toAgent` methods: `settings.storeSecret {key, ciphertext | null}` and
  `settings.chooseBackupFolder` (`SettingsUpdateResult | {status:'cancelled'}`).
- `apps/agent` now depends on `@rka/shared` (`workspace:*`; already in the workspace, no
  new third-party dependency).

## Boundaries

- **Who opens SQLite?** Service mode: only the agent. Electron opens no database (the
  storage-import guard in `service-shell.test.ts` now also covers `service-settings.ts`).
  In-process mode: Electron, as before.
- **Can the renderer reach the agent port?** No. The client and token live in Electron
  main only, and the renderer keeps its CSP and sandbox. Settings views carry
  `secrets: {set}` only.
- **child_process / spawn:** unchanged (none added; process spawn is Phase 8).
- **electron imports in agent packages?** None. `ShellSecretCipher` is an interface, and
  Electron passes `safeStorage`.

## Checks run

- `pnpm typecheck`: pass
- `pnpm lint` (`--max-warnings=0`): pass
- `pnpm test`: **107 files, 1,407 tests, all pass**
- `pnpm build`: pass
- `pnpm format:check`: flags only `docs/agent-process-separation-plan.md`, the user's
  plan, which is deliberately left unedited. All files changed in this phase pass.

No live Ollama, GPU inference or remote server was used. The DoD test uses local fake
Ollama HTTP servers on 127.0.0.1.

## Behaviour

- **Intentional changes (service mode only):**
  - Settings, the Ollama connection page and the backup-folder picker work.
  - Changes apply live.
  - The access token is stored, applied immediately and survives restarts.
  - Disconnect/Connect stays session-only, as in-process.
- **In-process:** no behaviour change. It uses the same moved modules with
  `storageSecretStore`, and the existing config, precedence and IPC tests pass unchanged.
- **Flag default:** `AGENT_TRANSPORT` is still `inprocess`.

## Risks / decisions

- **Protocol bump.** An Electron and an agent from different builds will not connect
  (clear handshake error). This is acceptable before the Phase 8 packaging cutover.
- **Token with no shell.** If no desktop shell is connected, the agent cannot decrypt, so
  Ollama requests go without a token (and a protected server answers 401). This is by
  design: the agent holds no key.
- **Environment overrides are per process.** In service mode the agent's environment
  (`OLLAMA_HOST`, `OLLAMA_MODEL`, `AGENT_ENGINE`, `RESEARCH_ENGINE`) decides overrides.
  Electron's environment no longer affects Settings in that mode.
- **Encryption availability** is shown from Electron's `safeStorage`, which is patched into
  every view and event. The agent reports `false` on its own, because it cannot encrypt.
- **Reconnects.** A lost agent connection still needs an app restart (unchanged from
  Phase 2). On a new shell connection, secrets that failed to load before are retried.
- **Not done (Phase 8):** spawning and supervising the agent, packaging, and changing the
  default transport.
