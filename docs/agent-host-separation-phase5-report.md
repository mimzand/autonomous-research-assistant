# Agent Host Separation — Phase 5 Report

## Summary

- Status: **complete**
- The audit of `apps/desktop/src/main` found no leftover agent composition, so no code
  moved in this phase.
- ESLint now enforces the remaining main-process boundary: production code in Electron
  main may not import `@rka/adk-runtime`, except the startup ADK self-check
  (`adk-probe.ts`). Tests are also exempt.
- The documentation is updated:
  - `HostPorts` documents which members `createAgentHost` consumes and which only the
    shell uses;
  - the README shows the final DAG, with `createAgentHost` between the runtimes and a
    thin Electron adapter;
  - the plan says "Phase 5 complete", and the plan file is now Prettier-clean.
- `pnpm check` passes, including `format:check`, which is clean for the first time in this
  plan.
- **Process separation is NOT done.** Agents still run in-process in Electron main. A
  utility process or sidecar was out of scope for the whole plan (see the plan's §9).

## Changes

- Modified
  - `eslint.config.js`
    - The main-process cross-folder ban is now a shared constant, `mainCrossFolderBan`.
    - A new block covers `apps/desktop/src/main/**/*.ts`, except `adk-probe.ts` and
      `**/*.test.ts`. It bans `@rka/adk-runtime` and repeats the cross-folder ban, because
      in flat config the later `no-restricted-imports` setting replaces the earlier one.
  - `packages/agent-host/src/ports.ts`: documentation only. The `HostPorts` JSDoc now
    says which members are consumed where:
    - `createAgentHost` consumes `AgentHostPorts`;
    - `emitSettingsChanged` and `chooseFolder` are used by the desktop Settings service;
    - `HostSecretsPort` has no consumer.
  - `README.md`
    - The DAG labels the host edge `createAgentHost(HostPorts)` and `src/main` as a thin
      adapter.
    - The `@rka/agent-host` bullet now describes the finished composition root. It replaces
      the old "remaining agent wiring will move here" note.
    - A new bullet describes what `src/main` owns and the ESLint-enforced ADK probe
      exception.
  - `docs/agent-host-separation-plan.md`
    - The status line reads "Phase 5 complete" and states that process separation is not
      done.
    - Prettier was run on the file. Apart from the status line, the changes are table
      alignment and whitespace only.
- Added: this report.
- No source files were added, moved or deleted. No dependency or lockfile changes.
- Public API changes on `@rka/agent-host`: **none** (JSDoc only).

### Decision: ADK probe — documented exception, not `host.probeAdk()`

`probeAdkRuntime` is a startup diagnostic. It loads ADK and runs its offline self-check,
and it is not part of the agent graph. Keeping it in desktop and enforcing the exception
in ESLint changes one config file. A `host.probeAdk()` would have needed a new host API,
a moved module and test, and new `index.ts` wiring, and it would not have changed
behaviour. The exception is enforced, not just documented: any other production file in
`src/main` that imports `@rka/adk-runtime` fails `pnpm lint`.

## Boundaries

### Thin-main checklist

| Check                                                                                                  | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No chat-engine / research-engine / ChatController / dashboard / research-tools implementations in main | ✅     | `rg "class ChatController\|function createDashboardService\|function createResearchToolsService\|function createAppChatEngines\|function createChatEngineSelector\|function researchTaskModelsFor\|function createChatWebSearch" apps/desktop/src` returns no matches. The definitions live in `packages/agent-host/src/{chat-controller,chat-engine,research-engine,dashboard,research-tools}.ts`.                                    |
| `createAgentHost` is the agent composition entry                                                       | ✅     | In production `src/main`, `apps/desktop/src/main/index.ts:109` (`createAgentHost({...})`) is the only call that builds the agent graph. `createAgentRuntime`, `createToolRegistry` and `createSourceStore` appear in non-`*.test.ts` main files only in `lifecycle/test-fixtures.ts`, the child entry of `process-crash.test.ts`. The security guards treat that file as test code, and `smoke-packaged` checks that it isn't shipped. |
| Host has zero `electron` imports                                                                       | ✅     | `rg "from 'electron'\|require\('electron'\)" packages/` returns no matches. ESLint bans `electron` in `packages/*/src` (probe: `packages/agent-host/src/x.ts` importing `electron` is BLOCKED).                                                                                                                                                                                                                                        |
| agent-runtime ╳ adk-runtime still holds                                                                | ✅     | `rg "@rka/(adk-runtime\|agent-host)" packages/agent-runtime/{src,package.json}` and `rg "@rka/(agent-runtime\|agent-host)" packages/adk-runtime/{src,package.json}` return no matches. ESLint probes: agent-runtime → adk-runtime, agent-runtime → agent-host and adk-runtime → agent-host are all BLOCKED.                                                                                                                            |
| Renderer/preload → `@rka/shared` only                                                                  | ✅     | The only `@rka/*` import in `apps/desktop/src/{renderer,preload}` is `@rka/shared`. ESLint probes: renderer → `@rka/agent-host` and preload → `@rka/agent-host` are BLOCKED.                                                                                                                                                                                                                                                           |

### ESLint probes

Each probe passed one import line to `eslint --stdin --stdin-filename <path>`, so no probe
file was written.

| Virtual file                         | Import                                          | Result  |
| ------------------------------------ | ----------------------------------------------- | ------- |
| `apps/desktop/src/main/ipc.ts`       | `@rka/adk-runtime`                              | BLOCKED |
| `apps/desktop/src/main/adk-probe.ts` | `@rka/adk-runtime`                              | allowed |
| `apps/desktop/src/main/x.test.ts`    | `@rka/adk-runtime`                              | allowed |
| `apps/desktop/src/main/ipc.ts`       | `../renderer/x`                                 | BLOCKED |
| `apps/desktop/src/main/adk-probe.ts` | `../preload/x` (cross-folder ban still applies) | BLOCKED |
| `apps/desktop/src/renderer/x.ts`     | `@rka/agent-host`                               | BLOCKED |
| `apps/desktop/src/preload/x.ts`      | `@rka/agent-host`                               | BLOCKED |
| `packages/agent-host/src/x.ts`       | `electron`                                      | BLOCKED |
| `packages/agent-runtime/src/x.ts`    | `@rka/adk-runtime`                              | BLOCKED |
| `packages/agent-runtime/src/x.ts`    | `@rka/agent-host`                               | BLOCKED |
| `packages/adk-runtime/src/x.ts`      | `@rka/agent-host`                               | BLOCKED |

### Audit of `apps/desktop/src/main` (production files)

| Files                                                                                                     | Role                                                                                                               | Leftover? |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------- |
| `index.ts`                                                                                                | Bootstrap: storage, config, provider, web services, ports, `createAgentHost`, Settings, IPC, session, menu, window | No        |
| `host-ports.ts`, `backup-dialog.ts`                                                                       | Electron `HostPorts` implementation                                                                                | No        |
| `ipc.ts`, `security.ts`, `window.ts`, `log.ts`, `env.ts`, `startup.ts`                                    | Shell and trust boundary                                                                                           | No        |
| `app-storage.ts`                                                                                          | `safeStorage`, `userData`, `chatUsageRecorder` (kept in desktop by the Phase 4 decision)                           | No        |
| `config/runtime-config.ts`, `config/services.ts`, `config/settings-service.ts`, `config/env-overrides.ts` | `RuntimeConfig` and `SettingsService` (moving them is out of scope)                                                | No        |
| `adk-probe.ts`                                                                                            | ADK startup self-check (documented and enforced exception)                                                         | No        |

The Electron-agnostic code that remains in desktop is settings and config. The plan's §9
lists moving it as future work.

## Checks run

- `pnpm check`: **pass**. It runs `typecheck`, `lint`, `format:check`, `test` and `build`.
  - `pnpm typecheck`: pass
  - `pnpm lint`: pass (0 warnings)
  - `pnpm format:check`: **pass**. The plan file was formatted in this phase.
  - `pnpm test`: pass, 88 files / 1176 tests (unchanged from Phase 4)
  - `pnpm build`: pass

## Behaviour

- Intentional behaviour changes: **none**. The diff touches only lint configuration,
  JSDoc and documentation.

## Risks / decisions

- **Process separation is NOT done; it was out of scope.** Agents, Ollama calls, tools
  and SQLite all run in the Electron main process, so a hang or crash in agent code still
  affects the shell. `@rka/agent-host` is Electron-agnostic and has a port-shaped
  boundary, which is a prerequisite for a later `utilityProcess`. That would still need a
  real host↔shell protocol, async ports and a security-policy review (the plan's §9).
- **Remaining `HostPorts` members that the host does not consume** are documented, not
  removed:
  - `emitSettingsChanged` and `chooseFolder` are used by desktop Settings through the same
    Electron ports object;
  - `HostSecretsPort` has no consumer.

  Removing them would be a contract change with no behaviour gain. A future
  process split should decide whether secrets cross that boundary.

- **The ESLint exception list is path-based.** If `adk-probe.ts` is renamed, the exception
  has to follow it, otherwise lint fails, which is the safe direction. `src/bench/runner.ts`
  (a dev benchmark outside `src/main`) still imports `@rka/adk-runtime` directly and is not
  covered by the new rule.
- **Some test graphs are still built by hand.** These are `ipc.test.ts`, the
  chat/research integration tests and `lifecycle/test-fixtures.ts`. They need fakes that
  `createAgentHost` deliberately doesn't accept (Phase 4 report). The `createAgentHost`
  wiring is covered by `packages/agent-host/src/agent-host.test.ts`. If the host wiring
  changes, these hand-built test graphs can drift from production.
- **Stale comment, not changed.** The comment in `adk-probe.ts` still says "No chat or
  research code uses ADK yet". That predates the ADK engines and is not part of this
  separation, so per the no-drive-by rule it was left alone.
- **From now on, new agent composition code belongs in `@rka/agent-host`** (the plan's §8).
