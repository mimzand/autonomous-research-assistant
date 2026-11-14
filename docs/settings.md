# Runtime settings

**Settings** (in the sidebar) configures the app while it runs: the Ollama server, the active
model, generation options, web search, limits, backups and security. No `.env` file has
to be edited and **no setting needs a restart**.

## How settings are resolved and stored

Each setting has three possible sources, lowest to highest:

1. **Built-in default** (the table below).
2. **Environment:** `.env` (development), `%APPDATA%\Autonomous Research Assistant\settings.env`
   (installed app) or the process environment. These are read once at startup with the
   same validation as before; an invalid value stops the app with a message naming it.
3. **Saved in Settings.** Values you save are stored in the local SQLite database (the
   existing `settings` table, keys `settings.<key>`), loaded at every start, and win over
   environment defaults.

**Exception — environment overrides.** For four settings an explicitly set environment
variable wins over the saved value:

| Setting         | Variable          | Order (highest first)                   |
| --------------- | ----------------- | --------------------------------------- |
| Ollama URL      | `OLLAMA_HOST`     | environment → saved → `127.0.0.1:11434` |
| Active model    | `OLLAMA_MODEL`    | environment → saved → `qwen3:8b`        |
| Chat engine     | `AGENT_ENGINE`    | environment → saved → `legacy`          |
| Research engine | `RESEARCH_ENGINE` | environment → saved → `legacy`          |

- Only a **non-empty, valid** value is an override. An unset or empty variable changes
  nothing. An invalid value (e.g. `OLLAMA_HOST=ftp://…`, `AGENT_ENGINE=turbo`) is **not
  used**: the saved value or default stays active, and the error is shown under the field
  and in the log. An `OLLAMA_HOST` with a user name/password, query or fragment is refused
  (credentials are never echoed).
- An overridden field is **read-only** and labelled **Overridden by `VAR`**; the saved
  value, if any, is shown as the inactive fallback. Nothing is saved over it. Remove the
  variable and **restart the app** to use or change the value in Settings again.
- The environment never bypasses **Require HTTPS for remote servers**: a plain-HTTP remote
  `OLLAMA_HOST` is not used while it is on, and it cannot be turned on while such an
  override is active.
- Not overridable (security): the HTTPS requirement, the access token (Settings only,
  encrypted), and `OLLAMA_NGROK_BYPASS_HOSTS` (a main-process trust list, never shown or
  editable in Settings).

The page shows the source of every value: **Default**, **From `VAR`** (environment) or
**Customized** (saved). **Reset** deletes the saved value, so the setting falls back to the
environment value or the built-in default. **Reset all** resets every setting but keeps
the access token. A value you saved explicitly is kept even if it equals the default, so a
later change of `.env` never silently changes something you chose.

The app never writes `.env` or `settings.env`.

### What happens on Save

1. The main process validates the change with the Zod schemas (ranges, URL rules,
   cross-field rules such as "Require HTTPS for remote servers"). Invalid input is not
   saved; the field shows the error. Fields are also checked while you type.
2. The running services that depend on the changed settings are updated (only those):
   the Ollama provider for `model.*` / `ollama.*`, the web search and fetch services for
   `searxng.*` / `web.*`. Research limits are read when each task starts.
3. The values are saved in one SQLite transaction.
4. All windows get a typed `settings:changed` event and the page confirms the change.

If step 2 or 3 fails, the services are restored to the previous values and nothing is
saved, so the database and the running app never disagree.

### When changes take effect

| Marked as           | Meaning                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Applies immediately | The next request uses the new value.                                                                                                                                                                                                                                       |
| New chats and tasks | New chat messages and new research tasks use it. **A running research task keeps the server, model and options it started with** (stored with the task), also after Pause/Resume, Retry and a restart. A chat answer that is already streaming finishes with its settings. |
| Next start          | Read when the app opens (start page). No restart is forced.                                                                                                                                                                                                                |

**Restart required:** none.

## All settings

Units: ms = milliseconds. "Model default" = the option is not sent, so Ollama uses the
model's own default (shown under AI Models → Details).

### General

| Setting             | Key                         | Default | Env variable | Allowed values                                                 | Applies     |
| ------------------- | --------------------------- | ------- | ------------ | -------------------------------------------------------------- | ----------- |
| Start page          | `general.startSection`      | `chat`  | —            | chat / tasks / knowledge / reports / research-tools / settings | next start  |
| Show startup checks | `general.showStartupChecks` | `true`  | —            | on / off                                                       | immediately |

### AI Models

