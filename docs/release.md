# Building and releasing the Windows app

For maintainers. User-facing instructions are in [installation.md](installation.md), and
the security controls are described in [security.md](security.md).

## What a release contains

| Artifact (in `apps/desktop/release/`)                    | Notes                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Autonomous Research Assistant-<v>-win-x64-setup.exe`    | NSIS installer: per-user, no admin rights, choice of folder, shortcuts, keeps data on uninstall |
| `Autonomous Research Assistant-<v>-win-x64-portable.zip` | Same app without an installer                                                                   |
| `win-unpacked/`                                          | The app folder the two artifacts are made from (for quick tests)                                |

What is inside:

- The Electron 44 runtime.
- `resources/app.asar`, which holds the bundled main, preload and renderer code, and the
  agent service (`out/agent/main.js`, Phase 8). At startup the app runs the agent as an
  Electron utility process (a second process of the same exe, shown as "Research Agent"
  in Task Manager's details); it is the only process that opens the database.
- `resources/app.asar.unpacked/node_modules/better-sqlite3`, the only runtime dependency.
  It ships with its prebuilt `win32-x64` Node-API binary, which the agent's utility
  process loads (Node-API: the same binary works in Electron and plain Node), so no
  native rebuild, no separate Node.js binary and no C++ toolchain are needed.
- English Chromium resources only.

Ollama, the model and SearXNG are **not** bundled. They are separate programs the user
installs, and the app checks for them at startup.

## 1. Prepare

1. Start from a clean working tree on the commit to release, with `git status` showing
   nothing.
2. Set the version in `apps/desktop/package.json` (`"version"`), following semver. The
   installer upgrades in place only when the version increases.
3. Do **not** change `productName` or `appId` in `electron-builder.yml`. They decide the
   data folder (`%APPDATA%\Autonomous Research Assistant`) and the upgrade identity.
4. Update the README or docs if behaviour changed.

## 2. Verify

```powershell
pnpm install --frozen-lockfile
pnpm check            # typecheck, lint, format, all unit/integration tests, build
```

## 3. Package (on Windows)

```powershell
pnpm package:win
```

This runs `pnpm build` (`electron-vite build`, then `scripts/build-agent.mjs`, which bundles
`apps/agent` into `out/agent`) and then `electron-builder --win`:

- **First run:** it downloads the Electron Windows runtime, NSIS and 7-Zip into
  `%LOCALAPPDATA%\electron-builder\Cache`. Later runs work offline.
- **Fuses:** it flips the Electron fuses and writes the asar integrity hash into the exe.
- **Exe metadata:** it sets the exe's name and version (rcedit).

On Linux or macOS, `pnpm package:dir` builds an unpacked app for the host OS. The
Windows **zip** can also be built there with
`electron-builder --win zip -c.win.signAndEditExecutable=false`. The **installer** and the
exe metadata step need Windows, or Wine.

Verify the built exe and installer (read-only; nothing is run, changed or installed):

```powershell
pnpm verify:win-build                  # defaults to apps/desktop/release
```

`@electron/fuses` is only a transitive dependency of electron-builder, so pnpm links no
`electron-fuses` command and `npx @electron/fuses read …` does not work in this
repository. `scripts/verify-windows-build.mjs` reads the fuse wire from the exe itself
and cross-checks it with `getCurrentFuseWire()` of the copy electron-builder already
uses (no download, no new dependency). It also checks:

- the exe is x64 and its version info names the product;
- the embedded ASAR integrity resource (`INTEGRITY/ELECTRONASAR`) exists and its SHA-256
  equals the hash of the `resources\app.asar` header;
- the setup exe and portable zip exist and are non-empty, and prints their SHA-256;
- the installer embeds one 7z payload. **If 7-Zip is installed**, every file in that
  payload is compared (size and CRC32) with `win-unpacked`, without extracting anything;
  otherwise this check is reported as SKIP.

Expected fuses (from `electronFuses` in `apps/desktop/electron-builder.yml`):

| Fuse                                    | Expected | Why                                                  |
| --------------------------------------- | -------- | ---------------------------------------------------- |
| `RunAsNode`                             | Disabled | `ELECTRON_RUN_AS_NODE` cannot turn the exe into Node |
| `EnableNodeOptionsEnvironmentVariable`  | Disabled | `NODE_OPTIONS` is ignored                            |
| `EnableNodeCliInspectArguments`         | Disabled | `--inspect` is ignored                               |
| `EnableEmbeddedAsarIntegrityValidation` | Enabled  | a modified `app.asar` is refused                     |
| `OnlyLoadAppFromAsar`                   | Enabled  | no `resources/app` folder is loaded                  |
| `EnableCookieEncryption`                | Enabled  | cookies encrypted at rest (DPAPI)                    |
| `LoadBrowserProcessSpecificV8Snapshot`  | Disabled | not used                                             |
| `GrantFileProtocolExtraPrivileges`      | Enabled  | accepted risk: the renderer is loaded from `file://` |
| `WasmTrapHandlers`                      | Enabled  | not configured; Electron default                     |

