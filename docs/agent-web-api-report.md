# Agent Web API — Report

## Summary

- Status: **complete** (Phases 1–3 in one pass)
- `apps/api` (`@rka/api`) is an HTTP API with OpenAPI 3.1 and Swagger UI for the
  existing agent service. It runs without Electron:

  ```text
  Browser / Postman ──HTTP──▶ apps/api ──@rka/agent-client──▶ apps/agent (loopback protocol)
  ```

  It connects to the agent through the state file and token handshake, as a `cli`
  client. The agent's TCP port and token never leave the API. It opens no database and
  never imports `electron`.

- `pnpm api:up` starts the agent and the API together. Swagger UI is at `/docs`.
- Checks: `pnpm check` passes (typecheck, lint, `format:check`, **111 test files /
  1,451 tests**, build). `pnpm api:up` was smoke-tested here, and Swagger UI was rendered
  in a headless Chromium.

## Architecture and choices

| Topic         | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | **Hono** 4.13.16 with `@hono/node-server` 2.1.5. It is small, uses Web-standard `Request`/`Response`, and has built-in SSE, CORS and body-limit helpers.                                                                                                                                                                                                                                                                                            |
| OpenAPI       | Generated from the **same Zod schemas** that validate requests. Responses reuse the `@rka/shared` DTOs, and request bodies reuse them where they exist. Zod 4's own `z.toJSONSchema` does the conversion, so no OpenAPI plugin is needed. One route table (`route.ts`) drives both the handlers and the document, so the docs cannot drift. The recursive JSON-value schema goes into `components/schemas/JsonValue`; every `$ref` resolves (test). |
| Swagger UI    | `swagger-ui-dist` 5.34.1 assets are served by the API itself (no CDN). There is no inline script, the CSP is `script-src 'self'`, and `persistAuthorization` is off, so the key typed into "Authorize" is not stored.                                                                                                                                                                                                                               |
| Agent link    | `agent-link.ts` keeps one lazily opened `cli` connection. It reconnects on the next request after the agent restarts, and it fans agent events out to SSE streams.                                                                                                                                                                                                                                                                                  |
| Dependencies  | 3 runtime dependencies (`hono`, `@hono/node-server`, `swagger-ui-dist`) at exact versions at least two weeks old. Plus the workspace packages and `zod`. `swagger-ui-dist`'s transitive `@scarf/scarf` install script (usage analytics) is **denied** in `pnpm-workspace.yaml`.                                                                                                                                                                     |
| Process model | Unchanged. The agent is still the only SQLite writer, and Electron is untouched.                                                                                                                                                                                                                                                                                                                                                                    |

## What shipped

### Phase 1: scaffold

- `apps/api`: `config.ts` (env with Zod), `agent-link.ts`, `route.ts` (route table plus
  validation), `openapi.ts`, `docs.ts` (Swagger UI), `app.ts`, `main.ts`.
- Endpoints:
  - `GET /health` (public): API liveness, `agent: connected | unavailable`.
  - `GET /agent/ping`: `system.ping` over the authenticated loopback protocol; returns
    the agent's pid, version, `protocol: 2` and round trip.
  - `GET /openapi.json`, `GET /docs`.
- Root scripts:
  - `api:dev` = `pnpm --filter @rka/api run dev`.
  - `api:up` = `pnpm --parallel --filter @rka/agent --filter @rka/api run dev`. This uses
    pnpm's own parallel runner, so no `concurrently` dependency is needed. Output is
    prefixed per app, and Ctrl+C stops both.
- **State file alignment:** `AGENT_STATE_FILE` defaults to
  `apps/agent/.agent-data/agent-state.json`, which is what `pnpm agent:dev` writes with
  its default `--data-dir`. For another folder, run both scripts yourself with matching
  `--data-dir` and `AGENT_STATE_FILE` (README). The API may start first: it connects on
  the first request.

### Phase 2: core API