| Setting                             | Key                       | Default       | Env variable                 | Allowed values                   | Applies            |
| ----------------------------------- | ------------------------- | ------------- | ---------------------------- | -------------------------------- | ------------------ |
| Active model                        | `model.name`              | `qwen3:8b`    | `OLLAMA_MODEL`               | Ollama model name                | new requests/tasks |
| Temperature                         | `model.temperature`       | Model default | —                            | 0 – 2; empty = Model default     | new requests/tasks |
| Top P                               | `model.topP`              | Model default | —                            | 0.01 – 1; empty = Model default  | new requests/tasks |
| Top K                               | `model.topK`              | Model default | —                            | 1 – 1,000; empty = Model default | new requests/tasks |
| Context length (num_ctx)            | `model.numCtx`            | 4,096         | `OLLAMA_NUM_CTX`             | 512 – 262,144                    | new requests/tasks |
| Maximum output tokens (num_predict) | `model.numPredict`        | No limit      | —                            | 1 – 131,072; empty = No limit    | new requests/tasks |
| Repeat penalty                      | `model.repeatPenalty`     | Model default | —                            | 0 – 2; empty = Model default     | new requests/tasks |
| Request timeout                     | `model.generateTimeoutMs` | 300,000 ms    | `OLLAMA_GENERATE_TIMEOUT_MS` | 1,000 – 3,600,000                | new requests/tasks |

### Ollama Connection

| Setting               | Key                       | Default                  | Env variable                | Allowed values                                 | Applies            |
| --------------------- | ------------------------- | ------------------------ | --------------------------- | ---------------------------------------------- | ------------------ |
| Server URL            | `ollama.baseUrl`          | `http://127.0.0.1:11434` | `OLLAMA_HOST`               | http(s) URL, no credentials/query              | new requests/tasks |
| Connection timeout    | `ollama.requestTimeoutMs` | 5,000 ms                 | `OLLAMA_REQUEST_TIMEOUT_MS` | 500 – 600,000                                  | immediately        |
| Access token (secret) | `ollama.authToken`        | not set                  | —                           | any string without spaces; HTTPS/loopback only | immediately        |

### Research & Web Search

| Setting                         | Key                        | Default        | Env variable             | Allowed values                                 | Applies            |
| ------------------------------- | -------------------------- | -------------- | ------------------------ | ---------------------------------------------- | ------------------ |
| SearXNG URL                     | `searxng.url`              | Not configured | `SEARXNG_URL`            | http(s) URL, no credentials/query; empty = off | immediately        |
| Safe search                     | `searxng.safeSearch`       | 1              | `SEARXNG_SAFESEARCH`     | 0 / 1 / 2                                      | immediately        |
| Search timeout                  | `web.searchTimeoutMs`      | 15,000 ms      | `WEB_SEARCH_TIMEOUT_MS`  | 1,000 – 120,000                                | immediately        |
| Maximum search results          | `research.resultsPerQuery` | 5              | —                        | 1 – 10                                         | new requests/tasks |
| Web fetch timeout               | `web.fetchTimeoutMs`       | 20,000 ms      | `WEB_FETCH_TIMEOUT_MS`   | 1,000 – 120,000                                | immediately        |
| Maximum fetched content size    | `web.maxDownloadBytes`     | 15 MiB         | `WEB_MAX_DOWNLOAD_BYTES` | 65,536 – 52,428,800                            | immediately        |
| Maximum extracted document size | `web.maxTextChars`         | 1,000,000      | —                        | 10,000 – 5,000,000                             | immediately        |
| Maximum PDF pages               | `web.maxPdfPages`          | 300            | —                        | 1 – 2,000                                      | immediately        |
| Questions per task              | `research.maxQuestions`    | 3              | `RESEARCH_MAX_QUESTIONS` | 1 – 6                                          | new requests/tasks |
| Sources per task                | `research.maxSources`      | 6              | `RESEARCH_MAX_SOURCES`   | 1 – 12                                         | new requests/tasks |

### Storage

| Setting       | Key                       | Default   | Env variable | Allowed values       | Applies     |
| ------------- | ------------------------- | --------- | ------------ | -------------------- | ----------- |
| Backup folder | `backup.defaultDirectory` | Documents | —            | folder (picker only) | immediately |

### Security

| Setting                          | Key                              | Default | Env variable | Allowed values | Applies     |
| -------------------------------- | -------------------------------- | ------- | ------------ | -------------- | ----------- |
| Require HTTPS for remote servers | `security.requireHttpsForRemote` | `false` | —            | on / off       | immediately |

### Agent Engines

| Setting            | Key               | Default  | Env variable      | Allowed values    | Applies     |
| ------------------ | ----------------- | -------- | ----------------- | ----------------- | ----------- |
| Chat engine        | `engine.chat`     | `legacy` | `AGENT_ENGINE`    | `legacy` or `adk` | immediately |
| Research engine    | `engine.research` | `legacy` | `RESEARCH_ENGINE` | `legacy` or `adk` | new tasks   |
| Web search in Chat | `chat.webSearch`  | `false`  | —                 | on / off          | immediately |