Do not infer fuse values from the electron-builder log, and never disable a fuse or edit
the installer to make this check pass.

## 4. Test the packaged app

Automated: `pnpm smoke:packaged` starts the **packaged executable** (not the dev server)
with a temporary user-data folder (`--user-data-dir`) and a fake Ollama and SearXNG on
127.0.0.1. It drives the real preload API over the Chromium DevTools protocol; the fuses
disable Node's `--inspect`, not `--remote-debugging-port`. It never touches the real
profile, contacts no real Ollama or website, and runs no model.

```powershell
pnpm package:win                       # or pnpm package:dir (unpacked app only)
pnpm smoke:packaged                    # defaults to apps/desktop/release/win-unpacked
```

| Checks (66)                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package: asar layout; no sources, maps, tests, `.env` or bench; one runtime dependency; only `better-sqlite3` unpacked, with this OS's binary only; agent bundle present with ADK; Electron main bundle without agent host, SQLite or ADK; production CSP; no credentials, keys or tunnel endpoints (19)                                                                                               |
| Security at run time: `ELECTRON_RUN_AS_NODE` and `--inspect` ignored (fuses); `settings.env` ignores `NODE_OPTIONS`; no `require`/`process` in the page; frozen `window.api`; CSP blocks `fetch` and inline scripts; `window.open` denied; navigation blocked                                                                                                                                          |
| Agent service (Phase 8): started by the app (transport `service`, handshake + ping, protocol 2); a utility process of the app (Linux run); the agent opens SQLite in the user-data folder; token and paths not on the process command line; a forced kill of the app ends the agent; restart replaces the stale state file; a normal quit stops it with `system.shutdown` and removes the state file   |
| Behaviour: renderer from `file://…/app.asar`; SQLite in the user-data folder; Settings IPC, environment overrides, defaults; Legacy and ADK Chat; Research task with the ADK engine pinned; forced kill → recovered as interrupted; integrity check; cancel; quit and reopen; **no network request by Chromium itself** (net log of every run; e.g. no spell-check dictionary download)                |
| Web search in Chat (fake Ollama tool calls + fake SearXNG): off by default and the Chat request unchanged; when on, Legacy Chat runs `web_search` through the ToolGateway (only tool declared, fenced untrusted result, refused `fetch_source`, streamed answer, timeline events, Stop during a search); ADK Chat uses the same gateway; Research never declares tools; the setting survives a restart |

A Windows package cross-built on Linux can only be checked statically:
`node apps/desktop/scripts/smoke-packaged.mjs apps/desktop/release/win-unpacked --target=win32-x64 --static-only`.
Research, recovery and the Legacy/ADK engines are tested in depth by the in-process and
real-process suites (`pnpm test`, including `src/main/lifecycle/process-crash.test.ts`).

**Manual, on Windows**, using the Windows checklist below. It must be done on a real
Windows 10 or 11 machine, ideally a fresh Windows user account.

## 5. Publish

1. Tag the release commit: `git tag v<version>`.
2. Compute checksums and publish them with the files:

   ```powershell
   Get-FileHash "release\*.exe","release\*.zip" -Algorithm SHA256
   ```

   `pnpm verify:win-build` prints the same SHA-256 values.

