# ADK Migration — Phase 6 Report

_Chat on Google ADK behind a feature flag. Date: 2026-11-13._

Production Chat can now run on Google ADK (`OllamaLlm`) when `AGENT_ENGINE=adk` is set. The
default is still the legacy engine, and existing installations stay on it.

**Unchanged:**

- the IPC contract, preload and renderer;
- Research, its tables and the database schema;
- the security guards;
- tools in Chat (still off).

**Parity checks:**

- For the same conversation, both engines send byte-identical HTTP requests to Ollama, and
  the renderer receives identical IPC events. Tests check this for every scenario except the
  documented differences in §14.
- In the packaged Linux app, the request log of the default build is identical to the
  baseline. A run with `AGENT_ENGINE=adk` gives a request log identical to a run with
  `AGENT_ENGINE=legacy`.

## 1. Legacy Chat architecture (before)

1. **Renderer** (`renderer/src/chat/session.ts`):
   - The conversation is kept in renderer memory.
   - `history()` sends every earlier message that completed or was cancelled and has
     non-blank text, followed by the new user message.
2. **Preload** exposes `window.api.chat.start / stop / onEvent` and validates each event
   against `ChatEventSchema`.
3. **IPC** (`main/ipc.ts`):
   - `chat:start` and `chat:stop` accept calls only from the app's own top-level frame, with
     at most one argument.
   - Closing a window cancels that window's stream.
4. **`ChatController`** (`main/chat.ts`):
   - Validates `ChatStartRequestSchema`. One generation runs at a time; a second request is
     rejected as `busy`.
   - Emits `delta` for each non-empty chunk, then `done` (and records usage in `model_usage`
     with purpose `chat`), `error` (through `toChatError`) or `cancelled`.
   - `stop`, `stopForSink` and a destroyed sink all abort the request.
5. **Generation:** `AgentRuntime.streamChat(turns, { signal })` calls
   `OllamaProvider.generateStream({ messages, think: false }, { signal })`, which sends
   `POST /api/chat` with `stream: true`.
6. **Settings:** the provider reads its configuration once per request: host, model, auth
   token, `num_ctx`, generation defaults and timeouts.

**Narrowest switch point:** the single `runtime.streamChat(...)` call inside
`ChatController.run`. Both engines take the same turns and return the same `GenerateChunk`
stream, so nothing above or below that call changes.

## 2. Chat engine abstraction

`ChatEngine` (`main/chat-engine.ts`):

```ts
interface ChatEngine {
  readonly name: 'legacy' | 'adk';
  streamChat(turns, { signal }): AsyncIterable<GenerateChunk>;
}
```

Failures are a `ModelProviderError`, or an `Error` with a message that is safe to show.

**`LegacyChatEngine`** (`legacyChatEngine`) calls `AgentRuntime.streamChat` unchanged.

**`AdkChatEngine`:**

- The desktop side, `adkChatEngine`, loads ADK on first use through `loadAdkRuntime()`,
  which sanitises the environment first.
- The core is `createAdkChatEngine` in `packages/adk-runtime/src/chat/adk-chat.ts`.
- It reuses `OllamaLlm`, which calls `OllamaProvider`; there is no second HTTP client.
- It has no orchestration layer of its own.

`ChatController` gets an optional `selectEngine`. Without it, the controller uses the legacy
engine, exactly as before.

## 3. Feature flag

| Property        | Implementation                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name and values | `agent.engine` = `"legacy"` \| `"adk"` (Zod enum), set through the `AGENT_ENGINE` variable                                                                                                                                          |
| Default         | `legacy`. No setting is migrated, so existing installations stay on legacy.                                                                                                                                                         |
| Where it is set | Installed app: `%APPDATA%\Autonomous Research Assistant\settings.env`, where `AGENT_ENGINE` is the only new key allowed besides the existing prefixes. Development: `.env`. Either: the process environment.                        |
| Validation      | Trimmed and case-insensitive. Unset or empty → legacy. Any other value → **legacy, plus a logged warning** (fail safe).                                                                                                             |
| When it is read | Once per request, in `ChatController.start()`. The engine is fixed for that request: changing the flag (or the settings) affects only later requests. Because the source is the environment, a change takes effect after a restart. |
| Observability   | The main process logs `Chat engine: legacy` / `Chat engine: adk` (or the warning) whenever the selection changes.                                                                                                                   |

