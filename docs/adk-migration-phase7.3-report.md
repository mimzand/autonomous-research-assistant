# Phase 7.3 — Safe Remote Ollama Integration

Scope: run the existing Legacy and ADK engines against a company-hosted Ollama behind an
HTTPS tunnel (ngrok), reusing `OllamaProvider`. No inference was run: no local Ollama, no
remote endpoint, no benchmark live mode. All new tests use scripted `fetch` mocks.

## 1. Audit findings — what already existed

| Area                     | Existing behaviour (unchanged)                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport                | One transport: `OllamaProvider.request()` (`packages/model-provider/src/ollama/provider.ts`). Both engines use it (ADK through `OllamaLlm` over a provider snapshot).                                      |
| Remote URLs              | `ollama.baseUrl` accepts `http(s)://` with path prefix; validated in main (`serverUrlProblem`); renderer only submits settings over validated IPC.                                                         |
| HTTPS policy             | `security.requireHttpsForRemote` + `violatesHttpsPolicy`; connection advice in Settings.                                                                                                                   |
| Credentials              | `ollama.authToken` encrypted (safeStorage), sent as Bearer **only over HTTPS or loopback**.                                                                                                                |
| Redirects                | `redirect: 'manual'`; any 3xx → `http-error` "Redirects are not followed". Nothing (headers, prompt, token) is ever re-sent to a `Location`.                                                               |
| Thinking                 | Provider sends `think: req.think ?? false`; Chat (both engines) and Research explicitly request no thinking. Thinking text is kept separate from content; Chat UI and ADK chat/structured readers drop it. |
| Empty / truncated output | Empty content → Chat `done` with no deltas; Research → `invalid-response` "Model did not return valid JSON (got: "")." → retry. `done_reason: length` → `finishReason: 'length'`.                          |
| Timeouts / cancellation  | `requestTimeoutMs` (metadata), `generateTimeoutMs`, `streamIdleTimeoutMs`; AbortSignal → `cancelled`.                                                                                                      |
| Structured output        | `format` JSON schema, gated by `/api/version`.                                                                                                                                                             |
| Non-Ollama replies       | HTML / non-JSON body → `invalid-response`, never treated as an answer.                                                                                                                                     |
| Model not found          | 404 "model … not found" → `model-not-found`; nothing is pulled.                                                                                                                                            |

**Gaps found**

1. `resolveOllamaBaseUrl` (env path: `OLLAMA_HOST`) turned `https://host` into
   `https://host:11434` and dropped path prefixes. A tunnel or reverse proxy on 443 could
   not be configured through the environment. (The Settings page already kept them.)
2. No way to send `ngrok-skip-browser-warning`, so a free ngrok tunnel may answer with an
   HTML interstitial (reported as `invalid-response`).

Everything else in the requested list was already present and is now covered by tests.

## 2. Changes (minimal)

| File                                                | Change                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/model-provider/src/config.ts`             | `resolveOllamaBaseUrl`: `https://` without port → port 443 (as the Ollama CLI), explicit ports and path prefixes kept; bare host / `http://` without port unchanged (`:11434`). New `OLLAMA_NGROK_BYPASS_HOSTS_ENV`, `parseNgrokBypassHosts` (exact DNS host names only; rejects schemes, ports, paths, wildcards, IPs, `localhost`), `ollamaTransportOptionsFromEnv`. |
| `packages/model-provider/src/ollama/provider.ts`    | Option `ngrokBypassHosts` (main process only). Header added in the single `request()` only when `sendsNgrokBypass(baseUrl, hosts)`: HTTPS **and** exact host match. Snapshots inherit the option.                                                                                                                                                                      |
| `packages/model-provider/src/index.ts`              | Exports the helpers.                                                                                                                                                                                                                                                                                                                                                   |
| `apps/desktop/src/main/index.ts`                    | Reads the list from the environment at startup, logs only the count (and count of invalid entries — no host names), passes it to the provider.                                                                                                                                                                                                                         |
| `apps/desktop/src/bench/{runner,main}.ts`           | Live mode only passes the same transport option (fake mode unchanged).                                                                                                                                                                                                                                                                                                 |
| `*.live.test.ts` (7 files)                          | Pass the same option, so a later approved remote test behaves like the app. Not run.                                                                                                                                                                                                                                                                                   |
| `packages/model-provider/src/config.test.ts`        | Updated/added URL cases (the old `https://… → :11434` expectation was the bug).                                                                                                                                                                                                                                                                                        |
| `packages/model-provider/src/ollama/remote.test.ts` | New (13 tests).                                                                                                                                                                                                                                                                                                                                                        |
| `apps/desktop/src/main/remote-ollama.test.ts`       | New (5 tests): Legacy/ADK parity through the app wiring.                                                                                                                                                                                                                                                                                                               |
| `.env.example`, `README.md`, `docs/settings.md`     | Documented `OLLAMA_NGROK_BYPASS_HOSTS` with a placeholder host.                                                                                                                                                                                                                                                                                                        |

