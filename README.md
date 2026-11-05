# Autonomous Research & Knowledge Assistant

Windows desktop research assistant that runs entirely on a **local LLM through Ollama**.
No cloud model providers are used — prompts and documents never leave the machine.

> Status: project skeleton. The desktop shell, package boundaries and a live Ollama
> health check are in place. Agent functionality (planning, tool calling, research)
> is not implemented yet.

## Requirements

| Tool    | Version            | Check              |
| ------- | ------------------ | ------------------ |
| Node.js | 22.12+ (24 tested) | `node --version`   |
| pnpm    | 11.9+              | `pnpm --version`   |
| Ollama  | 0.40+              | `ollama --version` |
| Model   | `qwen3:8b`         | `ollama list`      |

Install the model once with `ollama pull qwen3:8b`.

## Setup

```powershell
pnpm install
copy .env.example .env      # optional: defaults already match a standard Ollama install
pnpm dev                    # opens the Electron app with hot reload
```

The first `pnpm install` (or first launch) downloads the Electron binary for your OS.

> **OneDrive:** if this folder is synced by OneDrive, consider pausing sync for
> `node_modules`, `out` and `.pnpm-store` (or moving the project outside OneDrive).
> Syncing tens of thousands of dependency files is slow and can lock files mid-install.

## Scripts

Run from the repository root:

| Script              | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `pnpm dev`          | Start the desktop app in development mode (hot reload)                |
| `pnpm build`        | Production build of main, preload and renderer to `apps/desktop/out`  |
| `pnpm preview`      | Run the production build locally                                      |
| `pnpm typecheck`    | Strict TypeScript check of every package (`tsc` + `vue-tsc`)          |
| `pnpm lint`         | ESLint, including architecture boundary rules (zero warnings allowed) |
| `pnpm lint:fix`     | ESLint with auto-fix                                                  |
| `pnpm format`       | Format with Prettier                                                  |
| `pnpm format:check` | Verify formatting                                                     |
| `pnpm test`         | Run all Vitest projects once                                          |
| `pnpm test:watch`   | Vitest in watch mode                                                  |
| `pnpm check`        | typecheck → lint → format:check → test → build                        |

Run a single package's checks with a filter, e.g. `pnpm --filter @rka/tools test`.

## Structure

```text
apps/
  desktop/                Electron app (@rka/desktop)
    src/main/             Main process: window, IPC handlers, runtime wiring
    src/preload/          Preload bridge: exposes window.api (sandboxed, CommonJS)
    src/renderer/         Vue 3 UI (browser code only)
packages/
  shared/                 @rka/shared         Zod schemas, domain types, IPC contract, Result
  model-provider/         @rka/model-provider ModelProvider interface + Ollama implementation
  tools/                  @rka/tools          Tool contract + registry, web research tools
  storage/                @rka/storage        SQLite (better-sqlite3 + Drizzle): migrations, repositories, recovery
  agent-runtime/          @rka/agent-runtime  Composition root for the agent (no loop yet)
```

### Package boundaries

```text
             ┌──────────────── @rka/shared ────────────────┐
             │                    ▲                         │
   @rka/model-provider      @rka/tools               @rka/storage
             ▲                    ▲                         ▲
             └────────────── @rka/agent-runtime ────────────┘
                                  ▲
                    apps/desktop  src/main   (Electron main process)
                    apps/desktop  src/preload  → @rka/shared only
                    apps/desktop  src/renderer → @rka/shared only (types)
```

- Each package exposes exactly one entry point (`exports["."]` → `src/index.ts`).
  Deep imports such as `@rka/tools/src/registry` are rejected by ESLint.
- `@rka/shared` is platform-neutral: no Node.js, no Electron, no other workspace packages.
- `model-provider`, `tools` and `storage` depend only on `@rka/shared`.
- No workspace package may import `electron`; only `apps/desktop` touches Electron.
- Packages are consumed as TypeScript source and bundled by electron-vite, so there is
  no separate package build step. The desktop app lists everything under
  `devDependencies` because all runtime code is bundled into `out/`.

These rules are enforced by `no-restricted-imports` in `eslint.config.js`, so
`pnpm lint` fails on a boundary violation.

## Model provider

`@rka/model-provider` defines a provider-agnostic `ModelProvider` interface and one
implementation, `OllamaProvider`, which talks to Ollama's local HTTP API
(`/api/chat`, `/api/tags`, `/api/version`). No cloud providers exist in the codebase.

