# Windows Acceptance — ADK Migration Phase 7.1

A repeatable manual procedure for the Windows Electron app (development and packaged),
covering Chat and Research on both engines. Node/Vitest results do **not** replace it:
every row below must be checked in the running app.

Record each result as **PASS**, **FAIL** (with a note) or **N/A**, plus the date and the
app version.

## 0. Preparation

1. **Close the app.** Back up the data folder; the acceptance tasks are created in your
   normal database:

   ```powershell
   Copy-Item -Recurse "$env:APPDATA\Autonomous Research Assistant\data" "$env:USERPROFILE\Desktop\rka-data-backup-$(Get-Date -Format yyyyMMdd-HHmm)"
   ```

2. **Prerequisites:**
   - Ollama 0.40.14 or later is running, and `ollama list` shows the configured model (for
     example `qwen3:8b`).
   - SearXNG is reachable and set in Settings → Research & Web Search. Research needs web
     search.

3. **Repository:**

   ```powershell
   cd C:\Users\zandm\Projects\Algoalliance\sample-agent
   pnpm install
   pnpm typecheck; pnpm lint; pnpm format:check; pnpm test
   ```

4. **Read-only database report.** Run it before and after each section. It prints no goals
   or content and never writes:

   ```powershell
   pnpm acceptance:db "$env:APPDATA\Autonomous Research Assistant\data\research.db"
   ```

   Expect `quickCheck: ["ok"]` and all four `adkSessionTables` counts equal to `0`.

5. **Environment.** Clear any engine flags in the current PowerShell session:

   ```powershell
   Remove-Item Env:AGENT_ENGINE, Env:RESEARCH_ENGINE -ErrorAction SilentlyContinue
   ```

   Also make sure `settings.env` contains no `AGENT_ENGINE` or `RESEARCH_ENGINE` line:

   ```powershell
   Get-Content "$env:APPDATA\Autonomous Research Assistant\settings.env" -ErrorAction SilentlyContinue
   ```

A "short research goal" below means: _"When was the Eiffel Tower built and how tall is
it?"_

## 1. Development app (`pnpm dev`)

The terminal running `pnpm dev` shows the main-process log.

| #   | Step                                                                                                                  | Expected                                                                                                                                                                    | Result |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | `pnpm dev`, with no flags set.                                                                                        | The window opens. The log shows `ADK runtime: … self-check passed`.                                                                                                         |        |
| D2  | Chat: send "Name three colours."                                                                                      | The reply streams and completes. The log shows `Chat engine: legacy`.                                                                                                       |        |
| D3  | Chat: send a follow-up that needs the history ("And the first one in German?").                                       | The answer uses the earlier turn.                                                                                                                                           |        |
| D4  | Chat: ask for a long essay, press **Stop** mid-answer.                                                                | Generation stops. The message shows as cancelled; there is no error and no duplicated text.                                                                                 |        |
| D5  | Research: start the short goal with no flag set.                                                                      | The task completes with a report. The log shows `Research engine for the new task: legacy`.                                                                                 |        |
| D6  | Stop `pnpm dev`. Then run `$env:AGENT_ENGINE="adk"; pnpm dev`.                                                        | The log shows `Chat engine: adk` at the first Chat request.                                                                                                                 |        |
| D7  | Repeat D2–D4 on ADK.                                                                                                  | Same behaviour as legacy. After Stop, an ADK warning "The last event is partial, which is not expected." may appear; the message is still shown as cancelled, not complete. |        |
| D8  | With `AGENT_ENGINE=adk` still set, start a Research task (no `RESEARCH_ENGINE`).                                      | The log shows `Research engine for the new task: legacy`. The flags are independent.                                                                                        |        |
| D9  | Stop. Then run `$env:RESEARCH_ENGINE="adk"; Remove-Item Env:AGENT_ENGINE; pnpm dev`. Start the short goal.            | The log shows `Research engine for the new task: adk`. The task completes. Chat shows `Chat engine: legacy`.                                                                |        |
| D10 | `pnpm acceptance:db …`                                                                                                | The D9 task has `engine: "adk"`; the D5 task has `engine: "legacy"`. `completedStepsWithDuplicateUsage` is empty. ADK session tables are 0.                                 |        |
| D11 | Pause and resume: start an ADK task and press **Pause** during "Extract evidence". Then press **Resume**.             | The task shows Paused, then completes. Finished steps are not repeated (check the step list).                                                                               |        |
| D12 | Cancel during generation: start an ADK task and press **Cancel** during "Compare findings" or "Write report".         | The task is Cancelled. That step shows "Cancelled by the user.". There is no report.                                                                                        |        |
| D13 | Restart recovery: start an ADK task. During "Write report", close the window (or stop `pnpm dev`).                    | —                                                                                                                                                                           |        |
| D14 | Flag changed after task creation: run `$env:RESEARCH_ENGINE="legacy"; pnpm dev`, open the D13 task, press **Resume**. | The task completes. `acceptance:db` still shows it as `engine: "adk"`, with no duplicate usage and one report. In D13/D14 the task resumes on its pinned ADK engine.        |        |
| D15 | Return to defaults: run `Remove-Item Env:AGENT_ENGINE, Env:RESEARCH_ENGINE -ErrorAction SilentlyContinue; pnpm dev`.  | The log shows `Chat engine: legacy` and `Research engine for the new task: legacy` for a new task.                                                                          |        |