- **Legacy** is the existing runtime; **Google ADK** runs the same Ollama server, model
  and settings through Google ADK. ADK sessions are not persisted. Research never lets the
  model call tools (its searches and downloads are fixed steps run by the app).
- **Web search in Chat** (`chat.webSearch`, **off by default**, no environment variable):
  when on **and** a SearXNG URL is set, Chat (**Legacy and Google ADK**) may let the model
  search the web while answering, through the same ToolGateway. Changing engines never
  turns it on. Only the `web_search` tool is offered.
  Limits, enforced by the app: 2 tool rounds, 3 searches, 1 identical search, 5 results
  per search, 8 KB of result text per search, 24 KB per message, 60 s for the whole reply
  (including the answer). **Search queries chosen by the model are sent to your SearXNG
  service and possibly to the search engines it uses**; with a remote Ollama, the results
  are sent to that server as part of the conversation. Each search is shown in Chat
  (query, status, result count). Results are unverified web content. When off, Chat
  requests are exactly as before.
- **Precedence:** `AGENT_ENGINE` / `RESEARCH_ENGINE`, when set and valid, override the
  value saved here (see "Environment overrides" above); otherwise the saved value, else
  `legacy`. A value entered here must be exactly `legacy` or `adk`.
- **Chat:** each new message uses the saved engine; a reply that is already streaming
  finishes (or is cancelled) on the engine it started with.
- **Research:** the engine is read once when a task is created and stored with the task.
  Pause/Resume, Retry and recovery after a crash always use the task's own engine, never
  the current setting. Tasks created before engines existed are legacy tasks.

### Advanced

| Setting                     | Key                          | Default    | Env variable                    | Allowed values    | Applies            |
| --------------------------- | ---------------------------- | ---------- | ------------------------------- | ----------------- | ------------------ |
| Streaming idle timeout      | `ollama.streamIdleTimeoutMs` | 120,000 ms | `OLLAMA_STREAM_IDLE_TIMEOUT_MS` | 1,000 – 3,600,000 | immediately        |
| Model retries               | `research.modelRetries`      | 1          | `RESEARCH_MODEL_RETRIES`        | 0 – 3             | new requests/tasks |
| Tool retries                | `research.toolRetries`       | 1          | `RESEARCH_TOOL_RETRIES`         | 0 – 3             | new requests/tasks |
| Retry delay                 | `research.retryBackoffMs`    | 1,000 ms   | `RESEARCH_RETRY_BACKOFF_MS`     | 0 – 60,000        | new requests/tasks |
| Research model call timeout | `research.modelTimeoutMs`    | 300,000 ms | `RESEARCH_MODEL_TIMEOUT_MS`     | 1,000 – 900,000   | new requests/tasks |

Validation rules beyond the ranges:

- **Server URLs** (Ollama, SearXNG): `http://` or `https://` only; no user name or password,
  query (`?…`) or fragment (`#…`); `0.0.0.0` is refused (use `127.0.0.1`). A path prefix
  is allowed for reverse proxies (`https://example.com/ollama`). Without a scheme,
  `host` means `http://host:11434` and `host:port` means `http://host:port` (as Ollama's
  own `OLLAMA_HOST`); with a scheme and no port, the scheme's default port is used
  (`https://ollama.example.com` → port 443).
- **Model name:** letters, digits and `. _ : / + -` (e.g. `qwen3:8b`).
- **Require HTTPS for remote servers:** when on, a plain `http://` Ollama or SearXNG URL
  that is not on this computer is rejected.
- **Backup folder:** set only with the folder picker, never by typing a path.

## Ollama connection

**Settings → Ollama Connection**

- **Status:** Connected / Not reachable / Disconnected, the server version, the response
  time and when it was checked.
- **Test connection** tests the URL in the field, **before** saving it. Failures come
  with a hint (Ollama not running, not listening on the network, firewall, wrong port,
  not an Ollama server, redirect, missing token).
- **Save** applies the URL to new chats and tasks right away.
- **Disconnect** stops every request to Ollama until **Connect** (health checks report
  "Disconnected", chat and new research are refused, running research tasks wait as
  "Waiting for Ollama"). The app always starts connected.

### Configuring a remote Ollama server

Ollama listens only on `127.0.0.1` by default. On the **server**:

1. Make it listen on the network: set `OLLAMA_HOST=0.0.0.0:11434` (or its LAN address) for
   the Ollama service and restart Ollama.
2. Allow TCP 11434 in the server's firewall **for your network or VPN only**.
3. Pull the models there (`ollama pull qwen3:8b`).

In the app, enter `http://<server-ip>:11434`, click **Test connection**, then **Save**.
Then choose a model under AI Models.

**Recommended setups**, best first:

1. **VPN** (WireGuard, Tailscale, …): use the server's VPN address; traffic is encrypted
   by the VPN.
2. **HTTPS reverse proxy with authentication** (Caddy, nginx, Traefik) in front of Ollama:
   use `https://ollama.example.com` and set the **access token**; the app sends
   `Authorization: Bearer <token>`.
3. **Plain HTTP on a trusted LAN:** works, but prompts and answers travel unencrypted. The
   app shows a warning.

Never expose an unauthenticated Ollama port to the internet: anyone could use your GPU,
read prompts or pull and delete models.

### HTTPS tunnels (ngrok)

A company Ollama behind an HTTPS tunnel works like any HTTPS reverse proxy: enter
`https://<tunnel>.ngrok-free.dev` (no port; HTTPS uses 443). Free ngrok tunnels can answer
API clients with a browser-warning page instead of Ollama's reply. To skip it, list the
tunnel's exact host name in **`OLLAMA_NGROK_BYPASS_HOSTS`** (environment, `.env` or
`settings.env`; comma-separated host names, no scheme, port, path or wildcards). The app
then sends `ngrok-skip-browser-warning: true` **only** to those hosts and **only** over
HTTPS. It is a startup-time trust list read by the main process: it cannot be changed from
the Settings page or the renderer, and it is not stored in SQLite. Restart the app after
changing it.

A tunnel is public: anyone who knows its address can reach the server unless the tunnel
or a proxy requires authentication. Prompts and answers go to that server, so use only
endpoints your organisation operates, and prefer one that requires the access token.

### Remote connection safeguards

- URLs are validated (see above) and only the configured server is contacted; the
  renderer never makes network requests.
- **Redirects are refused** (a redirect could send prompts or the token elsewhere): enter
  the final URL.
- The **access token** is stored encrypted (below), read only by the main process, and
  sent **only over HTTPS or to this computer**. Over plain HTTP to another machine it is
  not sent, and the page says so.
- Every request has a timeout (Connection timeout, Request timeout, Streaming idle
  timeout) and clear error messages.
- No proxy settings and no arbitrary URL fetching are offered.
- The ngrok warning-bypass header is sent only to hosts in `OLLAMA_NGROK_BYPASS_HOSTS`
  over HTTPS, never globally and never after a redirect (redirects are refused).

## Model discovery

**Settings → AI Models** reads the models **from the configured server**; nothing is
hard-coded:

| Endpoint           | Used for                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `GET /api/version` | Connection test, server version, response time                                            |
| `GET /api/tags`    | Installed models: name, family, parameter size, quantization, format, size, modified date |
| `POST /api/show`   | Details: capabilities, architecture, context length, model defaults, license              |
| `POST /api/chat`   | "Test" with a sample prompt (max. 256 tokens), chat and research                          |

- **Use** makes a model active for chat and new tasks.
- If the active model is not installed on the server (for example after switching
  servers), the page says so and offers the installed models. The app **never downloads a
  model**; it shows the `ollama pull` command to run yourself.
- **Effective configuration** shows exactly what is sent with every request: server,
  model, Ollama `options` (`num_ctx`, `temperature`, `top_p`, `top_k`, `num_predict`,
  `repeat_penalty` — empty settings are not sent), timeouts, and the values research steps
  set for reliable JSON (temperature 0 and a per-step `num_predict`).

## Secrets

The only secret is the Ollama **access token**.

- Stored with Electron `safeStorage` (Windows DPAPI, tied to your Windows account) in the
  `settings` table (`secret.ollama.authToken`, `is_secret = 1`, base64 ciphertext).
- Write-only from the page: it is never sent back to the window, written to logs, or
  included in error messages; the page only shows "Set" / "Not set".
- If OS encryption is unavailable, the token is refused; it is never stored in plaintext.

## Web search

**Settings → Research & Web Search:** SearXNG URL with **Test connection** (tests the field
without saving) and its current status; search and fetch timeouts, maximum download size,
maximum extracted text and PDF pages, and research task defaults. Changes apply to the next
search or fetch without a restart; the `WebSearchProvider` abstraction is unchanged, so
other providers can be added later. No API key is involved.

## Storage

**Settings → Storage** shows the database path, connection status, size, journal mode,
last integrity check and total records, and sets the default **backup folder** (the
Save dialog still asks for every backup). The database location cannot be changed here:
moving an open database safely needs a relocation workflow this version does not have.

## Verifying with a real Ollama

`pnpm test:ollama` runs live checks against your Ollama (`OLLAMA_HOST`, `OLLAMA_MODEL`),
including `settings.live.test.ts`: connection test, model discovery, `/api/show`, runtime
option changes, streaming cancellation and snapshot isolation. Set `OLLAMA_REMOTE_HOST`
(and `OLLAMA_TOKEN` for an HTTPS proxy) to also check switching to a second server.
