# Phase 7.7.1: Final Windows installer acceptance

Scope: diagnose the fuse-reading command, verify the Windows build read-only (fuses,
ASAR integrity, identity, checksums), and provide the manual installer checklist. No
application code, ADK, Research or UI changes. Nothing was installed, uninstalled, run
against the real profile, or sent to any model.

Build under test: the Phase 7.7 build in `apps/desktop/release/` on the developer
machine (repository commit `63be876`, Electron 44.10.1, electron-builder 26.18.0).

## 1. Root cause of the fuse CLI error

The command in `docs/release.md` was wrong. The package was there.

- `@electron/fuses` 1.8.0 is installed, but only **transitively**: electron-builder →
  app-builder-lib (`"@electron/fuses": "^1.8.0"`) → `@electron/fuses`.
- Its `bin` (`electron-fuses` → `dist/bin.js`, commands `read --app <exe>` and `write`)
  is linked only for packages that **depend on it directly**. pnpm links it into neither
  `apps/desktop/node_modules/.bin` nor the root `.bin`. So `npx @electron/fuses read …`
  finds no `electron-fuses` executable in the workspace, and Windows reports
  `'electron-fuses' is not recognized`.
- The doc comment said npx would "fetch" the CLI. That is not what happens here, and
  fetching a package at verify time would be an unpinned download anyway.

Fix: no new dependency and no npx. `apps/desktop/scripts/verify-windows-build.mjs`
reads the fuse wire from the exe (same algorithm and sentinel as `@electron/fuses`). It
then cross-checks the result with `getCurrentFuseWire()` from the copy electron-builder
already uses, resolved through `createRequire` (apps/desktop → electron-builder →
app-builder-lib). Command: `pnpm verify:win-build`.

## 2. Fuse values read from the Windows executable

Read from `release/win-unpacked/Autonomous Research Assistant.exe`. The fuse wire is
version 1 with 9 fuses. Raw states `30 31 30 30 31 31 30 31 31` (`0` = disabled, `1` =
enabled). `getCurrentFuseWire()` from @electron/fuses 1.8.0 returns the same values.

| #   | Fuse                                    | Actual   | `docs/release.md` / yml | Result |
| --- | --------------------------------------- | -------- | ----------------------- | ------ |
| 0   | `RunAsNode`                             | disabled | disabled                | ✅     |
| 1   | `EnableCookieEncryption`                | enabled  | enabled                 | ✅     |
| 2   | `EnableNodeOptionsEnvironmentVariable`  | disabled | disabled                | ✅     |
| 3   | `EnableNodeCliInspectArguments`         | disabled | disabled                | ✅     |
| 4   | `EnableEmbeddedAsarIntegrityValidation` | enabled  | enabled                 | ✅     |
| 5   | `OnlyLoadAppFromAsar`                   | enabled  | enabled                 | ✅     |
| 6   | `LoadBrowserProcessSpecificV8Snapshot`  | disabled | disabled                | ✅     |
| 7   | `GrantFileProtocolExtraPrivileges`      | enabled  | enabled (accepted risk) | ✅     |
| 8   | `WasmTrapHandlers`                      | enabled  | not set → default       | ✅     |

