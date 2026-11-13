# Phase 7.7 — Windows packaging & installer acceptance

Built and tested with fakes only: no Ollama inference, no GPU work, no company endpoint,
no real user profile, and nothing installed on the developer machine.

## 1. Packaging architecture (audit)

| Area             | Finding                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework        | **electron-builder 26.18** (`apps/desktop/electron-builder.yml`) on top of **electron-vite 6** builds. It already existed and was kept; no new framework.                                                                                                                                  |
| Commands         | `pnpm package:win` (NSIS installer + portable zip, x64), `pnpm package:dir` (unpacked app for the host OS). Both run `electron-vite build` first.                                                                                                                                          |
| Bundling         | Main, preload and renderer are bundled into `out/`, including all workspace packages, Vue, Zod, Drizzle and **Google ADK** (lazy `out/main/chunks/engine-*.js`, loaded by `loadAdkRuntime()` from inside the asar). The only runtime dependency in `package.json` is `better-sqlite3`.     |
| Native SQLite    | `better-sqlite3` 13.0.3 ships **prebuilt Node-API binaries** (`prebuilds/<os>-<arch>.node`, loaded by `lib/<os>-<arch>.js`). Node-API is ABI-stable, so no rebuild for Electron is needed (`npmRebuild: false`; no C++ toolchain). The binaries are unpacked from the asar (`asarUnpack`). |
| asar & fuses     | `asar: true`. Fuses: RunAsNode, `NODE_OPTIONS` and `--inspect` off; embedded asar integrity, OnlyLoadAppFromAsar and cookie encryption on.                                                                                                                                                 |
| Identity         | `appId com.rka.autonomous-research-assistant`, `productName` "Autonomous Research Assistant" (the user-data folder `%APPDATA%\Autonomous Research Assistant` comes from it), Windows exe "Autonomous Research Assistant.exe". **Unchanged.**                                               |
| Installer        | NSIS, per-user (`%LOCALAPPDATA%\Programs\…`), `perMachine: false`, `allowElevation: false`, `requestedExecutionLevel: asInvoker` (no admin rights), choice of folder, shortcuts, `deleteAppDataOnUninstall: false`, `publish: null` (no auto-update).                                      |
| Production paths | Renderer loaded with `loadFile` from the asar; the dev-server URL is used only when `!app.isPackaged`. The database is at `<userData>/data/research.db`; settings are in SQLite plus optional `<userData>/settings.env`. `.env` files are read only when not packaged.                     |
| Code signing     | Not configured: unsigned builds, so SmartScreen warns. Never bypassed.                                                                                                                                                                                                                     |

## 2–3. Confirmed packaging defects, root causes and fixes

**P1 — the app's sources, tests and configs shipped inside `app.asar` (fixed).**

- **What:** the package held 159 unintended files (about 5.5 MB): `src/main/**`,
  `src/renderer/**`, `src/bench/**`, test files and lifecycle test fixtures,
  `electron.vite.config.ts`, `tsconfig*.json`, `vitest*.config.ts` and
  `node_modules/node-addon-api`. This contradicted the config's own comment ("Only the
  compiled app goes into app.asar").
- **Cause:** `win.files` and `linux.files` contained **only `!` exclusion patterns**. For
  such a list electron-builder prepends its default `**/*`, which re-includes the whole app
  folder.
- **Fix:** both platform lists now repeat the includes (`out/**/*`, `package.json`) before
  the exclusions. `node-addon-api` (build-time C++ headers, never loaded at run time) is
  excluded. `app.asar` went from 7.8 MB to 6.7 MB.
- **Test:** `security-guards.test.ts` fails on the old config; `smoke:packaged` checks the
  asar contents.

**P2 — Chromium downloaded spell-check dictionaries from Google at every start (fixed).**

- **What:** Chromium's net log showed `GET https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic`
  at every start, even though the windows set `spellcheck: false`. This was a hidden
  runtime download to a third party. It was found because the sandbox proxy refused the
  connection.
