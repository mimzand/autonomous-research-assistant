# Agent Host Separation — Phase 3 Report

## Summary

- Status: **complete**
- The Dashboard and Research Tools service cores now live in `@rka/agent-host` and are
  exported from its entry. Their OS capabilities (`chooseBackupPath`, `chooseFile`,
  `openExternal`) are typed directly from the Phase 0 `HostPorts` contract via `Pick<…>`,
  so the service deps and the port contract can no longer drift apart. Electron dialog and
  shell implementations stay in `apps/desktop/src/main/index.ts`, unchanged; `index.ts`
  supplies them and constructs the services through the host factories. No IPC contract,
  renderer or `@rka/shared` change; service logic unchanged.

## Changes

- Moved (`git mv`; logic unchanged)
  - `apps/desktop/src/main/dashboard.ts` → `packages/agent-host/src/dashboard.ts`
    - `DashboardDeps` now `extends Pick<HostDialogPort, 'chooseBackupPath'>` (the
      overwrite-confirmation requirement moved to the interface's JSDoc).
    - `researchTaskInfo` imported from `./research-engine.js` (was `@rka/agent-host`).
  - `apps/desktop/src/main/research-tools.ts` → `packages/agent-host/src/research-tools.ts`
    - `ResearchToolsDeps` now
      `extends Pick<HostDialogPort, 'chooseFile'>, Pick<HostShellPort, 'openExternal'>`.
  - `apps/desktop/src/main/research-tools.test.ts` → `packages/agent-host/src/research-tools.test.ts`
    (service suite with a local fake web/SearXNG server, fake DNS and fake ports; its
    `IPC` block moved to desktop, see below).
- Modified — host
  - `packages/agent-host/src/ports.ts` — members changed from method syntax to `readonly`
    function properties (same names, parameter and return types, JSDoc). See Risks.
  - `packages/agent-host/src/index.ts` — new exports below.
- Modified — desktop
  - `src/main/index.ts` — imports `createDashboardService` / `createResearchToolsService`
    from the host. The inline Electron port implementations (save/open dialogs,
    `isSafeExternalUrl` + `shell.openExternal`) are unchanged.
  - `src/main/ipc.ts` — `DashboardService` / `ResearchToolsService` types from the host.
  - `src/main/ipc.test.ts` — host imports; new `research tools IPC` block with the two
    IPC cases from the old `research-tools.test.ts` (fixed channel set; validated results,
    bad payloads and untrusted senders rejected).
  - `src/main/research-engine.integration.test.ts` — `createDashboardService` from the host.
  - `src/main/security-guards.test.ts` — two allow-list entries
    `apps/desktop/src/main/research-tools.ts` → `packages/agent-host/src/research-tools.ts`.
- Docs: `README.md` Dashboard flow reads `DashboardService (@rka/agent-host, in main)`.
- No dependency or lockfile changes.

### Public API of `@rka/agent-host` (added / changed this phase)

| Module              | Exports                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dashboard.ts`      | `createDashboardService`, types `DashboardDeps`, `DashboardService`                                                          |
| `research-tools.ts` | `createResearchToolsService`, `PLAYGROUND_TASK_KIND`, `MAX_DISPLAY_CHARS`, types `ResearchToolsDeps`, `ResearchToolsService` |
| `ports.ts`          | Same five interfaces; members are now `readonly` function properties                                                         |

## Boundaries

- **electron imports in host?** None. `dialog.` / `shell.` appear only in `ports.ts` JSDoc.
  `research-tools.ts` uses `node:fs/promises` (`open`, to read a user-chosen file into
  memory), `node:crypto` and `node:path`, as before; packages may use Node built-ins.
- **agent-runtime ↔ adk-runtime?** Still disconnected; neither changed.
- **renderer/preload still shared-only?** Yes; untouched.
- **Ports:** dialogs and shell are only reachable through the injected functions.
  Implementations stay Electron-side in `index.ts` (`backupDialogOptions` + `showSaveDialog`,
  `showOpenDialog` with the PDF/DOCX filter, `isSafeExternalUrl` + `shell.openExternal`).
- **Security guards** still allow exactly the same set of files for
  `registry.execute(` and `openExternal(`; only the research-tools path changed.

### Security — no regression

- **File paths never cross IPC:** unchanged service code — `pickFile` returns a token,
  name and size; paths stay in the in-memory selection map with the 15-minute TTL. Host
  tests "extracts a user-selected PDF and DOCX without exposing the path" and "refuses
  unknown tokens (no arbitrary file reads)" pass.
- **Local extracts are not saved as sources:** unchanged; host test "does not save local
  files or unknown results" passes.
- **openExternal:** two layers kept — the service opens only public http(s) URLs it has seen
  in a search/fetch (`parsePublicUrl` + `openable` set), and the Electron adapter still
  rejects anything failing `isSafeExternalUrl` before `shell.openExternal`.
- **SSRF:** unchanged fetcher; host test "rejects invalid and non-public URLs" passes, and the
  new desktop IPC case checks that a loopback fetch returns a validated `blocked-url` result.
- **Backup overwrite confirmation:** still owned by the injected chooser (Electron
  `showSaveDialog`, which confirms overwrites on Windows); documented on `DashboardDeps` and
  on `HostDialogPort.chooseBackupPath`.

## Checks run

- `pnpm typecheck`: **pass**
- `pnpm lint`: **pass** (0 warnings)
- `pnpm test`: **pass** — 87 files / 1170 tests (unchanged totals: the research-tools suite
  moved to the host and its two IPC cases moved into `ipc.test.ts`). The `agent-host`
  project now runs 6 files / 60 tests (was 5 / 42).
- `pnpm build`: **pass**
- `pnpm format:check`: only `docs/agent-host-separation-plan.md` is flagged (pre-existing,
  untouched); every file changed here is Prettier-clean.

## Behaviour

- Intentional behaviour changes: **none**. Zod parsing of every request and validation of
  every response are in the unchanged service code; `registerIpcHandlers` routes are
  unchanged.
- Test coverage note: the old IPC case fetched a real page through IPC from the local fake
  web server. `ipc.test.ts` has no such server, so the desktop case now checks a fetch that
  is refused locally (still a validated response through IPC). The successful
  fetch/extraction path is covered at service level by the host suite, and the IPC layer
  is a pass-through `guard(handler(payload))` for every route.
- Follow-ups / known gaps for later phases:
  - Phase 4: build one `HostPorts` object in `index.ts` from Electron (`BrowserWindow`,
    `dialog`, `shell`, `safeStorage`) and pass it to `createAgentHost`, instead of inline
    lambdas per service. `chooseFolder` (SettingsService) stays desktop-side as the
    SettingsService does.
  - `ipc.test.ts` and `research-engine.integration.test.ts` still compose the services by
    hand; they can use `createAgentHost` with fake ports once it exists.

## Risks / decisions

- **`HostPorts` members changed from methods to `readonly` function properties.** Names
  and signatures are identical; this makes `Pick<HostDialogPort, …>` interchangeable with
  the service deps the services destructure (`{ chooseBackupPath }`), avoids method
  bivariance, and matches how every other deps interface in the app is written. No
  implementation existed yet, so nothing else changed; the Phase 0 type tests still pass.
- **IPC tests for research tools now live in `ipc.test.ts`** (desktop owns IPC) instead of
  pulling the desktop IPC module into the host test.
- **Electron adapters left inline in `index.ts`** rather than moved into new adapter modules;
  the plan allowed either, and Phase 4 will reshape them into one `HostPorts` object anyway.
- `docs/security.md` cites `research-tools.ts` / `research-tools.test.ts` by bare file name;
  those are still correct and were not edited.
