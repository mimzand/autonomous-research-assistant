# Agent Host Separation — Phase 0 Report

## Summary

- Status: **complete**
- `@rka/agent-host` now exists as an Electron-agnostic, in-process workspace package that
  exports only the `HostPorts` contract (types, no runtime code). It declares dependencies
  on both runtimes and the leaf packages, `apps/desktop` depends on it, ESLint enforces its
  place in the package DAG (and now actually enforces the agent-runtime ╳ adk-runtime rule,
  which was documented but not previously linted), and the README shows the new layering.
  No engine, controller, service or wiring code moved; no runtime behaviour changed.

## Changes

- Added
  - `packages/agent-host/package.json` — `@rka/agent-host`, private, ESM, single export
    `"."` → `src/index.ts`; dependencies `@rka/shared`, `@rka/model-provider`, `@rka/tools`,
    `@rka/storage`, `@rka/agent-runtime`, `@rka/adk-runtime` (all `workspace:*`).
  - `packages/agent-host/tsconfig.json`, `packages/agent-host/vitest.config.ts` (mirror
    `agent-runtime`; picked up automatically by the root `projects: ['packages/*', …]`).
  - `packages/agent-host/src/ports.ts` — the contract.
  - `packages/agent-host/src/index.ts` — type-only entry.
  - `packages/agent-host/src/index.test.ts` — entry smoke + type-level contract tests (4 tests).
  - `docs/agent-host-separation-phase0-report.md` (this file).
- Modified
  - `apps/desktop/package.json` — `"@rka/agent-host": "workspace:*"` in `devDependencies`
    (bundled like the other `@rka/*` packages). Not imported by production code yet.
  - `pnpm-lock.yaml` — workspace link entries only (`pnpm install`, no new external packages).
  - `eslint.config.js` — see Boundaries.
  - `README.md` — Structure lists `adk-runtime` and `agent-host`; Package boundaries diagram
    and bullet rules updated.
- Moved / deleted: none.

### Public API of `@rka/agent-host`

All exports are `type`-only:

| Type              | Members                                                                                                                                                      | Today's Electron call site (`apps/desktop/src/main`)                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `HostUiPort`      | `emitResearchProgress(event: ResearchProgressEvent): void`, `emitSettingsChanged(event: SettingsChangedEvent): void`                                         | `index.ts` `onResearchEvent` and `config.onChange` window fan-out             |
| `HostDialogPort`  | `chooseBackupPath(): Promise<string \| null>`, `chooseFile(): Promise<string \| null>`, `chooseFolder(defaultPath: string \| null): Promise<string \| null>` | `dashboard.ts`, `research-tools.ts`, `config/settings-service.ts` deps        |
| `HostShellPort`   | `openExternal(url: string): Promise<void>`                                                                                                                   | `research-tools.ts` deps (`isSafeExternalUrl` + `shell.openExternal` adapter) |
| `HostSecretsPort` | `encryptionAvailable(): boolean`, `getSecret(key: SecretSettingKey): string \| undefined`                                                                    | `createRuntimeConfig({ encryptionAvailable })`, provider `getAuthToken`       |
| `HostPorts`       | `extends` all four                                                                                                                                           | Will be built once in `index.ts` (Phase 4)                                    |

Event and key types come from `@rka/shared`, so the ports reuse the existing IPC contracts
instead of defining new ones. No adapters were implemented; JSDoc on each member names the
Electron API the future adapter will wrap.

## Boundaries

- **electron imports in host?** None. Covered by the existing `packages/*/src` rule; verified
  with an ESLint stdin probe (`import { app } from 'electron'` in `packages/agent-host/src`
  → blocked).
- **agent-runtime ↔ adk-runtime?** Still disconnected (no imports in either direction). New
  per-package ESLint blocks for `packages/agent-runtime/src` and `packages/adk-runtime/src`
  ban the other runtime **and** `@rka/agent-host`, and keep the `electron` / `fflate` /
  `@rka/*/*` bans (flat config replaces rule options, so they are restated).
- **renderer/preload still shared-only?** Yes. `@rka/agent-host` and `@rka/adk-runtime` were
  added to both ban lists (the latter was missing before).