- **Cause:** the _session_ spellchecker initialises its languages and downloads Hunspell
  dictionaries independently of the per-window flag. A minimal Electron 44 experiment
  showed `setSpellCheckerEnabled(false)` alone does **not** stop the download, while an
  empty language list does.
- **Fix:** in `main/index.ts`, next to the existing session hardening,
  `setSpellCheckerEnabled(false)` and `setSpellCheckerLanguages([])`. Spell-check
  underlining in text fields was already off.
- **Test:** the net log of every smoke run must contain no external host. Negative
  control: without the fix the check fails and names `redirector.gvt1.com`. A guard test
  pins both calls.
- **Windows:** Chromium may use the OS spellchecker there; the fix is platform-independent.

**P3 — release and security docs referenced packaged test suites that don't exist (fixed).**

- **What:** `release.md` and `security.md` cited `e2e-packaged` (17 checks), `e2e-agent`,
  `e2e-reliability`, `e2e-chat` and `e2e-settings` as proof of several controls. None of
  them is in the repository, so the release checklist could not be followed.
- **Fix:** a committed, dependency-free `pnpm smoke:packaged` (§9) now checks those controls
  on the packaged executable, and the docs reference it.

Not defects (confirmed by evidence): the native SQLite binary loads in the packaged app;
ADK loads from the asar; no rebuild is needed; the identity and data location are correct;
the installer settings preserve data.

## 4. Files changed

| File                                            | Change                                                                                                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/electron-builder.yml`             | P1: explicit includes in `win.files` and `linux.files`; exclude `node-addon-api`.                                                                                                                                                                   |
| `apps/desktop/src/main/index.ts`                | P2: session spellchecker off, with no languages.                                                                                                                                                                                                    |
| `apps/desktop/scripts/smoke-packaged.mjs` (new) | Packaged-app acceptance test (§9).                                                                                                                                                                                                                  |
| `apps/desktop/package.json`, `package.json`     | `smoke:packaged` script.                                                                                                                                                                                                                            |
| `apps/desktop/src/main/security-guards.test.ts` | +6 tests: `files` lists must include the build, identity, installer settings (per-user, x64, no elevation, keeps data, no auto-update, no signing secrets), the single unpacked dependency, the spellchecker settings, production renderer loading. |
| `docs/release.md`, `docs/security.md`           | P3; new "no background downloads" control.                                                                                                                                                                                                          |

No dependency was added or upgraded and the lockfile is unchanged. Unchanged: app ID,
product name, executable name, data location, engines, pinning, transport, auth and ngrok
rules.

## 5. Native SQLite

- The packaged app loads `prebuilds/linux-x64.node` from `app.asar.unpacked` (tested at run
  time). The Windows package contains `prebuilds/win32-x64.node`, with no Linux or macOS
  binaries (static check of the cross-built package).
- At run time: the database is created at `<userData>/data/research.db`, migrations run,
  and reads and writes work. WAL files `research.db-wal` and `-shm` sit next to it.
  `PRAGMA integrity_check` is `ok` after a forced kill, and the database reopens after a
  normal quit. Nothing is written inside the app folder or the asar.
- Minor: the Windows x64 package also carries `win32-arm64.node` (about 1.9 MB, unused).
  Left as is.

## 6. Google ADK in the packaged runtime

ADK is bundled into a lazy chunk inside the asar.

- **Legacy and ADK Chat:** both streamed a reply through the packaged app (the main
  process logged "Chat engine: adk").
- **Research:** a task created with the Research engine set to ADK ran its first model call
  with `research.engine = adk` pinned. After a forced kill and restart it still showed
  `adk`.
- **No new capabilities:** no ADK tools, code execution or persistent sessions were added;
  the existing guards still apply.

## 7. Security and production paths (verified on the packaged executable)

| Check                   | How it was verified                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No dev server           | Renderer loaded from `file://…/app.asar/out/renderer/index.html`.                                                                                                                                                  |
| Isolation               | No `require`, `process` or `module` in the page; `window.api` frozen.                                                                                                                                              |
| Content Security Policy | `fetch` from the renderer is blocked, and inline scripts don't run.                                                                                                                                                |
| Navigation              | `window.open` is denied; navigation away is blocked, with local probe URLs so a broken lock would show in the fake server's log and never reach the internet.                                                      |
| Fuses                   | Starting with `ELECTRON_RUN_AS_NODE=1` and `--inspect` still starts the GUI app, and no debugger listens.                                                                                                          |
| `settings.env`          | `NODE_OPTIONS` and unknown keys are ignored and reported.                                                                                                                                                          |
| Ollama                  | Only `/api/version`, `/api/tags`, `/api/show` and `/api/chat` are called; never pull, create or delete.                                                                                                            |
| No hidden network (P2)  | Chromium makes no request at all.                                                                                                                                                                                  |
| Debugging port          | `--remote-debugging-port` (used by the test) is a Chromium switch the fuses don't cover. Anyone able to pass command-line switches to the user's process already has the user's privileges. Documented, unchanged. |

