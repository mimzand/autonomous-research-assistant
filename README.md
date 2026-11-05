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
  tools/                  @rka/tools          Tool contract + validated registry
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

| Variable                    | Default           | Notes                             |
| --------------------------- | ----------------- | --------------------------------- |
| `OLLAMA_HOST`               | `127.0.0.1:11434` | Same variable the Ollama CLI uses |
| `OLLAMA_MODEL`              | `qwen3:8b`        | Must support tool calling         |
| `OLLAMA_NUM_CTX`            | `4096`            | Larger values use more VRAM       |
| `OLLAMA_REQUEST_TIMEOUT_MS` | `5000`            | Health check timeout              |

No API keys are required or supported.

## Troubleshooting

**"Ollama unreachable" while Ollama is running.** Use `127.0.0.1`, not `localhost`.
On Windows `localhost` can resolve to IPv6 `::1`, where Ollama does not listen by
default. The app defaults to `127.0.0.1`.

**"Model not installed".** Run `ollama pull qwen3:8b`, or set `OLLAMA_MODEL` to an
installed model that supports tools (`ollama show <model>` lists capabilities).

**`ERR_PNPM_IGNORED_BUILDS`.** pnpm 11 blocks dependency build scripts by default.
Only `electron` is allowed, in `pnpm-workspace.yaml`.

## Environment check

`env-check.ps1` is a read-only script that reports tool versions, GPU/VRAM and Ollama
status, and runs small generation, tool-calling and structured-output tests:

```powershell
powershell -ExecutionPolicy Bypass -File .\env-check.ps1
```
