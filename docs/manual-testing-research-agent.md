# Manual end-to-end test: autonomous research with local Ollama

This guide walks through one real research run on your machine: local Ollama, a local
SearXNG for search, and live web pages. Plan for 30–45 minutes. Most of that is the model
working; with `qwen3:8b` on a 6 GB GPU a run with the default limits takes about 5–15
minutes.

The automated tests (`pnpm check`) use a scripted model and a scripted web. This guide is
the only check against the real model, so record your results in the checklist at the end.

## 1. Prerequisites

| What                   | How to check                     |
| ---------------------- | -------------------------------- |
| Ollama running         | `ollama list` shows `qwen3:8b`   |
| Model installed        | `ollama pull qwen3:8b` (once)    |
| Docker (for SearXNG)   | `docker --version`               |
| Dependencies installed | `pnpm install` in the repository |
| Checks pass            | `pnpm check`                     |

### Context window

The default `.env` uses `OLLAMA_NUM_CTX=4096`, which fits a 6 GB GPU. The prompts are
sized to fit that window with the default limits (3 questions, 6 sources, 5,000
characters per source). If you raise those limits, or the report step fails with
`invalid-response`, set `OLLAMA_NUM_CTX=8192` (uses more VRAM) and restart the app.

### Start SearXNG with JSON output

```powershell
mkdir $HOME\searxng
docker run -d --name searxng -p 127.0.0.1:8080:8080 -v "$HOME\searxng:/etc/searxng" searxng/searxng
```

