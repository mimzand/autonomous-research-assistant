# ADK Migration — Windows Smoke Test

Manual procedure for checking the ADK migration on Windows (x64). It covers the Phase 1 changes (ADK loaded in the Electron main process) and the Phase 2 changes (Ollama tool calling in the provider, off in the app).

**Status:** not yet run. Phases 1 and 2 were verified on Linux x64 only. Until this procedure passes on Windows, Windows compatibility is **unverified**.

## Prerequisites

- Windows 10/11 x64, Node.js ≥ 22.12, pnpm 12.16.1 (`corepack enable`).
- Ollama running and reachable (default `127.0.0.1:11434`), with the configured model installed, e.g. `qwen3:8b`. Do not pull a model just for this test; use what is installed.
- Optional: a SearXNG instance for the research checks.

## 1. Install and automated checks

```powershell
cd <repo>
git status            # note any local changes first
pnpm install --frozen-lockfile
pnpm check            # typecheck, lint, format:check, test, build
```

Record:

- exit codes;
- the test summary (expected: all pass);
- any Windows-only failures, such as path separators, file locking or `better-sqlite3` loading.

## 2. Live Ollama tests

```powershell
$env:OLLAMA_HOST = "127.0.0.1:11434"   # or your server
$env:OLLAMA_MODEL = "qwen3:8b"         # the installed model to test
pnpm test:ollama
```

Record from the output:

- `[live] Ollama <version>, model <name>, tools advertised: yes|no|unknown`;
- `[live] streaming tool-call behaviour: {...}`, which shows:
  - which chunk carried the tool call;
  - whether the server sends ids and indexes;
  - the type of the arguments;
- the calculator answers (expected to contain 6000);
- skipped tests and their reasons.

## 3. Development mode

```powershell
pnpm dev
```

In the terminal, confirm these log lines appear:

- `ADK runtime: @google/adk 2.4.0 loaded, self-check passed in N ms; ...`
- `Startup check: ...`
- no `ADK runtime: ... failed` or `could not be loaded` warning.

In the app:

| Check                                                             | Expected                                                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Model status panel                                                | Ollama ready, correct model                                                                          |
| Chat: send "Say hello in five words."                             | Reply streams in; **Stop** works mid-reply; no error banner                                          |
| Storage page: status and **Integrity check**                      | Database path under `%APPDATA%\Autonomous Research Assistant`; integrity "ok"                        |
| Tasks: run the persistence check                                  | Task completes with the steps `check`, `generate`, `verify`                                          |
| Research: start a short task (needs SearXNG)                      | Progresses through plan → search → … → report; **Pause**, **Resume** and **Cancel** behave as before |
| Research recovery: quit the app during a running task and restart | Task shows as interrupted and can be resumed                                                         |
| Settings: Ollama connection test, model list                      | Work as before                                                                                       |

## 4. Packaged build

```powershell
pnpm package:dir
.\apps\desktop\release\win-unpacked\"Autonomous Research Assistant.exe"
```

Repeat the checks in §3.

To see the startup log of the packaged app, start it from a terminal. Also record:

- the size of `resources\app.asar`;
- the size of the NSIS installer, if it is built with `pnpm package:win`.

## 5. Security spot checks

- DevTools are not available in the packaged build, and there is no application menu.
- With `GOOGLE_API_KEY` and `OTEL_EXPORTER_OTLP_ENDPOINT` set in the environment before launching, the ADK log line reports that both were removed.
- Optional: Resource Monitor → Network shows connections only to the Ollama host (and SearXNG or fetched sites during research).

## 6. Report

Record the following for each section:

- pass or fail;
- Windows build and version;
- Node version;
- Ollama version and model;
- any deviations.