```ts
const ollama = createOllamaProvider(loadOllamaConfig(process.env));

await ollama.checkHealth();                    // ready | model-missing | unreachable
await ollama.checkModel('qwen3:8b');           // { available, model: { capabilities, … } }
await ollama.generate({ messages }, { signal, timeoutMs });
for await (const chunk of ollama.generateStream({ messages }, { signal })) { … }
await generateObject(ollama, { messages }, zodSchema); // JSON-schema constrained + Zod-validated
```

- Requests, server responses (including every stream line) and structured output are
  validated with Zod.
- Every failure is a `ModelProviderError` with a `code`: `unavailable`, `model-not-found`,
  `invalid-request`, `invalid-response`, `timeout`, `cancelled`, `http-error`, `unsupported`.
- Cancellation: pass an `AbortSignal`, or stop iterating a stream; the HTTP request is
  aborted either way. Timeouts are reported separately from cancellation.
- Thinking is off by default (`think: false`) so tool and JSON calls stay clean.
- Only the Electron main process uses the provider. The renderer sees health data via
  IPC; a test enforces that renderer code has no network calls and CSP is `connect-src 'self'`.

Tests: unit tests (mocked fetch), integration tests (real HTTP against a local fake
Ollama server: streaming, cancellation, timeouts, connection refused), and live tests
against your Ollama with `pnpm test:ollama`.

## Chat playground

The main window has a chat playground for testing the local model: streaming replies,
Stop, Clear chat, and the conversation kept for the session (Enter sends, Shift+Enter
adds a new line). The model status panel sits beside it.

```text
ChatPanel.vue → chat/session.ts → window.api.chat (preload)
  → IPC chat:start / chat:stop (validated in main) → ChatController (main)
  → runtime.streamChat() → OllamaProvider.generateStream()
  ← chat:event (delta | done | error | cancelled), validated in the preload
```

- One generation at a time; closing the window cancels it.
- Model output is rendered as plain text (no HTML).
- Errors (Ollama down, model missing, timeout, generation failure) are shown with a fix.

## Storage

Local SQLite database at `%APPDATA%\Autonomous Research Assistant\data\research.db`
(better-sqlite3 + Drizzle ORM). Tables: tasks, task_steps, sources, source_contents,
reports, model_usage, settings, approvals. Full reference: [packages/storage/SCHEMA.md](packages/storage/SCHEMA.md).

- Migrations are generated from `packages/storage/src/schema.ts`:
  `pnpm --filter @rka/storage db:generate`, then applied automatically at startup.
- Tasks that were running when the app stopped are marked `interrupted` on the next
  start; completed steps are never executed again.
- Secrets are encrypted with Windows DPAPI (Electron `safeStorage`), never stored in plaintext.
- better-sqlite3 ships prebuilt Node-API binaries, so no C++ toolchain or
  `electron-rebuild` is needed. The same binary works in Node (tests) and Electron.

## Dashboard

The sidebar has five sections: **Chat**, **Tasks**, **Knowledge Base**, **Reports** and **Storage**.
Every number and record shown comes from the SQLite database through IPC. Nothing is mocked
and nothing is kept only in the frontend.

```text
pages/*.vue → window.api.{tasks,knowledge,reports,storage} (preload, response re-validated)
  → IPC tasks:* / sources:* / reports:* / storage:* (sender + Zod-validated in main)
  → DashboardService (main) → storage.inspect / repositories, runtime.tasks
```

- **Tasks:**
  - Status counts; filter and search; a paginated table.
  - Task details: input, output, error, token usage, and a step timeline with full inputs and outputs.
  - Interrupted tasks show their recovery status. **Resume** is offered only when an executor
    exists for the task type. Nothing resumes automatically.
- **Persistence check:** a real three-step diagnostic task that checks the model, asks it one
  question, and reads the stored answer back from SQLite with its checksum. Use it to verify
  that tasks survive closing the app. It is the only task executor until the research agent exists.
- **Knowledge Base:**
  - Sources grouped by task, with search and an extraction filter.
  - Source metadata is shown separately from the extracted text, which is marked as untrusted.
- **Reports:**
  - Markdown rendered with `markdown-it` (raw HTML disabled; only http(s) links; images not loaded).
  - Cited sources are listed in the report's order.
- **Storage:**
  - File path, size, SQLite version, journal mode, migrations and row counts. Setting values
    and secrets are never shown.
  - A manual `PRAGMA integrity_check`.
  - Backup to a file you choose. The native save dialog asks before replacing a file, and the
    copy is verified before it is moved into place.

Chat history is **not** persisted yet. It lives in the window for the session only.

## Web research tools

`@rka/tools` defines the tool contract and the first two research tools. Every tool declares:

- a name and a description
- an input schema and an output schema (Zod; both are also sent to the model as JSON Schema)
- a timeout and permissions: network, filesystem, effects, and whether approval is required