Stop the container once (`docker stop searxng`) and edit `$HOME\searxng\settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

Start it again with `docker start searxng` and check:

```powershell
curl "http://127.0.0.1:8080/search?q=heat+pumps&format=json"
```

This should print JSON. A `403` means JSON output is still disabled.

### Configure the app

In `.env` at the repository root:

```dotenv
SEARXNG_URL=http://127.0.0.1:8080
OLLAMA_MODEL=qwen3:8b
```

Run `pnpm dev`.

## 2. Smoke-test the tools first

1. Open **Research Tools**. _Search provider_ must say **Ready**.
2. Search for `heat pump efficiency cold climate`. Results appear with positions and URLs.
3. Click **Fetch & extract** on a result. The text is extracted and an HTTP status is shown.

If either fails, fix it before going on: the agent uses the same tools.

## 3. Run a research task

1. **Tasks → New research.**
2. Goal: `How efficient are air source heat pumps in cold climates, and what does installation typically cost in Germany?`
3. Leave _Sub-questions_ at 3 and _Sources to read_ at 6. Click **Start research**.

Expected, in order (the task page updates live):

| Step(s)                              | What you see                                                           | Typical time (qwen3:8b, 6 GB)        |
| ------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------ |
| 1 Create research plan               | Title changes to `Research: <plan title>`; progress shows "of about N" | 20–60 s (first call loads the model) |
| Search: … (one per question)         | Fast; no model call                                                    | 1–5 s each                           |
| Choose sources                       | Total number of steps becomes exact                                    | instant                              |
| Read source n / Extract evidence n   | _Discovered sources_ fills up                                          | 2–10 s / 20–60 s each                |
| Compare findings                     |                                                                        | 30–90 s                              |
| Write report                         |                                                                        | 40–120 s                             |
| Review report for unsupported claims |                                                                        | 20–60 s                              |
| Save report                          | **Final report** appears; status **Completed**                         | instant                              |

Check the result:

- [ ] Every paragraph ends with citation numbers like `[1][3]`.
- [ ] Each number appears in **Sources** with a link. Open two links and confirm the cited
      facts are really on those pages. This checks the extraction step: the quote behind each
      claim was verified verbatim against the page text.
- [ ] Thin or disputed points are prefixed **Uncertain:** or marked _(only partly supported…)_.
- [ ] **Review notes** gives the counts, and lists any statement removed as unsupported.
- [ ] **Gaps and open questions** names what the sources did not cover.
- [ ] Nothing in the report comes from outside the listed sources. Look especially for
      numbers that appear in no source.

## 4. Pause and resume

1. Start another research task.
2. While a step named **Extract evidence…** is running, click **Pause**.
3. Expected:
   - A **Paused** badge and panel appear: "The step that was running will start again on resume."
   - The progress does not change.
   - Ollama stops working on the request (`ollama ps` shows the model idle after a few seconds).
4. Wait a minute, then click **Resume**. The paused step runs again; earlier steps do not.
   In the timeline, that step shows _Attempt: 2_, and all others show _Attempt: 1_.

## 5. Crash recovery

1. Start a research task and wait until a few sources are read.
2. Kill the app: close the terminal running `pnpm dev`, or end the Electron process in
   Task Manager.
3. Run `pnpm dev` again and open the task. Expected:
   - Status **Interrupted** (not Paused), with "The app stopped while this task was running."
   - It does **not** continue on its own.
4. Click **Resume**. It continues at the interrupted step and completes. The sources read
   before the crash are not fetched again.

## 6. Cancel

Start a task and click **Stop** during any step. Expected:

- Status **Cancelled**.
- The running step shows _Cancelled by the user._
- The remaining steps stay _Pending_.
- A cancelled task cannot be resumed.

## 7. Failure handling

Background: [failure-recovery.md](failure-recovery.md). After each scenario, open
**Execution log** on the task page. It should show the events named below.

| Scenario                                                          | Expected                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quit Ollama (tray icon), then click **Start research**            | Refused: "Ollama is not reachable at http://127.0.0.1:11434 … Start Ollama and try again." No task is created.                                                                                                                        |
| Set `OLLAMA_MODEL` to a model you have not pulled, restart, start | Refused: "The model … is not installed. Run "ollama pull …"".                                                                                                                                                                         |
| Quit Ollama while a model step runs                               | After one retry the task shows **Waiting for Ollama** (status _Interrupted_), with the error and "Start Ollama…". Log: `model.retry`, `model.failed`, `task.waiting`. Start Ollama, click **Resume**: it completes.                   |
| `docker stop searxng` while the searches run                      | **Waiting for SearXNG**. `docker start searxng`, then **Resume**: the search step runs again.                                                                                                                                         |
| Disconnect the network (Wi-Fi off) while sources are read         | The first unreachable source is marked _Failed_, and its evidence step is _Skipped_ with the reason. The second one stops the task: **Waiting for the internet connection**. Reconnect, then **Resume**: both sources are read again. |
| Remove `SEARXNG_URL` from `.env` and restart                      | **Start research** is refused: "Web search is not configured. Set SEARXNG_URL…".                                                                                                                                                      |
| A page that blocks bots or returns 404                            | That fetch step is _Failed_ (`[http-error-4xx] …`) and its evidence step _Skipped_. The research continues, a yellow notice says how many steps failed, and the report's _Review notes_ list "Source not used: …".                    |
| Set `RESEARCH_MODEL_RETRIES=abc` and restart                      | The app does not start: "Invalid RESEARCH_MODEL_RETRIES: …".                                                                                                                                                                          |
| Goal shorter than 10 characters                                   | The Start button stays disabled.                                                                                                                                                                                                      |

### Retry a failed task

A simple way to make a task fail, then recover it:

1. Start a task with **Sources** set to 1.
2. Turn the network off while **Choose sources** is running, before the source is read.
3. Expected:
   - The single source fails, and the analysis has nothing to work with.
   - The task is **Failed** with "None of the 1 selected source(s) could be read".
   - The panel says "Retry runs the failed steps again", and a **Retry** button is shown.
4. Turn the network on and click **Retry**.
5. Expected:
   - The source is fetched again and the task completes.
   - Plan and search steps keep _Attempt: 1_.
   - The log shows `task.failed`, then `task.retry`.

## 8. Where the data lives

- **Tasks:** status, every step with its JSON output (plan, search results, verified claims,
  analysis, draft, review verdicts), attempts and timings.
- **Knowledge Base:** the sources, with their extracted text.
- **Reports:** the Markdown report, version 1.
- **Storage:** row counts grow in `tasks`, `task_steps`, `task_logs`, `sources`,
  `source_contents`, `reports` and `model_usage`.

Everything is in `%APPDATA%\Autonomous Research Assistant\data\research.db`. No cloud
service is called. The only network traffic is SearXNG, the fetched web pages, and Ollama
on `127.0.0.1`.

## Results checklist

| #   | Check                                                   | Result |
| --- | ------------------------------------------------------- | ------ |
| 1   | Research Tools search and fetch work                    |        |
| 2   | A research task completes                               |        |
| 3   | Every paragraph has citations that resolve to sources   |        |
| 4   | Spot-checked citations are correct                      |        |
| 5   | Uncertainty and review notes are present                |        |
| 6   | Pause → Resume continues without repeating steps        |        |
| 7   | Crash → restart → Interrupted → Resume completes        |        |
| 8   | Cancel works                                            |        |
| 9   | SearXNG down / not configured: waits or refuses clearly |        |
| 10  | Ollama down: start refused; mid-run waits, Resume works |        |
| 10a | Network off: waits; Resume re-reads failed sources      |        |
| 10b | Failed task: Retry runs only the failed steps           |        |
| 10c | Execution log shows every transition                    |        |
| 11  | App stays responsive during a run                       |        |
| 12  | Total run time with default limits: ____ min            |        |