- Leaf packages (`model-provider`, `tools`, `storage`): ban list extended with
  `@rka/agent-host` and `@rka/adk-runtime`; still `@rka/shared` only.
- Probe results (ESLint via `--stdin`, no files written):

| File location                | Import                                    | Result  |
| ---------------------------- | ----------------------------------------- | ------- |
| `packages/agent-runtime/src` | `@rka/adk-runtime`                        | blocked |
| `packages/agent-runtime/src` | `@rka/agent-host`                         | blocked |
| `packages/adk-runtime/src`   | `@rka/agent-runtime`                      | blocked |
| `packages/adk-runtime/src`   | `@rka/agent-host`                         | blocked |
| `packages/adk-runtime/src`   | `electron`                                | blocked |
| `packages/tools/src`         | `@rka/agent-host`                         | blocked |
| `packages/agent-host/src`    | `electron`                                | blocked |
| `packages/agent-host/src`    | `@rka/agent-runtime/src/runtime` (deep)   | blocked |
| `apps/desktop/src/renderer`  | `@rka/agent-host`                         | blocked |
| `apps/desktop/src/preload`   | `@rka/agent-host`                         | blocked |
| `apps/desktop/src/main`      | `@rka/agent-host`                         | allowed |
| `packages/agent-host/src`    | `@rka/agent-runtime` + `@rka/adk-runtime` | allowed |

## Checks run

- `pnpm typecheck`: **pass** (root + all 8 workspace projects incl. `@rka/agent-host`)
- `pnpm lint`: **pass** (0 warnings)
- `pnpm test`: **pass** — 87 files / 1170 tests (includes 4 new `agent-host` tests).
  A first run executed in parallel with a second Vitest process had 4 desktop timeouts
  (`remote-ollama.test.ts` and other Legacy/ADK parity tests at the 5 s default, the
  known `@google/adk` cold-load sensitivity); a clean re-run on its own passed fully.
  Not caused by this change (no desktop code touched).
- `pnpm build`: **pass**
- Prettier `--check` on all touched files: pass (full `pnpm check` is a Phase 5 item).

## Behaviour

- Intentional behaviour changes: **none**. No production code imports `@rka/agent-host`
  yet; the built bundles are unaffected.
- Follow-ups / known gaps for later phases:
  - Phase 1: move `chat-engine.ts` / `research-engine.ts` into the host; the declared
    runtime dependencies become real imports.
  - Phase 3: dashboard / research-tools deps should be typed as `Pick<HostPorts, …>` (or the
    port sub-interfaces) so the contract and the service deps cannot drift.
  - Phase 4: build one `HostPorts` in `index.ts` from `BrowserWindow` / `dialog` / `shell` /
    `safeStorage` / `RuntimeConfig.getSecret`, and pass it to `createAgentHost`.

## Risks / decisions

- **`HostSecretsPort` included.** Both members can be typed without Electron types
  (`SecretSettingKey` is in `@rka/shared`). `getSecret` is really served by `RuntimeConfig`
  (SQLite + `safeStorage` cipher), not directly by an OS API. If Phase 4 keeps the Ollama
  provider and `RuntimeConfig` in desktop, this port may stay unused and can be dropped then.
- **Split into four sub-interfaces** instead of one flat interface, so later service
  factories can depend on only the capability they need. `HostPorts` is the union.
- **`chooseFolder(defaultPath)` takes an argument**, matching the real
  `SettingsServiceDeps.chooseFolder`; the plan listed it without parameters.
- **ESLint scope went slightly beyond "add agent-host":** the plan states the runtimes
  "must never depend on each other (ESLint DAG)", but no rule enforced it, and
  renderer/preload did not ban `@rka/adk-runtime`. Both were added because Phase 0 is
  where the DAG is established; no existing code violated them.
- **README Structure** now also lists `adk-runtime` (it was missing) and gives
  `agent-runtime` a description that matches what it currently does instead of
  "no loop yet"; needed for the DAG to be readable. No other README sections touched.
- **Test is type-level plus a fake.** The entry is type-only, so the runtime import
  assertion only proves the module loads; the contract is checked by `expectTypeOf`
  (enforced by `tsc` during `pnpm typecheck`) and by a plain-object implementation.