**Why it is not in Settings.** A Settings-page or SQLite user setting would add a key to the
settings view that is sent to the renderer, which would change the IPC contract and the UI.
`settings.env` is part of the existing settings infrastructure (its defaults layer) and is
read only by the main process.

## 4. Stateless history conversion

Chat stays stateless, and the renderer still owns the history. For each request,
`AdkChatEngine`:

1. Creates a new `InMemorySessionService` and session. They are not shared between
   requests and are never persisted, so nothing is written to `adk_sessions` or
   `adk_events` (tested).
2. Appends each earlier turn with the **public** `sessionService.appendEvent` API, as an
   event built with ADK's own `createEvent`:
   - a user turn: author `user`, role `user`;
   - an assistant turn: author `chat` (the agent's name), role `model`.

   Roles and order are preserved, including consecutive same-role turns.

3. Passes the last user turn as the Runner's `newMessage`, so it appears exactly once.
4. Builds an `LlmAgent` with no instruction and no tools, with `disallowTransferToParent`
   and `disallowTransferToPeers` set. With no transfer targets, ADK adds no identity system
   prompt.

No private ADK internals are touched.

**Result:** the `messages` sent to Ollama equal the renderer's turns (tested with Persian,
emoji, CJK, leading and trailing whitespace, and consecutive user and assistant turns).

**One unsupported case.** ADK leaves an event whose text is exactly `""` out of the model's
context. Such a turn cannot be sent faithfully, so the ADK engine reports `unsupported`
instead of dropping it. The app's renderer never sends empty turns.

## 5. Streaming behaviour

**What is forwarded:**

- Partial ADK events → `delta` events. Only visible text parts are forwarded: thoughts are
  never shown, and empty deltas are skipped, as in legacy.
- The final event's text is never appended after streamed text. Only text beyond what was
  already streamed is sent, which covers a response that arrives only in the final event.
- If the final text does not start with the streamed text, the result is an
  `invalid-response` error; nothing is appended or duplicated.

**Completion:**

- `done` carries the same model, finish reason, completion tokens and duration as legacy.
- The `model_usage` row is identical (tested).

**Edge cases:**

- A final response that contains a tool call or response is rejected; it is never treated
  as executed.
- **Adapter fix for empty replies.** ADK used to discard an empty final response together
  with its usage. `OllamaLlm` now omits `content` for an empty reply, so ADK reports a
  usage-only event. An empty reply therefore ends with `done` and its usage, as in legacy.

## 6. Cancellation behaviour

| Case                                      | Behaviour (both engines, tested)                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Before generation                         | `cancelled` only. No usage. The ADK engine sends nothing when the signal is already aborted.                                |
| During streaming / after partial output   | Earlier deltas, then `cancelled`. Never `done` or `error`. The HTTP request to Ollama is aborted.                           |
| During network I/O (no response yet)      | `cancelled`.                                                                                                                |
| Window closed                             | The request is aborted and no further event is sent.                                                                        |
| Flag and settings changed, then cancelled | The running request keeps its engine and settings, and ends `cancelled`. The next request uses the new engine and settings. |

- ADK's `INVOCATION_ABORTED` is mapped to the existing `cancelled` event.
- In every case the controller ends idle: no leaked request, and no listener left on the
  stream.
- ADK logs **"The last event is partial, which is not expected."** after a mid-stream
  abort. It is only a log line: the partial text is never committed, appended or reported
  as complete (seen in the packaged smoke run, where the result was `cancelled`).

## 7. Configuration parity