Fuse 8 (`WasmTrapHandlers`, which controls V8's WebAssembly out-of-bounds trap handlers)
is newer than @electron/fuses 1.8.0, so that package reports it unnamed. Our config
doesn't set it, so it keeps Electron's documented default (enabled). The values come
from the binary, not from electron-builder log lines. All six fuses the phase required
match. Since 7.7, the runtime smoke test has also shown `ELECTRON_RUN_AS_NODE`,
`--inspect` and `NODE_OPTIONS` being ignored.

## 3. Code and documentation changes

| File                                                                 | Change                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/scripts/verify-windows-build.mjs` (new)                | Read-only verifier: fuses (binary + @electron/fuses cross-check), PE machine and version info, ASAR integrity resource vs. `app.asar` header hash, installer/ZIP presence and SHA-256, one 7z payload in the installer, and optionally a payload-vs-`win-unpacked` comparison (7-Zip) |
| `apps/desktop/src/main/packaging/verify-windows-build.test.ts` (new) | 5 tests: the verifier's expected fuses equal `electronFuses` in `electron-builder.yml` (only `WasmTrapHandlers` unset); fuse-wire parsing incl. `removed`; one-sentinel rule; 7z header location with a multi-byte NUMBER; docs no longer give the npx command                        |
| `package.json`, `apps/desktop/package.json`                          | `verify:win-build` script                                                                                                                                                                                                                                                             |
| `docs/release.md`                                                    | §3: the invalid `npx @electron/fuses read` replaced by `pnpm verify:win-build`, why npx fails, what is checked, and a full expected-fuse table; checklist item updated; §5 notes the verifier prints the checksums                                                                    |

No change to `electron-builder.yml`, fuses, app ID, product name, exe name, user-data
path, installer options, or any runtime code. No dependency was added. 7-Zip was
installed **in the Linux sandbox only**, to cross-check the payload.

How the payload comparison stays read-only: the installer's 7z payload uses a compressed
("encoded") header. The verifier writes only the three header pieces, at their original
offsets, into a **sparse** temporary file (12 KB on disk). It lists that file with an
existing 7-Zip (`7z l`, never `x`) and compares each listed file's size and CRC32 with
`win-unpacked`. It extracts nothing, executes nothing, and deletes its own temporary
folder.

## 4. SHA-256 checksums

| Artifact                                                   | Bytes       | SHA-256                                                            |
| ---------------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `Autonomous Research Assistant-0.1.0-win-x64-setup.exe`    | 113,946,445 | `ad2b47538a2f9ee36118a47e29ff810ca93bc0d22b9457cc50ef5508964e3e08` |
| `Autonomous Research Assistant-0.1.0-win-x64-portable.zip` | 144,322,296 | `8a7963b495ca3ff8cbc897c7b8af8a1053a87b187e6979ad5bb89669a1c22ac0` |

Computed by the verifier on the developer machine's files (streaming SHA-256). They
should equal `Get-FileHash … -Algorithm SHA256` on Windows. These checksums identify
**this** build only; a rebuild changes them.

## 5. Installer integrity verification

| Check                                           | Result                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installer exists, non-empty                     | ✅ 113,946,445 bytes                                                                                                                                                                                                                                                |
| Installer identity                              | ✅ PE, NSIS (“Nullsoft” stub), ProductName `Autonomous Research Assistant`, version 0.1.0                                                                                                                                                                           |
| Installer stub architecture                     | i386. Expected: NSIS stubs are always 32-bit. The **payload** decides the app architecture (below)                                                                                                                                                                  |
| Build targets                                   | ✅ `builder-effective-config.yaml`: nsis `x64` and zip `x64` only                                                                                                                                                                                                   |
| Installer payload                               | ✅ exactly one 7z archive (LZMA2 + BCJ), 46 files                                                                                                                                                                                                                   |
| Payload == `win-unpacked`                       | ✅ **46/46 files identical by size and CRC32, no file in `win-unpacked` missing from the installer** (headers listed in the sandbox, files hashed on the developer machine). So the installed exe carries the same fuses and integrity resource as the verified one |
| App exe architecture                            | ✅ PE32+ x64 (machine `0x8664`)                                                                                                                                                                                                                                     |
| App exe identity                                | ✅ ProductName / InternalName / FileDescription `Autonomous Research Assistant`, FileVersion 0.1.0, CompanyName “Autonomous Research Assistant contributors”. `OriginalFilename` is empty (electron-builder leaves it blank; cosmetic)                              |
| ASAR integrity resource                         | ✅ PE resource `INTEGRITY/ELECTRONASAR`, JSON `[{file:"resources\\app.asar", alg:"SHA256", value:"4cacb48c38466167…"}]`                                                                                                                                             |
| Integrity value matches the packaged `app.asar` | ✅ equals the SHA-256 of the `app.asar` header (what Electron validates when `EnableEmbeddedAsarIntegrityValidation` is on)                                                                                                                                         |
| Portable ZIP                                    | ✅ valid ZIP, contains `Autonomous Research Assistant.exe`                                                                                                                                                                                                          |
| Signature                                       | Unsigned, as documented (SmartScreen warning expected)                                                                                                                                                                                                              |

Nothing was disabled or modified to make a check pass.

Observations (not defects, not changed in this phase):

- The x64 build also ships `better-sqlite3/prebuilds/win32-arm64.node` (1.9 MB, never
  loaded on x64). The `files` exclusion removes only the darwin/linux/linuxmusl
  prebuilds. Excluding `win32-arm64` too would trim size. That's a packaging change for a
  later phase.
- `resources/elevate.exe` is electron-builder's standard elevation helper. With a
  per-user install, `allowElevation: false` and `asInvoker`, it is not used.
- The installer's FileDescription is the package description ("Electron shell: …"),
  which is cosmetic.

## 6. Manual installation checklist (exact)

**Important: shared user data.** The development app and the installed app use the
same folder, `%APPDATA%\Autonomous Research Assistant` (DB
`…\data\research.db`). Do **not** run this checklist in your developer account, and do
not redirect or migrate that folder. Use a **separate, disposable standard
(non-admin) Windows user account**: it has its own `%APPDATA%` and
`%LOCALAPPDATA%`, so nothing here touches your developer installation or database.

### 6.0 Prepare (in the developer account)

1. Run `pnpm verify:win-build` and confirm `26/26` (or `27/27` with 7-Zip installed),
   with the SHA-256 values from section 4.
2. Create a local standard user, e.g. _Settings → Accounts → Other users → Add account →
   "I don't have this person's sign-in information" → "Add a user without a Microsoft
   account"_ (name e.g. `rka-test`, type **Standard user**).
3. Copy the setup exe and the portable zip to a folder that user can read (e.g.
   `C:\Users\Public\rka-test\`).

### 6.1 Install (signed in as `rka-test`)

| #   | Step                                              | Expected                                                                                                 |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | `Get-FileHash .\*.exe, .\*.zip -Algorithm SHA256` | Equals section 4                                                                                         |
| 2   | Double-click the setup exe                        | SmartScreen “Windows protected your PC” (unsigned) → **More info → Run anyway**                          |
| 3   | Go through the installer                          | **No UAC/admin prompt at any point**; folder page offers a per-user path under `%LOCALAPPDATA%\Programs` |
| 4   | Finish (leave “Run” unticked)                     | Start-menu and desktop shortcuts exist                                                                   |
| 5   | Check `%APPDATA%\Autonomous Research Assistant`   | Does not exist yet (nothing created before first launch)                                                 |

### 6.2 First launch and SQLite

| #   | Step                                                  | Expected                                                                                              |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 6   | Start **from the Start menu**                         | Window titled “Autonomous Research & Knowledge Assistant”; no menu bar; F12 / Ctrl+Shift+I do nothing |
| 7   | Check `%APPDATA%\Autonomous Research Assistant\data\` | `research.db` exists (plus `-wal`/`-shm` while running)                                               |
| 8   | Check the install folder                              | No new files written there by the app                                                                 |
| 9   | No Ollama is reachable for this user                  | Banner “Ollama is not reachable at http://127.0.0.1:11434”; the app stays usable                      |

### 6.3 Settings persistence, Legacy and ADK availability

| #   | Step                                                                                                  | Expected                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 10  | Settings → **Agent engines**                                                                          | Chat and Research each offer **Legacy** and **ADK**; the source shown is “default”                     |
| 11  | Set Chat = ADK, Research = ADK, and change one harmless value (e.g. model name `test-model:1b`). Save | Saved without error; source shows “saved in Settings”                                                  |
| 12  | Close the window (normal quit), start again from the Start menu                                       | All three values kept; no “interrupted” items; same `research.db` (size/modified time grow, not reset) |
| 13  | Set the values back to the defaults                                                                   | Saved                                                                                                  |

### 6.4 Network (no unexpected requests)

| #   | Step                                                                                                                                                                                                                             | Expected                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 14  | With the app open and idle for 2 minutes, in PowerShell: `$ids = (Get-Process "Autonomous Research Assistant").Id; Get-NetTCPConnection \| ? OwningProcess -in $ids \| ft LocalAddress,LocalPort,RemoteAddress,RemotePort,State` | Only connections to `127.0.0.1` (Ollama/SearXNG if configured) or nothing; **no external addresses** (no update, telemetry or spell-check hosts) |
| 15  | Alternatively, Resource Monitor → Network → filter the process                                                                                                                                                                   | Same                                                                                                                                             |

(The automated `pnpm smoke:packaged` already checks this in depth via Chromium net logs.
This step confirms it for the real installed copy.)

### 6.5 Uninstall keeps data, reinstall reuses it

| #   | Step                                                                                         | Expected                                                                                                            |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 16  | Note the size and modified time of `research.db`                                             | —                                                                                                                   |
| 17  | Quit the app; _Settings → Apps → Installed apps → Autonomous Research Assistant → Uninstall_ | No admin prompt; program folder and shortcuts removed                                                               |
| 18  | Check `%APPDATA%\Autonomous Research Assistant`                                              | **Still present**, `research.db` unchanged (size and time from step 16)                                             |
| 19  | Run the setup exe again and start the app                                                    | Previous settings (e.g. engine choices if you left them changed) and any tasks are still there; no migration errors |
| 20  | Optional: unzip the portable zip (after _Properties → Unblock_) and start it                 | Runs; uses the same `%APPDATA%` data                                                                                |

### 6.6 Clean-up

Sign out of `rka-test`, then delete that account from the developer account
(_Settings → Accounts → Other users → Remove_), which removes its data. Do not delete
anything in your developer account.

## 7. Optional installed-app functional check (remote inference, only with approval)

**Not run, and must not run automatically.** Do it only if you approve remote
inference for this test. Never use local GPU inference, and run no benchmarks.

In the `rka-test` account, after 6.3:

1. Settings → Ollama: enter **your** remote Ollama URL by hand (HTTPS; never paste it into
   files in the repo). If your endpoint needs the documented ngrok bypass, set
   `OLLAMA_NGROK_BYPASS_HOSTS` for that user session only, as described in
   `docs/settings.md`. Click **Test connection**: the Chat label shows **Remote
   Ollama**.
2. Set the model to the one your endpoint serves. **One short Chat**: “Reply with one
   word: ready.” Expected: a short answer, in Legacy and then once in ADK if desired.
3. **One small Research task**: a simple, low-cost goal (e.g. “When was the Eiffel Tower
   completed?”) with the smallest limits. It needs a configured SearXNG. Expected:
   completes with a cited report, or fails with a clear message. Note the duration.
4. Clear the remote URL from Settings afterwards (or delete the test account).

## 8. Automated verification results

| Check                                                                                | Where                                      | Result                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------- |
| `pnpm verify:win-build` on the Phase 7.7 Windows build                               | developer machine (read-only)              | **26/26 PASS**; payload check SKIP (no 7-Zip there) |
| Installer payload vs `win-unpacked` (same method as the script)                      | sandbox headers + developer machine hashes | **46/46 identical, 0 extra**                        |
| Verifier payload path, end-to-end with a real 7z (match / changed file / extra file) | sandbox                                    | PASS / FAIL / FAIL as expected                      |
| New unit tests `verify-windows-build.test.ts`                                        | sandbox                                    | 5/5                                                 |
| `security-guards.test.ts` (packaging and fuse config guards)                         | sandbox                                    | 18/18                                               |
| `pnpm --filter @rka/desktop typecheck`                                               | sandbox                                    | pass                                                |
| `pnpm lint` (whole repo, `--max-warnings=0`)                                         | sandbox                                    | pass                                                |
| `pnpm format:check`                                                                  | sandbox                                    | pass                                                |

The full test suite was not rerun. No application code changed (the 7.7 Windows run gave
1109 tests passing and `smoke:packaged` 46/46). Suggested on Windows: `pnpm
verify:win-build` (installing 7-Zip enables the 27th check) and `pnpm test
--project desktop`.

## 9. Remaining manual items

- Section 6 (install without elevation, Start-menu launch, SQLite, Settings
  persistence, Legacy/ADK availability, restart, uninstall/reinstall keeps data, network
  observation) in a disposable Windows account: **not performed**.
- Section 7 (optional remote Chat + small Research): **not performed**; it needs your
  approval.
- SmartScreen behaviour of the unsigned installer: manual.

## 10. Final Phase 7.7 status: **PARTIAL**

Everything that can be verified without installing is done and passing. That covers the
fuse CLI root cause and fix, the fuse values read from the Windows exe (all as
specified), the ASAR integrity resource matching the packaged `app.asar`, x64 identity,
checksums, and proof that the installer payload is byte-identical (CRC32) to the
verified `win-unpacked`. Phase 7.7 will be **PASS** once the manual checklist in
section 6 has been run in a disposable Windows account and recorded. I have not claimed
the manual installation passed, because it was not performed.