3. Attach the setup exe, the portable zip and the checksums to the release.
4. In the release notes, link [installation.md](installation.md#7-update) for the update
   steps.

## Code signing (not configured)

Releases are unsigned, so SmartScreen warns on first start. To sign later:

1. Obtain a code-signing certificate.
2. Provide it to electron-builder with the `CSC_LINK` and `CSC_KEY_PASSWORD` environment
   variables **in the build environment only**. Never commit or log them.
3. Run `pnpm package:win`. `signAndEditExecutable: true` already enables signing when a
   certificate is present.

## Updates

There is no auto-updater. The app never contacts an update server.

- **Updating:** the user installs the newer setup over the old one. Data stays in
  `%APPDATA%`.
- **Database migrations:** they are additive and run automatically at startup. A
  migration must never drop user data, and an upgrade test is required for each new
  migration (see `packages/storage/src/migrations.test.ts`).

---

## Release checklist

Copy this list into the release issue and tick each item.

### Code and build

- [ ] Clean tree on the release commit; version bumped in `apps/desktop/package.json`
- [ ] `pnpm install --frozen-lockfile` succeeds with no unexpected build scripts
- [ ] `pnpm check` passes: typecheck, lint, format, all tests, build
- [ ] No new runtime dependency besides `better-sqlite3` (`dependencies` in `apps/desktop/package.json`)
- [ ] New migrations have an upgrade test and only add data structures
- [ ] `pnpm package:win` produces `…-setup.exe` and `…-portable.zip`
- [ ] `pnpm verify:win-build` passes: fuses, ASAR integrity, x64 identity, installer payload (section 3)
- [ ] `resources/app.asar.unpacked` contains only `better-sqlite3` with `win32-x64.node`; there is no `resources/app` folder

### Automated tests of the packaged app

- [ ] `pnpm smoke:packaged` on Windows (`release/win-unpacked`): all checks pass

### Windows: install

- [ ] The installer runs without an admin prompt, lets you choose the folder, and creates Start menu and desktop shortcuts
- [ ] SmartScreen "Run anyway" works for the unsigned build
- [ ] The app starts and the window title reads "Autonomous Research & Knowledge Assistant"
- [ ] `%APPDATA%\Autonomous Research Assistant\data\research.db` is created; nothing is written to the install folder
- [ ] While the app runs, `%APPDATA%\Autonomous Research Assistant\agent-state.json` exists and Task Manager → Details shows a second `Autonomous Research Assistant.exe` (the agent); after closing the app both are gone

### Windows: startup checks

- [ ] With Ollama stopped: banner "Ollama is not reachable at http://127.0.0.1:11434"
- [ ] With Ollama running and the model missing (temporarily set `OLLAMA_MODEL=not-installed:1b` in `settings.env`): banner with `ollama pull not-installed:1b`, and nothing is downloaded (`ollama list` is unchanged)
- [ ] Without `SEARXNG_URL`: banner "Web search is not configured"; after adding it to `settings.env` and restarting, the banner is gone
- [ ] Clicking "Check again" after starting Ollama clears the banner

### Windows: functionality

- [ ] Chat answers with qwen3:8b
- [ ] A research task completes with a cited report (default limits); the duration is noted
- [ ] Pause and Resume work, Stop works, and closing the app mid-task gives "Interrupted — the app was closed" and Resume works
- [ ] Storage → Export backup… saves a backup where you choose
- [ ] Report source links open in the default browser

### Windows: hardening

- [ ] No menu bar; Ctrl+Shift+I and F12 do nothing; Ctrl+R does not reload
- [ ] `set ELECTRON_RUN_AS_NODE=1` then starting the exe from `cmd` opens the app (not a Node.js prompt)
- [ ] Starting the exe with `--inspect=9229` does not open port 9229 (`netstat -ano | findstr 9229`)
- [ ] Ending the app with Task Manager (End task on the main process) also ends the agent process; the next start works and recovers interrupted tasks
- [ ] `netstat -ano | findstr LISTENING` shows the agent's port on `127.0.0.1` only (never `0.0.0.0`)
- [ ] Task execution log entries contain no Windows user name (`C:\Users\[user]\…`) and no tokens

### Windows: update and uninstall

- [ ] Installing the next version over this one keeps all tasks and reports; migrations run once
- [ ] Uninstalling removes the program and shortcuts and keeps `%APPDATA%\Autonomous Research Assistant`
- [ ] The portable zip (after **Unblock**) runs from any folder and uses the same data folder

### Publish

- [ ] SHA-256 checksums published with the artifacts
- [ ] Release notes link the installation and update guide, and list known issues: unsigned build, `GrantFileProtocolExtraPrivileges` accepted risk
