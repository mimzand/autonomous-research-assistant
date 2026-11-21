# User guide

A Windows desktop assistant that chats and researches with a language model running in
**Ollama** (on this computer or on a server you choose). Educational project.

## 1. Install and launch

1. Run `Autonomous Research Assistant-<version>-win-x64-setup.exe`.
   - It installs **for your user only** and needs no administrator rights.
   - The build is not code-signed. If SmartScreen appears, choose **More info → Run anyway**.
2. Start it from the **Start menu** (or the desktop shortcut).

The portable zip works the same way: unblock it, unzip it and run
`Autonomous Research Assistant.exe`.

Your data is stored in `%APPDATA%\Autonomous Research Assistant` (database:
`data\research.db`). Uninstalling keeps it.

The app runs its research engine as a second, background process of the same program
(Task Manager → Details shows two `Autonomous Research Assistant.exe`). It talks to the
window only through this computer (`127.0.0.1`), never over the network, and it closes
with the app. While the app runs you will also see `agent-state.json` in the data folder;
it is removed when the app closes. Existing data from earlier versions is used as is.

Details: [installation.md](installation.md).

## 2. Configure Ollama (required)

1. Install [Ollama](https://ollama.com) and a model with tool support, e.g.
   `ollama pull qwen3:8b`.
2. In the app, open **Settings → Ollama Connection**.
   - The default is `http://127.0.0.1:11434`.
   - For a remote server enter its URL (HTTPS recommended), click **Test connection**,
     then **Save**.
3. **Settings → AI Models:** click **Use** next to the model.

The app never downloads models itself. If something is missing, it shows the command to
run.

## 3. Configure SearXNG (optional)

Research and web search need a [SearXNG](https://docs.searxng.org) instance with JSON
output enabled.

1. Go to **Settings → Research & Web Search**.
2. Enter its URL (e.g. `http://127.0.0.1:8080`), click **Test connection**, then **Save**.

Without SearXNG, Chat works but cannot search, and Research cannot start.

## 4. Use the app

- **Chat**
  - Type and press Enter; Shift+Enter adds a new line.
  - **Stop** ends a reply. **Clear chat** deletes the conversation and starts over.
  - The conversation is saved and shown again when you reopen the app. The model sees
    your last 8 messages and replies, plus a short note listing earlier questions; older
    answers stay on screen but are not sent to it again.
  - Replies are plain text.
- **Web search in Chat**
  - Turn it on in **Settings → Agent Engines → Web search in Chat**. It is off by
    default.
  - The model may then search the web while answering, with either Chat engine.
  - Each search appears above the reply: the query, "Searching…", the number of
    results, or why it was not run.
  - Limits: 3 searches and 60 s per message.
  - Queries go to your SearXNG service and possibly to the search engines it uses.
  - Results are unverified web content.
- **Research**
  - Enter a question and start a task. The app plans, searches, reads sources, extracts
    evidence and writes a report with citations.
  - You can pause, resume, cancel and retry a task. Tasks interrupted by closing the
    app can be resumed.
  - Research never lets the model choose tools; its steps are fixed.
- **Engines:** under **Settings → Agent Engines** choose **Legacy** (default) or
  **Google ADK** separately for Chat and Research. Both use the same Ollama server and
  model.
- **Knowledge Base / Reports / Storage:** browse saved sources and reports, check the
  database and export a backup.

## 5. Trying it without a real model

On a computer with this repository and Node.js, run `pnpm fake:services`. It starts a
fake Ollama (`http://127.0.0.1:11435`, model `fake-model:1b`) and a fake SearXNG
(`http://127.0.0.1:8089`) on this computer only.

Point the app at them in Settings:

- A message containing **"search"** triggers a web search when web search is on.
- A message containing **"slow"** makes the search take 10 s, so you can try Stop.
- A full Research run needs a real model.

## 6. Known limitations

- **Unsigned installer, no auto-update.** Install a new version over the old one.
- **Answer quality depends on the model.** Small local models may skip the search or
  call it poorly.
- **Chat answers are not fact-checked.** Only Research grounds its claims in sources.
- **The 60 s web-search limit includes the answer.** A slow model writing a long answer
  after a search can be stopped with a timeout.
- **ADK Chat ends with an error on an unknown tool.** If the model asks for a tool that
  does not exist, ADK Chat ends the reply with an "invalid response" error (nothing is
  run). Legacy Chat refuses the call and continues.
- **One reply at a time, one conversation.** There is no list of past conversations;
  **Clear chat** deletes the saved one. A conversation holds at most 200 messages.
- **If the background process stops, restart the app.** Should the research engine
  process end unexpectedly (for example if it is ended in Task Manager), requests show
  errors until you close and reopen the app; nothing is lost beyond the running step,
  and an interrupted research task can be resumed.
- **"The agent service exited during startup" or "did not start in time".** Close the
  app, make sure no `Autonomous Research Assistant.exe` is left in Task Manager, and
  start it again. Security software that blocks programs from listening on
  `127.0.0.1` can cause this.
- **Some sites cannot be read.** Sites behind bot checks or CAPTCHAs are never bypassed.