Neither engine passes per-request generation options, so the provider applies the same
effective configuration to both. Tests check that the bytes on the wire are identical.

| Setting                                                | Legacy | ADK  | Note                                                                                       |
| ------------------------------------------------------ | ------ | ---- | ------------------------------------------------------------------------------------------ |
| Ollama host                                            | same   | same | `OllamaLlm` takes a snapshot of the provider per request.                                  |
| Model                                                  | same   | same | Never hardcoded.                                                                           |
| Auth token                                             | same   | same | Read per request (`Authorization` header identical).                                       |
| Disconnect state                                       | same   | same | The snapshot keeps `isConnected`.                                                          |
| `num_ctx`                                              | same   | same |                                                                                            |
| temperature, top_p, top_k, num_predict, repeat_penalty | same   | same | Provider defaults. `repeat_penalty` has no GenAI field, but it is applied by the provider. |
| Thinking                                               | off    | off  | `think: false`.                                                                            |
| Request, generate and stream-idle timeouts             | same   | same | Both use the provider's timeouts.                                                          |
| Settings snapshot per request                          | yes    | yes  |                                                                                            |

**Unmappable settings:** none for current Chat. If Chat ever passed per-request options
through ADK's `generateContentConfig`, `repeat_penalty` could not be expressed there.

## 8. Error mapping

| Failure                              | Chat event (both engines unless noted)                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ollama unavailable                   | `unavailable`, same message                                                                                                                                                                                      |
| Model not found                      | `model-not-found`, same message                                                                                                                                                                                  |
| Timeout (idle, after partial text)   | Deltas, then `timeout`                                                                                                                                                                                           |
| Invalid response                     | `invalid-response`                                                                                                                                                                                               |
| Failure mid-stream (`{"error":…}`)   | Deltas, then `generation-failed` with the provider's message                                                                                                                                                     |
| Unsupported configuration or content | `unsupported` (adapter codes are mapped back)                                                                                                                                                                    |
| Cancellation                         | `cancelled`                                                                                                                                                                                                      |
| ADK cannot be loaded                 | `generation-failed`: "The ADK chat engine could not be started. Set AGENT_ENGINE=legacy to use the legacy engine." The cause is not shown, no Ollama request is made, and the app does **not** switch to legacy. |
| ADK session or internal failure      | `generation-failed`: "The ADK chat engine failed (CODE)." The internal message and stack are withheld.                                                                                                           |

**How mapping works:** ADK error events are turned back into the `ModelProviderError` the
legacy path would have thrown, so `toChatError` and its redaction are unchanged.

**No retries:** nothing is retried, and nothing switches engines.

## 9. Security checks

**Earlier guards:** every Phase 1–5 guard still passes:

- ADK is imported only through the facade, and the facade allowlist is unchanged;
- prohibited classes are absent, the environment is sanitised and telemetry is off;
- `createGuardedRunner` admits only the in-memory or SQLite session service.

**Tools stay off:**

- The Chat agent has no tools, `allowToolCalls` stays off, and requests carry no `tools`.
- A model reply containing a tool call is never executed (tested).
- New guard: `packages/adk-runtime/src/chat/` must not mention tools, `RegistryTool`,
  `allowedTools`, `allowToolCalls` or `BaseTool`. No desktop file may enable
  `allowToolCalls`.

**Outcome integrity:**

- New guard: only an allowlist of modules may read model function calls or responses, or
  the raw final text (`functionCall`, `functionResponse`, `finalResponseText`). A new
  consumer must use `summarizeInvocation`.
- The Chat module only rejects tool calls. The Chat contract has no tool status, so none
  can be fabricated.

**Network:**

- During ADK Chat, `fetch` contacts only the configured Ollama server (tested).
- The packaged smoke runs connected only to 127.0.0.1.

**Bundle:** no new ADK modules. `child_process` still comes only from
`google-auth-library`, and there are no code executors, `LocalEnvironment` or MikroORM.

## 10. Automated tests