| Area      | Endpoints                                                                                                                                                                                                                                                                              | Protocol                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Dashboard | `GET /tasks/counts`, `GET /tasks` (`status` repeatable, `search`, `limit`, `offset`), `GET /tasks/{id}`, `GET /tasks/{id}/logs`, `GET /sources`, `GET /sources/{id}`, `GET /reports`, `GET /reports/{id}`, `GET /model/health`, `GET /storage/status`, `POST /storage/integrity-check` | `tasks.*`, `sources.*`, `reports.*`, `model.health`, `storage.status/integrityCheck` |
| Research  | `POST /tasks/research`, `POST /tasks/{id}/pause\|resume\|cancel\|retry`                                                                                                                                                                                                                | `tasks.startResearch/pause/resume/cancel/retry`                                      |
| Chat      | `POST /chat` returns **SSE** directly: `started` {streamId, model}, then `delta` / `tool` / `done` \| `error` \| `cancelled`. `POST /chat/{streamId}/stop`.                                                                                                                            | `chat.start`, `chat.event`, `chat.stop`                                              |
| Progress  | `GET /events/research[?taskId=]`: **SSE** `progress` events                                                                                                                                                                                                                            | `ui.researchProgress`                                                                |

- **Chat in one request:** the route subscribes to agent events _before_ `chat.start`
  and buffers until the stream id is known, so no early delta is lost. A client that
  disconnects stops the reply (`chat.stop`). A 15 s keepalive comment holds SSE through
  proxies. A lost agent connection ends a stream with an `error` event
  (`agent_disconnected`).
- **Auth:** the `X-API-Key` header (or `Authorization: Bearer`), compared in constant
  time on SHA-256 digests. Only `/health`, `/docs*` and `/openapi.json` are public.
  Without `API_KEY`, a random key is generated for the run, but **only when listening on
  loopback**. A non-loopback `API_HOST` requires a chosen key of at least 24 characters.
- **Validation:** Zod on path, query and body. Messages name the path and the rule,
  never the value. Request bodies are capped at 1 MiB for JSON and 11 MiB plus overhead
  for multipart.
- **Error mapping:** every error is `{ "error": { "code", "message" } }`.

| Situation                                                                              | HTTP                                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Validation (API or agent `bad_request`)                                                | 400                                                 |
| Missing or wrong key                                                                   | 401                                                 |
| Not found (`tasks.get` etc. return `null`)                                             | 404                                                 |
| Action rejected (`TaskActionResult.rejected`), Chat `busy`                             | 409                                                 |
| Body too large                                                                         | 413                                                 |
| Upload not multipart                                                                   | 415                                                 |
| Extraction failed                                                                      | 422                                                 |
| Rate limited (with `Retry-After`)                                                      | 429                                                 |
| Agent `not_implemented` / `unknown_method` / `shell_unavailable` (`needs_desktop_app`) | 501                                                 |
| Agent `internal` / `bad_frame` / `unauthorized` (fixed message, no internals)          | 502                                                 |
| Agent not reachable (`agent_unavailable`)                                              | 503                                                 |
| Agent `timeout`                                                                        | 504                                                 |
| Anything else                                                                          | 500 `Internal error.` (details only in the API log) |

### Phase 3: Electron substitutes