## 8. User-data preservation

- **Locations:** program files in `%LOCALAPPDATA%\Programs\Autonomous Research Assistant`
  (per user); data in `%APPDATA%\Autonomous Research Assistant`. They are separate folders.
- **Uninstall** keeps the data (`deleteAppDataOnUninstall: false`, pinned by a test).
- **Update or reinstall:** the same `appId` and `productName` mean the same data folder.
  Migrations are additive and tested (`migrations.test.ts`); there is no reset path.
- **Restarts:** the smoke test confirms tasks, recovery state, pins and saved Settings
  survive three restarts, including a forced kill.
- **Note (unchanged behaviour):** `pnpm dev` and the installed app use the **same**
  `%APPDATA%` folder, because the product name is the same. A dev build therefore migrates
  the database the installed app uses.

## 9. Commands

On Windows:

```powershell
pnpm install --frozen-lockfile
pnpm check                      # typecheck, lint, format, tests, build
pnpm package:win                # → apps\desktop\release\
pnpm smoke:packaged             # packaged-app acceptance against release\win-unpacked
cd apps\desktop; npx @electron/fuses read --app "release/win-unpacked/Autonomous Research Assistant.exe"
```

- **Build-time downloads (normal, first run only):** the Electron runtime, NSIS and 7-Zip,
  cached in `%LOCALAPPDATA%\electron-builder\Cache`.
- **Runtime downloads:** none (P2 fix).
- **Native rebuild:** none.
- **External tools:** none beyond Node 22 and pnpm. Building the Windows installer on Linux
  or macOS needs Wine.

## 10. Artifacts here (Linux sandbox)