| Check                      | Result                                        |
| -------------------------- | --------------------------------------------- |
| `pnpm typecheck`           | pass                                          |
| `pnpm lint`                | pass                                          |
| `pnpm format:check`        | pass                                          |
| `pnpm test`                | pass: 64 files, 867 tests (Phase 5: 61 / 819) |
| `pnpm build`               | pass                                          |
| `pnpm package:dir` (Linux) | pass                                          |

**New test files:**

- `apps/desktop/src/main/chat-engine.integration.test.ts` (26 tests). Uses the real
  `registerIpcHandlers` → `ChatController` → engine selector → `OllamaProvider` → HTTP to a
  fake Ollama, with a temporary SQLite file, and runs each scenario through both engines:

  | Group         | Covers                                                                                                                             |
  | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
  | A             | Default legacy; unknown values fall back to legacy                                                                                 |
  | B / C / D / O | Identical events and requests; Unicode; empty deltas; no duplicate final text; single-line and empty replies; identical usage rows |
  | E / F / G     | Multi-turn history; current message once; no shared state; empty turn refused                                                      |
  | H             | Cancellation: five cases                                                                                                           |
  | I             | Not found, unavailable, idle timeout, failure mid-stream, invalid response, ADK load failure                                       |
  | J / K         | Settings parity; settings and flag captured per request; explicit rollback                                                         |
  | L / M / N / P | No tools; tool call not executed; no ADK SQLite writes; Research rows unchanged; only the Ollama host contacted                    |

- `apps/desktop/src/main/chat-engine.test.ts` (9 tests): flag parsing, the `settings.env`
  allowlist, selection at start, rejected requests select no engine, legacy delegation.
- `packages/adk-runtime/src/chat/adk-chat.test.ts` (11 tests):
  - final-only, empty and mismatched replies;
  - thinking never shown; error mapping and redaction;
  - cancellation before and after partial output;
  - history and system prompt, no tools, isolation.
- `packages/adk-runtime/src/security.test.ts`: the two new guards (§9).

## 11. Real Ollama tests

`pnpm test:chat:ollama` (new) runs `apps/desktop/src/main/chat-engine.live.test.ts`. It goes
through `ChatController` and both engines against the configured server and model, using a
temporary database. It pulls no models.

**Cases, run for each engine:**

1. A simple prompt, streamed in several deltas.
2. A multi-turn conversation supplied by the renderer: recall of the code word PELICAN.
3. Cancellation after the first delta.
4. Runtime configuration: `num_predict=8` gives finish reason `length`.
5. A missing model gives `model-not-found`.

**What is compared:** protocol behaviour (delta, then one `done`, nothing after; or
`cancelled` or `error`), never wording.

**Status: unverified against a real Ollama in this environment.** It was dry-run against a
stand-in server; 10 of 10 passed.

```powershell
cd C:\Users\zandm\Projects\Algoalliance\sample-agent
pnpm install
pnpm test:chat:ollama
pnpm test:adk:ollama   # Phase 1–5 live tests, unchanged
```

## 12. Windows Electron verification

**Linux (done).** Packaged app (Electron 44.10.1), driven through the real renderer bridge.

| Run                   | Results                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (no flag)     | Ollama request log identical to the baseline.                                                                                                         |
| `AGENT_ENGINE=legacy` | Chat completed. Multi-turn completed. Cancellation gave `cancelled`. The persistence task completed (check, generate, verify). Database integrity ok. |
| `AGENT_ENGINE=adk`    | Same results as legacy, with an identical request log.                                                                                                |

The ADK run logged `Chat engine: adk`. Both runs connected only to 127.0.0.1.

**Windows: pending.** The Node-based tests do not verify the packaged Windows app.

**Checklist for Windows:**

1. `pnpm dev`: Chat works (legacy is the default; the log shows `Chat engine: legacy`).
2. `$env:AGENT_ENGINE="adk"; pnpm dev`: the log shows `Chat engine: adk`. Check Chat,
   streaming, Stop mid-answer, and a multi-turn conversation.