| Desktop app                                                      | Web API                                                                                                                                                                                                                                                                                     | Agent (new protocol methods, `toAgent`, phase 10)                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell.chooseFile` then `researchTools.pickFile` / `extractFile` | `POST /research-tools/extract`: multipart `file`, at most **11 MiB** (`MAX_UPLOAD_BYTES`: base64 must fit one 16 MiB protocol frame) and the agent's `web.maxDownloadBytes`                                                                                                                 | `researchTools.extractUpload {requestId, name, contentBase64}`: the same `extractLocalDocument` with the same type and size checks; the name must be a file name, not a path; nothing is written                                                                                                                                |
| Save dialog then `storage.backup`                                | `POST /storage/backup`: streams the database as `attachment; filename="research-<time>.db"` with `Content-Length`                                                                                                                                                                           | `storage.createSnapshot` (SQLite `serialize()`: one consistent read, WAL content included, header switched to rollback-journal so the file opens standalone; at most 2 held, 10 min TTL, 512 MiB cap) and `storage.readSnapshot {snapshotId, offset, length ≤ 4 MiB}` (`null` when expired). **No file is written or deleted.** |
| safeStorage secrets                                              | **Out of scope.** The API's own key comes from the environment (or your secret store, through the environment). The Ollama access token stays safeStorage ciphertext that only the desktop shell decrypts: with only the API connected, the agent sends no token. Settings are not exposed. | —                                                                                                                                                                                                                                                                                                                               |

- **CORS:** an exact-origin allowlist (`API_CORS_ORIGINS`; none by default). Methods
  are GET/POST/OPTIONS, headers `Content-Type`, `X-API-Key` and `Authorization`; the
  API exposes `Content-Disposition` and `Retry-After`.
- **Rate limit:** in-memory fixed one-minute windows per client address
  (`API_RATE_LIMIT_PER_MINUTE`, default 300), returning 429 with `Retry-After`. Old
  windows are dropped beyond 10,000 keys.
- **Other hardening:** `X-Content-Type-Options: nosniff` and `Referrer-Policy:
no-referrer`. `GET /storage/status` returns the database **file name only** (the
  agent's local folder is not exposed over HTTP).
- **Documentation:**
  - README "Web API (Swagger)": run, variables, data-folder alignment, endpoint list.
  - `docs/agent-process-security.md` "Web API client".

## Files

- **New:**
  - `apps/api/{package.json,tsconfig.json,vitest.config.ts}`
  - `apps/api/src/{config,agent-link,errors,route,openapi,docs,security,app,main}.ts`
  - `apps/api/src/routes/{core,streams,files}.ts`
  - `apps/api/src/test-fixtures.ts` (test-only: a real agent plus fake Ollama/SearXNG)
  - `apps/api/src/{app,units}.test.ts`
  - `apps/agent/src/snapshots.ts`, `snapshots.test.ts`
  - this report
- **Changed:**
  - `packages/shared/src/research-tools.ts`, `index.ts`: `ToolExtractUploadRequestSchema`,
    `MAX_UPLOAD_BYTES`.
  - `packages/agent-protocol/src/methods.ts`, `index.ts`: the 3 methods and snapshot
    schemas. `PROTOCOL_VERSION` stays 2, because the change is additive.
  - `packages/agent-host/src/research-tools.ts`: `extractUpload`.
  - `apps/agent/src/handlers.ts`, `services.ts`: serve the 3 methods.
  - `apps/agent/src/{research-tools,services}.test.ts`.
  - Root `package.json` (scripts), `vitest.config.ts` (project), `eslint.config.js` (an
    `apps/api` block: no `electron`, `@rka/storage`, `@rka/agent-host`, runtimes,
    `better-sqlite3`, agent sources or desktop, except in tests), `pnpm-workspace.yaml`
    (`@scarf/scarf: false`), `pnpm-lock.yaml`.
  - `apps/desktop/src/main/security-guards.test.ts`: scans `apps/api/src` too.
  - `README.md`, `docs/agent-process-security.md`.
- **Electron app:** unchanged.

## Tests

- **`apps/api/src/app.test.ts`** (13). These go through the real Hono app, the
  `AgentLink`, the state file and handshake, and a **real agent** (`runAgent` +
  `openAgentServices`, temporary SQLite), with a fake Ollama/SearXNG. They cover:
  - Public routes and Swagger assets; 401 without a key or with a wrong key; header and
    Bearer accepted.
  - Ping (protocol 2).
  - 503 and `/health` "unavailable" when the agent is down.
  - Lists, 404, 400 on a bad query, file-name-only storage status.
  - Research: 400 on a short goal; start, then the first SSE `progress` event for the
    task; a rejected cancel gives 409.
  - Chat SSE (`started`, then deltas "Hello API", then `done`); 400 before streaming.
  - Upload: DOCX extracted, a fake PDF gives 422, JSON instead of multipart gives 415.
  - Backup download: a valid SQLite file with a matching `Content-Length`.
  - CORS allow/deny and preflight; rate limit 429 with `Retry-After`.
- **`apps/api/src/units.test.ts`** (5): config defaults (loopback, agent:dev state file,
  generated key); a key is required off loopback; short keys and bad origins are
  refused; the error-mapping table; the OpenAPI document covers every route, with
  security on all but `/health`, and every `$ref` resolves.
- **Agent:**
  - `snapshots.test.ts` (3): the serialized copy is consistent (excludes a later write),
    opens standalone with `integrity_check` ok, and is not WAL; expiry and keep-alive;
    max 2 held; size cap.
  - `research-tools.test.ts` (+3, as a `cli` client): upload extraction, refusal of
    mismatched content and of path names, chunked snapshot read and `null` for an
    unknown id.
  - `services.test.ts`: the served-method list now includes the 3 methods.

## Checks run

- `pnpm check`: **pass** (exit 0)
  - typecheck: 12 `tsc` runs including `apps/api`
  - lint: `--max-warnings=0`
  - `format:check`: clean
  - test: 111 files, 1,451 tests
  - build: desktop and agent bundles
- **`pnpm api:up` smoke** (Linux, `API_KEY` set, Ollama not running):
  - Both processes start, with output prefixed `apps/agent dev:` / `apps/api dev:`.
  - The API connects after the agent writes its state file (`Client authenticated (cli)`).
  - `GET /health` gives `{"status":"ok","agent":"connected"}`, `GET /agent/ping` gives
    protocol 2, and `/docs` gives 200.
  - Stopping removes the agent's state file.
- **Manual curl** against a separate agent and API: 401 without a key, counts, 404
  mapping, file-name-only storage status, `POST /storage/backup` (196,608 bytes starting
  with `SQLite format 3`), 23 documented paths.
- **Swagger UI in headless Chromium** (`/docs`): 23 operations rendered, **no console or
  CSP errors**.
- `pnpm peers check`: the only warnings are the existing OpenTelemetry peer ranges
  (from ADK), the same as before this change.

## Gaps compared with the Electron shell

| Desktop app has                                                          | Web API                                                                                                                                                                |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings page (`settings.*`), Ollama connect/disconnect, model list/test | Not exposed (read the effective model through `GET /model/health`). Change settings in the desktop app or through `OLLAMA_*`/`SEARXNG_URL`/… env for `pnpm agent:dev`. |
| Ollama access token (safeStorage)                                        | Not available. The agent sends no token unless a desktop shell is connected. Use a local or tokenless Ollama, or run the desktop app.                                  |
| Research Tools: web search/fetch, save test source, open URL, cancel     | Not exposed; only file extraction (upload).                                                                                                                            |
| Native dialogs (file pick, backup save, backup folder)                   | Replaced by upload and download; folder choice not applicable.                                                                                                         |
| Persistence check, agent stop                                            | Not exposed (`system.shutdown` is `shell`-only by design).                                                                                                             |
| Per-window Chat routing                                                  | One API connection carries all API chats; events are routed by `streamId`. The agent still allows **one reply at a time** (409 `busy`).                                |

## Risks / decisions

- **Anyone with the API key controls the agent** (research, chat, backup download of the
  whole database). By default the API listens on loopback only. Exposing it beyond
  loopback is an operator decision that needs a strong `API_KEY`, ideally TLS through a
  reverse proxy, and a CORS list.
- **The rate limit is per process and in memory,** keyed by socket address. Behind a
  reverse proxy every client shares one address; `X-Forwarded-For` is deliberately not
  trusted. A distributed limit is out of scope.
- **Generated dev key:** with no `API_KEY` on loopback, the key is printed once to the
  API's console. Set `API_KEY` to avoid it.
- **Backup snapshot memory:** up to 2 copies of the database in agent memory for 10
  minutes (capped at 512 MiB each). Larger databases get a clear error pointing to the
  desktop backup.
- **Upload size:** the protocol frame (16 MiB) limits uploads to 11 MiB, which is less
  than the agent's configurable maximum (up to 50 MiB). Chunked upload was left out as
  unnecessary for PDFs and DOCX in this MVP.
- **No auto-restart of the agent** (unchanged). The API reconnects by itself on the next
  request after the agent comes back.
- **Desktop and API on one agent:** possible with `AGENT_TRANSPORT=external`. Dialogs
  still appear only for the shell that asked; API requests never trigger a desktop
  dialog (`cli` client, covered by an existing agent test).