| Artifact                     | Size                                             | Notes                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release/linux-unpacked/`    | 286 MB (app.asar 6.7 MB, unpacked SQLite 4.1 MB) | Built with `pnpm package:dir`; launched and tested (46/46).                                                                                                                                                                   |
| `release/win-unpacked/`      | 330 MB (app.asar 6.7 MB, unpacked SQLite 3.7 MB) | Cross-built for a **layout check only** (`-c.win.signAndEditExecutable=false`). Static checks 17/17. **Not distributable:** without rcedit the exe lacks the embedded asar-integrity resource that the enabled fuse requires. |
| `…-win-x64-portable.zip`     | 144 MB                                           | Cross-built for the layout check only; not distributable.                                                                                                                                                                     |
| `…-win-x64-setup.exe` (NSIS) | —                                                | **Not built:** NSIS on Linux needs Wine (`spawn wine ENOENT`). The incomplete 190 KB stub was deleted.                                                                                                                        |

## 11. Automated results

| Check                                            | Result                                           |
| ------------------------------------------------ | ------------------------------------------------ |
| `pnpm format` / `format:check`                   | pass                                             |
| `pnpm typecheck`                                 | pass                                             |
| `pnpm lint`                                      | pass                                             |
| `pnpm test`                                      | 81 files, **1,109 tests passed** (was 1,103; +6) |
| `pnpm build`                                     | pass                                             |
| `pnpm package:dir`                               | pass (about 10 s)                                |
| `pnpm smoke:packaged` (Linux packaged app, Xvfb) | **46/46**, three consecutive runs                |
| Static check of the cross-built Windows package  | 17/17                                            |

## 12. Status

- **Automated verification passed:** everything in §11.
- **Packaged executable launched successfully:** yes, the **Linux** build of the same
  configuration, headless, 46 checks.
- **Installer manually verified:** **no.** The NSIS installer must be built and tested on
  Windows.
- **Not yet verified:**
  - `pnpm package:win` and `pnpm smoke:packaged` on Windows
  - installing, starting from the installed location, restart, uninstall keeping data,
    reinstall or upgrade
  - the fuse readout of the Windows exe
  - the SmartScreen prompt
  - Remote Ollama from the installed app (verified only through existing unit and
    integration tests, with fakes)

## 13. Remaining risks

- Unsigned: SmartScreen and "unknown publisher" warnings; users must choose "Run anyway".
  Signing needs a certificate (see `release.md`).
- The Windows-specific steps (rcedit, asar integrity, NSIS) have not run yet. The
  authoritative build is `pnpm package:win` on Windows.
- The dev build and the installed app share one data folder (§8).
- The `win32-arm64` binary ships unused (about 1.9 MB).
- On Windows, the smoke test reads the DevTools port from stderr or from the profile's
  `DevToolsActivePort` file; this hasn't run on Windows yet.

## 14. Manual Windows installation checklist

1. `pnpm package:win`, then `pnpm smoke:packaged`. Expect all checks to pass. Read the
   fuses; expect the values in `release.md` §3.
2. **Install:** run `release\Autonomous Research Assistant-0.1.0-win-x64-setup.exe`. Expect
   no admin prompt. SmartScreen asks once ("More info → Run anyway"); don't disable
   SmartScreen. For a disposable test, choose a test folder or use a separate Windows user
   account.
3. **Start:** launch from the Start menu. The app opens. Settings shows your saved server,
   model and engines. Task history and reports are present.
4. **Restart:** close and reopen. Data is still there.
5. **Uninstall:** use Windows Settings → Apps. `%APPDATA%\Autonomous Research Assistant\data\research.db`
   still exists.
6. **Reinstall:** run the installer again. The app shows the same tasks, reports and
   Settings.
7. **Optional, only with approval:** one short Remote Ollama chat from the installed app.

## 15. Windows run (developer machine)

`pnpm check; pnpm package:win; pnpm smoke:packaged` on Windows 11 (build 26300):

- **`pnpm check`:** pass. 81 files, **1,109 tests**, including the 12 real-process crash
  tests.
- **`pnpm package:win`:**
  - built `release\Autonomous Research Assistant-0.1.0-win-x64-setup.exe` (NSIS, x64,
    per-user) and the portable zip
  - updated the asar-integrity resource in the exe and applied the fuses
  - no native rebuild
  - signing skipped, since no certificate is configured
  - the default Electron icon is used (no app icon is configured)
- **`pnpm smoke:packaged`:** 44 of 46 on the first run. Everything else passed on Windows:
  the win32-x64 SQLite binary loaded, ADK Chat and Research ran, recovery after a forced
  kill worked, and Chromium made no network request.
  - **The two failures were one test defect, not an app defect.** The `window.open` probe
    used an http URL. The app denies every new window and, **by design**, hands http(s)
    links to the system browser (`shell.openExternal`, used for report links). On Windows
    the default browser opened the probe URL and requested `/popup` and `/favicon.ico`
    from the fake server, which failed the navigation check (it also looked for `/popup`)
    and the Ollama request-list check. The page itself stayed on `file://`. The Linux
    sandbox has no browser, so it didn't show there.
  - **Fix:** the probe now uses `file:///`, which is denied without opening a browser, and
    the navigation check looks only at its own probe. Re-run here: 46/46, twice.
- **Pending:** re-running `pnpm smoke:packaged` on Windows (no rebuild needed), and the
  manual installer checklist (§14).