Not changed: Research step machine, engine defaults (`legacy`/`legacy`), engine pinning,
migrations, model-driven tools (still off), ADK persistent sessions (still off), IPC,
renderer, Settings schema. No dependency added. No second transport.

**Why the trust list is an environment variable, not a Setting:** it is a security
allowlist for a vendor-specific header, read once by the main process. Keeping it out of
SQLite and the Settings page means a renderer (or a compromised page) cannot add hosts. It
is not a mutable runtime setting; the endpoint itself (`ollama.baseUrl`) stays a normal
Setting.

**Thinking:** not made newly configurable. Chat and Research deliberately send
`think: false` (Research JSON must fit the `num_predict` budgets; the Chat UI shows
content only); the remote endpoint was verified with `think: false`. The provider and the
ADK mapping already accept a per-request `think`, so a later phase can expose it per
purpose without transport changes. Thinking is not silently disabled for other callers.

## 3. Configuration (PowerShell)

Development (`pnpm dev`), current shell only:

```powershell
$env:OLLAMA_HOST = "https://<your-tunnel>.ngrok-free.dev"
$env:OLLAMA_MODEL = "qwen3.5:9b-mlx"
$env:OLLAMA_NGROK_BYPASS_HOSTS = "<your-tunnel>.ngrok-free.dev"
pnpm dev
```

Installed app — `%APPDATA%\Autonomous Research Assistant\settings.env`:

```powershell
$f = Join-Path $env:APPDATA "Autonomous Research Assistant\settings.env"
Add-Content $f "OLLAMA_NGROK_BYPASS_HOSTS=<your-tunnel>.ngrok-free.dev"
```

Then set the server URL in **Settings → Ollama Connection** (`https://<your-tunnel>.ngrok-free.dev`,
no port), Test connection, Save, and choose the model under AI Models. Note: a saved
Settings value wins over `OLLAMA_HOST`. Set the access token there if the endpoint
requires one. Restart the app after changing `OLLAMA_NGROK_BYPASS_HOSTS`. Switch back to
local Ollama by entering `http://127.0.0.1:11434` (the header is never sent there).

## 4. Tests and results

| Check                                        | Result                                   |
| -------------------------------------------- | ---------------------------------------- |
| `pnpm typecheck`                             | pass                                     |
| `pnpm lint`                                  | pass                                     |
| `pnpm format:check`                          | pass                                     |
| `pnpm test`                                  | **71 files, 965 tests passed** (was 939) |
| `pnpm build`                                 | pass                                     |
| Focused: `config.test.ts` + `remote.test.ts` | 37 passed                                |
| Focused: `remote-ollama.test.ts`             | 5 passed                                 |
| Live tests / benchmark live / any inference  | **not run** (per safety restrictions)    |

Coverage by requirement:

- **Local vs remote selection:** default `http://127.0.0.1:11434`; `https://tunnel` kept without port; path prefixes; explicit ports.
- **HTTPS URL validation:** `resolveOllamaBaseUrl` cases; `parseNgrokBypassHosts` rejects `https://…`, `:443`, `*.…`, paths, IPv4/IPv6, `localhost`, invalid labels.
- **Trusted-host-only header:** sent on health, tags, chat (stream / non-stream), version and structured-output calls to the listed HTTPS host; not sent to local Ollama, an unlisted tunnel, the listed host over HTTP, a look-alike suffix host, or with an empty list; reconfiguring to another host stops it while an earlier snapshot keeps its own rule.
- **Redirect leakage:** a 307 to another host → `http-error`, exactly one request, other host never contacted (header, prompt and token stay put). Token still HTTPS/loopback-only.
- **Model not found:** `model-not-found` (provider, and both Chat engines identically).
- **Thinking-only / empty content:** provider result `content: ''` without `thinking`; stream keeps thinking separate; Chat shows nothing and completes (`done` only) on both engines; Research gets `invalid-response` on both engines; `think: false` sent.
- **`done_reason=length`:** `finishReason: 'length'` streaming and non-streaming; identical Chat events on both engines.
- **Streaming and non-streaming:** both paths exercised over the remote base.
- **AbortSignal / timeout / cancellation:** `cancelled` and `timeout` errors against a hanging remote.
- **Structured output:** `format` schema + version check through the tunnel with the header; validated object on both engines.
- **Legacy/ADK parity:** identical request lists (URL, all headers incl. ngrok and Bearer, bodies) and identical events/results for Chat and Research.
- **HTML interstitial:** reported as `invalid-response`, never as an answer.

## 5. Remaining risks and limitations

- **No real remote call was made.** Behaviour against the actual tunnel is unverified until the approved acceptance test.
- **`wolverine-porridge-mutilated` endpoint:** its model list needs investigation; not assumed to work. The tags parser rejects malformed lists with `invalid-response`.
- **Data leaves the machine:** with a remote endpoint, prompts, fetched page text and reports go to that server. Free ngrok tunnels are public URLs; without a token or tunnel auth anyone with the URL can use the server. Prefer an endpoint that requires the access token.
- **Behaviour change:** `OLLAMA_HOST=https://host` now means port 443 (previously 11434). An env-configured HTTPS server actually on 11434 must now say `https://host:11434`. Settings-saved URLs are unaffected.
- **Thinking is not user-configurable** (by design, see §2). A model that ignores `think: false` and spends its budget on thinking yields empty content → Chat shows an empty reply; Research retries and can fail with `invalid-response`.
- **Latency:** remote round-trips plus tunnel overhead; existing timeouts (generate 300 s, stream idle 120 s, metadata 5 s) may need adjustment for a slow tunnel — `requestTimeoutMs` 5 s is tight for a free tunnel's health check.
- **ngrok changes:** the header name is ngrok-specific and could change; free-tier rate limits may produce HTTP errors (reported as `http-error`).
- **Trust list requires restart** and is not visible in the Settings page (only the count is logged).

## 6. Manual acceptance checklist (later, only with explicit approval)

Run on a machine you choose, with a non-sensitive prompt; do not use project data.

1. Confirm the endpoint owner approves the test and the model is pulled there (`/api/tags` lists `qwen3.5:9b-mlx`).
2. Configure as in §3 (env or `settings.env` + Settings URL); restart; check the log says "ngrok browser-warning bypass enabled for 1 trusted host(s)".
3. Settings → **Test connection**: reachable, version shown, model listed, no HTML/invalid-response.
4. Chat (`AGENT_ENGINE=legacy`): send "Reply with OK." → streamed answer, `done`, usage recorded.
5. Chat (`AGENT_ENGINE=adk`): same prompt → same behaviour.
6. Stop a long Chat answer mid-stream → `cancelled`, no error.
7. Optional, small: one Research task (`maxQuestions 1`, `maxSources 2`) on each engine with a harmless public topic → completes, report cites only fetched sources.
8. Negative check: remove the host from `OLLAMA_NGROK_BYPASS_HOSTS`, restart → header not sent (an interstitial, if ngrok shows one, is reported as an invalid response, not shown as an answer).
9. Switch back to `http://127.0.0.1:11434` only if local inference is approved; otherwise leave the remote URL configured.
10. Record results; do not run the benchmark live mode or the `*:ollama` test scripts without separate approval.