3. `pnpm package:win`, install, then add `AGENT_ENGINE=adk` to
   `%APPDATA%\Autonomous Research Assistant\settings.env` and restart. Repeat step 2.
4. Change the line to `AGENT_ENGINE=legacy` (or delete it), restart, and confirm that Chat
   is back on legacy.
5. Create and run a Research task. In Storage, run the integrity check.

## 13. Files changed

**Created:**

- `packages/adk-runtime/src/chat/adk-chat.ts`
- `packages/adk-runtime/src/chat/adk-chat.test.ts`
- `apps/desktop/src/main/chat-engine.ts`
- `apps/desktop/src/main/chat-engine.test.ts`
- `apps/desktop/src/main/chat-engine.integration.test.ts`
- `apps/desktop/src/main/chat-engine.live.test.ts`
- `apps/desktop/vitest.live.config.ts`
- `docs/adk-migration-phase6-report.md`

**Modified:**

| File                                            | Change                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| `apps/desktop/src/main/chat.ts`                 | Optional `selectEngine`, captured at `start()`. |
| `apps/desktop/src/main/index.ts`                | Wires the engine selector.                      |
| `apps/desktop/src/main/security.ts`             | `AGENT_ENGINE` allowed in `settings.env`.       |
| `apps/desktop/src/main/env.ts`                  | Comment.                                        |
| `apps/desktop/vitest.config.ts`                 | Excludes live tests.                            |
| `apps/desktop/tsconfig.node.json`               | Includes the live config.                       |
| `apps/desktop/package.json`                     | `test:live` script.                             |
| `package.json`                                  | `test:chat:ollama` script.                      |
| `packages/adk-runtime/src/engine.ts`            | Exports.                                        |
| `packages/adk-runtime/src/ollama/ollama-llm.ts` | Empty reply → usage-only response.              |
| `packages/adk-runtime/src/security.test.ts`     | The two Chat guards.                            |
| `README.md`                                     | `AGENT_ENGINE` documented.                      |
| `.env.example`                                  | `AGENT_ENGINE` documented.                      |

**Unchanged:** renderer, preload, `packages/shared` (IPC contracts), Research, storage and
the schema.

**Removed:** none.

## 14. Known limitations

- **No runtime switch.** The flag lives in the environment, so switching needs a restart.
  Per-request switching is implemented and tested with an injected flag source, ready for a
  future main-process or UI setting.
- **Two differences in unreachable inputs:**
  - **Empty earlier turn.** An earlier turn with exactly empty text is reported as
    `unsupported`; legacy sends it as is. The renderer never sends one.
  - **Tool call in a Chat reply.** If Ollama returned one even though Chat offers no
    tools, ADK reports `invalid-response`. Legacy ignores the call and completes. Neither
    executes anything or reports a tool status.
- **Empty reply without usage.** If Ollama reports no token counts for an empty reply, the
  ADK `done` has null usage and finish reason `other`.
- **ADK partial-event warning.** ADK logs "The last event is partial" after a mid-stream
  cancel. Only the log line appears.
- **Per-request overhead.** ADK builds an agent, a runner and an in-memory session for each
  request (milliseconds; not benchmarked).
- **Pending verification:** live Ollama (§11) and Windows GUI (§12).

## 15. Rollback procedure

**Runtime rollback** (no code change, no data change):

1. Open `%APPDATA%\Autonomous Research Assistant\settings.env` (installed app), or `.env`
   (development).
2. Delete the `AGENT_ENGINE` line, or set `AGENT_ENGINE=legacy`. Also remove any
   `AGENT_ENGINE` variable from the system or user environment.
3. Restart the app.
4. Confirm that the main-process log shows `Chat engine: legacy`.

Nothing else is needed. Phase 6 adds no tables, no stored data and no settings rows, and
Chat history stays in the renderer.

**Code rollback:** revert the Phase 6 commit. The legacy Chat path was never modified, and
`ChatController` without `selectEngine` is exactly the legacy controller.
