# Installing, updating and uninstalling (Windows)

The app runs entirely on your computer:

- The language model runs in **Ollama**.
- Web search goes through your own **SearXNG** instance.
- The app reads web pages to research them.
- Nothing is sent to a cloud model provider.

## 1. Requirements

| Component                      | Why                                                        |
| ------------------------------ | ---------------------------------------------------------- |
| Windows 10 or 11, 64-bit (x64) | The release is built for x64.                              |
| Ollama                         | Runs the local model.                                      |
| The model `qwen3:8b` (~5 GB)   | Default model. Another model can be set in settings.       |
| SearXNG (e.g. in Docker)       | Web search for autonomous research. Chat works without it. |
| ~1 GB free disk for the app    | Plus space for the model and your research database.       |

The app checks Ollama and the model each time it starts. If either is missing, a banner
says what to do and shows the exact command to run. **The app never downloads a model
by itself.** Downloading several GB is always your decision.

## 2. Install Ollama and the model

1. Install Ollama from <https://ollama.com/download>. It starts automatically and runs in
   the system tray.
2. Open **PowerShell** and download the model. This needs ~5 GB of disk space and may take
   a while:

   ```powershell
   ollama pull qwen3:8b
   ```

3. Check that it is installed:

   ```powershell
   ollama list
   ```

## 3. Install SearXNG (for autonomous research)

With Docker Desktop:

```powershell
docker run -d --name searxng -p 127.0.0.1:8080:8080 searxng/searxng
```

Then enable JSON output in its `settings.yml` (`search: formats: [html, json]`) and
restart the container. [manual-testing-research-agent.md](manual-testing-research-agent.md#start-searxng-with-json-output)
has the details.

## 4. Install the app

Two downloads are produced for each release:

| File                                                           | Use                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Autonomous Research Assistant-<version>-win-x64-setup.exe`    | Installer. Recommended.                                                      |
| `Autonomous Research Assistant-<version>-win-x64-portable.zip` | No installation: unzip anywhere and run `Autonomous Research Assistant.exe`. |

**Installer:**

- It installs for the current user only and never asks for administrator rights.
- You can choose the folder. The default is under `%LOCALAPPDATA%\Programs`.
- It creates Start menu and desktop shortcuts.

**Unsigned build:** this release is not code-signed, so Windows SmartScreen may show
"Windows protected your PC" on first start. Check that the file came from your own
build or a trusted release, then click **More info → Run anyway**. For the portable
zip: right-click the zip → **Properties** → tick **Unblock** before extracting.

## 5. Configure

The defaults match a standard local setup:

- Ollama on `127.0.0.1:11434`.
- The model `qwen3:8b`.
- **Web search is off** until you set `SEARXNG_URL`.

To change settings:

1. Open `%APPDATA%\Autonomous Research Assistant` in Explorer. Paste the path into the
   address bar. The folder exists after the first start.
2. Create a text file named `settings.env`, for example:

   ```ini
   SEARXNG_URL=http://127.0.0.1:8080
   # OLLAMA_HOST=127.0.0.1:11434
   # OLLAMA_MODEL=qwen3:8b
   # RESEARCH_MAX_SOURCES=6
   ```

3. Restart the app.

How settings are applied:

- Only `OLLAMA_*`, `SEARXNG_*`, `WEB_*` and `RESEARCH_*` settings are read from this
  file. Anything else is ignored, which is written to the log.
- Real environment variables take precedence over the file.
- An invalid value stops the app with a message naming the setting.

All settings are listed in [`.env.example`](../.env.example).

## 6. Where your data is stored

| What                                                    | Where                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Database: tasks, steps, execution log, sources, reports | `%APPDATA%\Autonomous Research Assistant\data\research.db` (+ `-wal`, `-shm`) |
| Settings                                                | `%APPDATA%\Autonomous Research Assistant\settings.env`                        |
| Browser cache of the app window                         | Other folders under `%APPDATA%\Autonomous Research Assistant`                 |
| Program files                                           | The installation folder; no user data is stored there.                        |
| Backups                                                 | Wherever you save them: **Storage → Export backup…**.                         |

Reports are stored in the database, so a backup contains everything.

## 7. Update

1. Optional but recommended: in the app, open **Storage → Export backup…** and save a copy of
   the database.
2. Close the app.
3. Run the new `…-setup.exe`. It replaces the program files and keeps your data. With the
   portable zip, extract the new version to a new folder.
4. Start the app.
   - Database upgrades (migrations) run automatically and keep existing data.
   - Interrupted research tasks wait for you to click **Resume**.

Notes:

- **No automatic updates:** the app never checks for updates or downloads them.
- **Downgrades:** going back to an older version is not supported once a newer one has
  upgraded the database. Restore the backup from step 1 instead.

## 8. Uninstall

1. Uninstall with **Settings → Apps → Installed apps → Autonomous Research Assistant →
   Uninstall**. For the portable version, delete its folder.
2. Your data in `%APPDATA%\Autonomous Research Assistant` is **kept**. To remove it as
   well, delete that folder yourself, after making a backup if you want one.
3. Ollama, its models and SearXNG are separate programs. Remove them separately if you no
   longer need them, for example with `ollama rm qwen3:8b`.

## 9. Troubleshooting

| Symptom                                       | Fix                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Banner: "Ollama is not reachable"             | Start Ollama from the Start menu. Use `127.0.0.1`, not `localhost`, in `OLLAMA_HOST`. |
| Banner: "The model qwen3:8b is not installed" | Run `ollama pull qwen3:8b`, then click **Check again**.                               |
| Banner: "Web search is not configured"        | Add `SEARXNG_URL` to `settings.env` and restart.                                      |
| App does not start, "Invalid RESEARCH_…"      | Fix or remove that line in `settings.env`.                                            |
| Research waits "for SearXNG"                  | Start the SearXNG container (`docker start searxng`), then click **Resume**.          |