`registry.execute()` handles every call:

1. Validates the input.
2. Refuses tools that need approval unless an approval is given.
3. Enforces the timeout, even if a tool ignores its abort signal.
4. Validates the output.

Tools never receive the registry, so a tool cannot call another tool.

| Tool           | Network                | Effects                    | Timeout |
| -------------- | ---------------------- | -------------------------- | ------- |
| `web_search`   | the configured SearXNG | read-only                  | 30 s    |
| `fetch_source` | public web only        | saves a source of the task | 60 s    |

- **Search:** `WebSearchProvider` is an interface with one implementation: [SearXNG](https://docs.searxng.org),
  a free, self-hosted metasearch engine that needs no API key. Set `SEARXNG_URL` (see `.env.example`).
  Without it, `web_search` is not offered.
- **Fetching:** `fetch_source` downloads a page, extracts its text and stores it with its metadata
  in SQLite. It returns the source id and a 1,500-character excerpt; the full text stays in the
  Knowledge Base.
  - Supported formats: HTML (htmlparser2), PDF (pdf.js via unpdf), DOCX (fflate + XML) and plain text.
  - Images, executables, archives, scripts and other types are refused.
- **Duplicates:** URLs are canonicalised before they are stored: lower-case host, no default port,
  no fragment, no tracking parameters, sorted query. A URL already saved for the task is not
  fetched again. After fetching, the final URL, every redirect hop and the text's SHA-256 are
  checked, so a mirror or http/https copy of a saved page is reported as a duplicate.

### Research Tools page

**Research Tools** in the sidebar runs the agent's tools by hand, before the agent exists:

- **Web Search**
  - Shows the SearXNG status (ready, unavailable or not configured).
  - Runs the real `web_search` tool and lists results with position, title, URL and snippet,
    plus the time taken.
  - Each result can be opened in the default browser, or fetched straight into the next tab.
- **Web Fetch & Extraction**
  - Uses the same SSRF-protected fetcher as `fetch_source`.
  - Shows the HTTP status, content type, title, sizes, SHA-256 hashes, download and
    extraction times, metadata, and the extracted text (as plain text, marked untrusted).
  - **Save as test source** stores the page in the _Research tools playground_ task, with
    duplicate detection. Nothing is saved otherwise.
- **Local File Extraction**
  - Choose a PDF or DOCX in a native dialog. The main process reads it into memory and
    extracts it; it is never saved, and the page only sees the file name and size.
  - The file must match its extension (a renamed executable is refused), and the
    `WEB_MAX_DOWNLOAD_BYTES` limit applies.

The page reaches these tools only through nine fixed IPC calls, and every request and
response is validated with Zod. There is no generic fetch, and file paths never come from
the renderer. Only URLs that came from a search result or fetch can be opened in the
browser. Pending requests can be cancelled.

### Web security

- **Protocols:** only `http`/`https`. No credentials in URLs; ports 80, 443, 8080 and 8443 only.
- **SSRF:** localhost and internal names are refused, including `*.local`, `*.internal`,
  `metadata.google.internal` and single-label names. Every DNS answer is checked; if **any**
  address is loopback, private, link-local, CGNAT, multicast, reserved, or a cloud metadata
  address (169.254.169.254, fd00:ec2::254, 100.100.100.200, 168.63.129.16), the request is
  refused. The same applies to IPv4 addresses embedded in IPv6 (mapped, NAT64, 6to4, Teredo),
  and to decimal, hex, octal and short IP notations.
- **DNS rebinding:** the socket connects to the IP address that was validated. TLS still
  verifies the certificate against the original host name.
- **Redirects:** followed manually (at most 5), and every hop is validated again. Downgrades
  from https to http are refused.
- **Limits:**
  - A deadline for each request.
  - Download size limit, applied to the declared length, while streaming, and after
    decompression (so gzip bombs stop at the limit).
  - Per-part ZIP size limit for DOCX.
  - Page and character limits for PDF.
- **Nothing downloaded is executed or saved as a file.** Parsing happens in memory.
  - HTML scripts, styles and iframes are dropped, never run.
  - pdf.js runs with scripting and XFA off, in a build with no eval.
  - DOCX macros and external links are never read.
- **Untrusted content:**
  - Page text is returned as data and marked `untrusted: true`.
  - Hidden HTML text (a common prompt-injection carrier) is dropped, and invisible Unicode
    control characters are stripped.
  - `wrapUntrusted()` fences text for prompts.
  - Tool calls only come from the model's structured output, never from page text.
- **Local files:** no tool takes a file path. Only the user-configured SearXNG origin may be
  private, and only the search client can reach it; `fetch_source` cannot.
- **Proxies:** connections are direct, so an HTTP proxy is not used.

## Autonomous research

**Tasks → New research** starts the first end-to-end research workflow. It uses the local
Ollama model and the web tools only; no cloud model is involved.

```text
plan → search (per question) → choose sources → read source + extract evidence (per source)
     → compare findings → write report → review for unsupported claims → save
```

- **Persisted steps:** every step is saved with its output before the next one starts. Later
  steps are added from earlier outputs: the plan decides the searches, and the chosen
  sources decide the reads. Pause, crashes and restarts continue at the first unfinished
  step; completed steps never run again.
- **Limits:**
  - Questions (1–6, default 3) and queries per question.
  - Sources (1–12, default 6), with characters per source and claims per source.
  - Total steps (default 40).
  - Model timeout, and retry counts for model and tool calls.
- **Validation:** all model output is JSON validated with Zod. Invalid output is retried
  once, with the error fed back to the model.
- **Grounding:**
  - Each claim must come with an exact quote from the stored source text. Claims whose
    quote is not found are dropped.
  - Evidence ids are assigned by the app; any id the model invents is removed.
  - The Markdown, including the numbered citations and source list, is rendered by the
    app from verified evidence, and the reports repository refuses unknown source ids.
- **Review step:**
  - Paragraphs without valid evidence are removed and listed under _Review notes_.
  - The model checks the remaining paragraphs against the quotes of the evidence they cite.
  - Partly supported, unverified and low-certainty statements are marked in the text.
- **Untrusted content:** web text only reaches the model inside fenced untrusted blocks,
  and hidden HTML text is dropped during extraction.
- **UI:** the task page shows the goal, status, current step, progress (pushed by progress
  events), discovered sources and the final report, with **Pause**, **Resume** and **Stop**.

Manual test with a real model: [docs/manual-testing-research-agent.md](docs/manual-testing-research-agent.md).

## Security model

- Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`. It has no `require`, `process` or `ipcRenderer`.
- The preload script exposes a frozen `window.api` with a fixed set of typed functions
  (`RendererApi` in `@rka/shared`). There is no generic `invoke`.
- Every IPC handler verifies the sender is our own page, and validates its response with
  Zod. The preload validates it again before handing it to the renderer.
- Strict Content-Security-Policy; navigation away from the app and new windows are
  blocked; browser permission requests are denied; `<webview>` is disabled.
- Only the main process talks to Ollama. The renderer never makes network requests.

## Configuration

Settings come from environment variables. In development the app also reads `.env`
(from `apps/desktop/` or the repository root); real environment variables take
precedence. See `.env.example`:

| Variable                    | Default           | Notes                                       |
| --------------------------- | ----------------- | ------------------------------------------- |
| `OLLAMA_HOST`               | `127.0.0.1:11434` | Same variable the Ollama CLI uses           |
| `OLLAMA_MODEL`              | `qwen3:8b`        | Must support tool calling                   |
| `OLLAMA_NUM_CTX`            | `4096`            | Larger values use more VRAM                 |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `5000`            | Health check timeout                        |
| `SEARXNG_URL`               | (empty)           | SearXNG base URL; empty disables web search |
| `SEARXNG_SAFESEARCH`        | `1`               | 0 off, 1 moderate, 2 strict                 |
| `WEB_FETCH_TIMEOUT_MS`      | `20000`           | Deadline per page download                  |
| `WEB_SEARCH_TIMEOUT_MS`     | `15000`           | Deadline per search                         |
| `WEB_MAX_DOWNLOAD_BYTES`    | `15728640`        | Larger downloads are refused                |

No API keys are required or supported.

## Troubleshooting

**"Ollama unreachable" while Ollama is running.** Use `127.0.0.1`, not `localhost`.
On Windows `localhost` can resolve to IPv6 `::1`, where Ollama does not listen by
default. The app defaults to `127.0.0.1`.

**"Model not installed".** Run `ollama pull qwen3:8b`, or set `OLLAMA_MODEL` to an
installed model that supports tools (`ollama show <model>` lists capabilities).

**Web search fails with 403.** SearXNG only serves HTML by default. Add `json` to
`search.formats` in its `settings.yml` and restart it.

**`ERR_PNPM_IGNORED_BUILDS`.** pnpm 11 blocks dependency build scripts by default.
Only `electron` is allowed, in `pnpm-workspace.yaml`.

## Environment check

`env-check.ps1` is a read-only script that reports tool versions, GPU/VRAM and Ollama
status, and runs small generation, tool-calling and structured-output tests:

```powershell
powershell -ExecutionPolicy Bypass -File .\env-check.ps1
```