## 2. Packaged app

1. Build the packaged app:

   ```powershell
   pnpm package:win
   ```

   The output is in `apps\desktop\release\`: the setup installer, the portable exe, and
   `win-unpacked\`.

2. Run the unpacked app with its main-process log captured. If the log file stays empty,
   use `acceptance:db` and the UI instead:

   ```powershell
   $exe = Resolve-Path ".\apps\desktop\release\win-unpacked\Autonomous Research Assistant.exe"
   Start-Process -FilePath $exe -RedirectStandardOutput "$env:TEMP\rka-out.log" -RedirectStandardError "$env:TEMP\rka-err.log"
   ```

3. **Engine flags for the packaged app.** Add `AGENT_ENGINE=adk` or `RESEARCH_ENGINE=adk`
   lines to `%APPDATA%\Autonomous Research Assistant\settings.env`, then restart the app.

| #   | Step                                                                                                                                       | Expected                                                                                                                                                                     | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | Start the packaged app with no flags.                                                                                                      | The window opens; the startup check shows Ollama ready. There is no menu and no DevTools.                                                                                    |        |
| P2  | Chat on legacy: stream, follow-up, Stop.                                                                                                   | As D2–D4.                                                                                                                                                                    |        |
| P3  | Research on legacy: short goal.                                                                                                            | Completes with a report. In the Reports list, the sources are listed and open in the browser.                                                                                |        |
| P4  | `settings.env` with `AGENT_ENGINE=adk` and `RESEARCH_ENGINE=adk`; restart the app.                                                         | Chat (stream, follow-up, Stop) behaves as on legacy.                                                                                                                         |        |
| P5  | Research on ADK: short goal.                                                                                                               | Completes. `acceptance:db` shows `engine: "adk"`.                                                                                                                            |        |
| P6  | Pause and resume, then cancel (as D11 and D12) on ADK.                                                                                     | As D11 and D12.                                                                                                                                                              |        |
| P7  | Start an ADK task and quit the app during a model step. Change `settings.env` to `RESEARCH_ENGINE=legacy`, start the app, Resume the task. | The task is offered as interrupted and completes. It stays `adk` in `acceptance:db`, with one report and no duplicate usage.                                                 |        |
| P8  | Storage → Integrity check, and Storage → Backup.                                                                                           | Integrity is OK; the backup file is written.                                                                                                                                 |        |
| P9  | Remove both lines from `settings.env` and restart.                                                                                         | New Chat requests and new Research tasks are legacy. Earlier ADK tasks still show `engine: "adk"` (by design).                                                               |        |
| P10 | Final `pnpm acceptance:db …`                                                                                                               | `quickCheck` is `ok`. `unfinishedAdkTasks` is empty (or contains only tasks you deliberately left unfinished). `tasksWithDuplicateUsage` is empty. ADK session tables are 0. |        |

## 3. Live tests and benchmark

> **Phase 7.2 safety notice.** Two complete Windows hard freezes happened while the
> live benchmark ran on this laptop. Do **not** run a live benchmark on this machine
> until the cause is understood. See `docs/benchmark-safety.md`. Live inference tests
> also put sustained load on the GPU. Run them one at a time, only while you are
> present, and stop if the fans ramp up strongly.

The live tests use temporary databases and fixture web pages, and never touch your app
database. Each one is short (a few minutes at most):

```powershell
pnpm test:research:ollama
pnpm test:chat:ollama
pnpm test:adk:ollama
```

The benchmark is now safe by default:

- `pnpm bench:research:ollama` only prints the safety notice and the planned workload.
- `$env:BENCH_MODE="fake"; pnpm bench:research:ollama` compares the engines against a
  deterministic fake Ollama, with no model and no GPU work.

## 4. Before downgrading to a version older than Phase 7

Older versions do not know the Research engine pin. They would resume an ADK task on the
legacy engine. Before you install an older version:

1. Run `pnpm acceptance:db …`.
2. Finish or cancel every task listed in `summary.unfinishedAdkTasks`.

## 5. Restore

If you want to discard the acceptance tasks:

1. Close the app.
2. Rename `%APPDATA%\Autonomous Research Assistant\data`.
3. Copy the backup from step 0 back as `data`.
