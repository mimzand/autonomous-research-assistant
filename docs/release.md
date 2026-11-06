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
- `resources/app.asar`, which holds the bundled main, preload and renderer code.
- `resources/app.asar.unpacked/node_modules/better-sqlite3`, the only runtime dependency.
  It ships with its prebuilt `win32-x64` Node-API binary, so no native rebuild or C++
  toolchain is needed.
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

This runs `electron-vite build` and then `electron-builder --win`:

- **First run:** it downloads the Electron Windows runtime, NSIS and 7-Zip into
  `%LOCALAPPDATA%\electron-builder\Cache`. Later runs work offline.
- **Fuses:** it flips the Electron fuses and writes the asar integrity hash into the exe.
- **Exe metadata:** it sets the exe's name and version (rcedit).

On Linux or macOS, `pnpm package:dir` builds an unpacked app for the host OS. The
Windows **zip** can also be built there with
`electron-builder --win zip -c.win.signAndEditExecutable=false`. The **installer** and the
exe metadata step need Windows, or Wine.

Check the fuses of the built exe:

```powershell
# npx fetches the @electron/fuses CLI (already a dependency of electron-builder) if needed.
cd apps/desktop
npx @electron/fuses read --app "release/win-unpacked/Autonomous Research Assistant.exe"
```

Expected:

- `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments`
  are **Disabled**.
- `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar` and
  `EnableCookieEncryption` are **Enabled**.

## 4. Test the packaged app

Automated, in CI or the cloud sandbox: the packaged Linux build of the same configuration
is driven over the DevTools protocol, because the fuses disable `--inspect`.

| Suite                                                                                                                                        | Checks |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `e2e-packaged`: release checks (startup checks, CSP, isolation, navigation lock, settings.env allow-list, fuses, data location, asar layout) | 17     |
| `e2e-agent` on the packaged app: full research run, pause/resume, cancel, restart                                                            | 27     |
| `e2e-reliability` on the packaged app: Ollama stops mid-run, malformed report then Retry, start refused                                      | 14     |
| `e2e-chat` on the packaged app                                                                                                               | 26     |

**Manual, on Windows**, using the Windows checklist below. It must be done on a real
Windows 10 or 11 machine, ideally a fresh Windows user account.

## 5. Publish

1. Tag the release commit: `git tag v<version>`.
2. Compute checksums and publish them with the files:

   ```powershell
   Get-FileHash "release\*.exe","release\*.zip" -Algorithm SHA256
   ```

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
- [ ] Fuses read as expected (section 3)
- [ ] `resources/app.asar.unpacked` contains only `better-sqlite3` with `win32-x64.node`; there is no `resources/app` folder

### Automated tests of the packaged app

- [ ] `e2e-packaged`: 17/17
- [ ] `e2e-agent`, `e2e-reliability` and `e2e-chat` against the packaged build all pass

### Windows: install

- [ ] The installer runs without an admin prompt, lets you choose the folder, and creates Start menu and desktop shortcuts
- [ ] SmartScreen "Run anyway" works for the unsigned build
- [ ] The app starts and the window title reads "Autonomous Research & Knowledge Assistant"
- [ ] `%APPDATA%\Autonomous Research Assistant\data\research.db` is created; nothing is written to the install folder

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
- [ ] Task execution log entries contain no Windows user name (`C:\Users\[user]\…`) and no tokens

### Windows: update and uninstall

- [ ] Installing the next version over this one keeps all tasks and reports; migrations run once
- [ ] Uninstalling removes the program and shortcuts and keeps `%APPDATA%\Autonomous Research Assistant`
- [ ] The portable zip (after **Unblock**) runs from any folder and uses the same data folder

### Publish

- [ ] SHA-256 checksums published with the artifacts
- [ ] Release notes link the installation and update guide, and list known issues: unsigned build, `GrantFileProtocolExtraPrivileges` accepted risk
