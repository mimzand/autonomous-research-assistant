# Agent Process Separation — Phase 4 Report

## Summary

- Status: **complete**. Chat start, stop and streaming work end to end in service mode.
- With `AGENT_TRANSPORT=service`, Chat runs in the agent's `ChatController`.
  - The agent serves `chat.start` and `chat.stop`.
  - It pushes every reply event to the shell as a protocol `chat.event` envelope (direction `toShell`).
  - It records Chat model usage in its own database.
- Electron main proxies `chat:start` and `chat:stop` to the agent. It fans incoming `chat.event`s out to the window that started each stream through the same `webContents.send('chat:event', …)` path as in-process.
- `model:get-health` is also proxied, so the Chat page shows the model name and ready state. `model.health` is served early: the registry lists it as Phase 7, but it reuses `runtime.getModelHealth` unchanged.
- The default `inprocess` mode is unchanged: the code paths in `ipc.ts` and `chat-controller.ts` were not edited.

## Changes

**Server and agent (`apps/agent`)**

- `handlers.ts`
  - Handlers now receive `(params, connection)`. `AgentConnection` exposes the connection `id`, whether it is `closed`, and a typed `emit(method, payload)`.
  - `connectionChatSink(connection)` adapts a connection to the controller's `ChatEventSink`. The sink id is the connection id, so one connection is one sink, like one window in-process.
  - `chatHandlers(chat, runtime)` serves `chat.start`, `chat.stop` and `model.health`.
- `server.ts`
  - Every connection gets a numeric id.
  - `emit` validates the outgoing envelope with `parseEvent(…, 'toShell')`. An invalid event is logged as `Refusing to send an invalid <method> event.` and dropped.
  - New option `onDisconnect(connectionId)` runs once when an authenticated connection closes. Its failures are logged, never thrown.
- `run.ts`: `AgentServiceSet.onDisconnect?` is passed through to the server.
- `services.ts`
  - The host gets `onChatUsage`, which writes `storage.modelUsage.record({ provider: 'ollama', purpose: 'chat', … })`. This is the same record the desktop's in-process `chatUsageRecorder` writes. The desktop recorder is not used in service mode.
  - Handlers are now the dashboard handlers plus the chat handlers.
  - `onDisconnect` calls `host.chat.stopForSink(id)`.
  - `whenChatIdle()` is added for tests and shutdown.

**Client (`@rka/agent-client`)**

- `onEvent(listener)` returns an unsubscribe function.
- Every pushed `event` frame goes through `parseEvent(…, 'toShell')`. Invalid or unknown events are dropped before any listener sees them.
- A throwing listener is isolated (logged) so it cannot break the socket's data loop or the other listeners.

**Electron (`apps/desktop/src/main`)**

- `service-chat.ts` (new) provides `createServiceChat({ client, log })`:
  - **start** validates locally with `ChatStartRequestSchema`. An invalid request returns the same `{ status: 'rejected', code: 'invalid-request', message }` as the in-process controller, without a round trip. A valid request is sent as `chat.start`, and the result is validated with `ChatStartResultSchema`. When the agent answers `started`, the stream id is mapped to the starting window.
  - **Early events:** events for an unknown stream id are held while a start is pending, at most 256. The agent's first events can be decoded in the same TCP chunk as the `chat.start` reply, before the reply's continuation runs. The buffer is flushed in order once the stream id is known, and cleared when no start is pending.
  - **Routing:** events go only to the owning window. A terminal event (`done`, `error` or `cancelled`) removes the stream; later events for it are ignored.
  - **stop** validates with `ChatStopRequestSchema`, so malformed input throws as in-process. It then forwards `chat.stop`.
  - **Window close:** each sender is watched once. When the window is destroyed, `chat.stop` is sent for its streams; this mirrors `stopForSink`. If an event finds its window already destroyed, the stream is also stopped.
  - **Agent lost:** each open stream receives `{ type: 'error', code: 'unavailable', message: 'The agent service disconnected. Restart the app to use Chat.' }`, so the Chat page leaves its "generating" state.
  - Failed background stops are logged, not thrown.
- `service-ipc.ts`
  - `chat:start` and `chat:stop` go through `createServiceChat`.
  - `SERVICE_ROUTES` gains `model:get-health → model.health` (12 routes).
  - The client dependency is now `request | onEvent | onClose`.
- `service-shell.ts`: the startup and disconnect log lines now mention Chat, and the logger is passed to the proxy.

**Docs:** README (agent, client and transport bullets) and `agent-process-security.md` (Phase 4 status, event validation in §7, Chat usage in §3).

## Boundaries

- The renderer never talks to the agent port. It keeps using `window.api.chat` and `chat:event`; `RendererApi`, `IpcChannels` and the preload were not changed.
- There is no `electron` in the agent. Ollama is the only provider.
- Zod validation happens at every hop:
  - renderer payload, with the `@rka/shared` schemas;
  - protocol request and result, with `parseRequest` and `parseResult`;
  - event out of the agent and event into the client, with `parseEvent`;
  - the start result in the shell, with `ChatStartResultSchema`.
- No dual SQLite open: Electron still opens nothing in service mode, and the source guard test now covers `service-chat.ts` too.
- Out of scope, unchanged:
  - Settings, Research Tools (and their reverse dialogs), research actions and backup still reject in service mode (Phases 5–7).
  - Default `AGENT_TRANSPORT` is still `inprocess`.

## Checks run

| Check            | Result                       |
| ---------------- | ---------------------------- |
| `pnpm typecheck` | pass                         |
| `pnpm lint`      | pass (0 warnings)            |
| `pnpm test`      | pass: 102 files, 1,364 tests |
| `pnpm build`     | pass                         |

New and updated tests:

- `apps/agent/src/chat.test.ts` (new, 7 tests). It uses the real TCP server, real `AgentClient`, real `ChatController` and the real Ollama provider against a scripted fake Ollama HTTP server, so CI needs no live model. It covers:
  - streaming deltas then `done`;
  - usage recorded in the agent DB (provider, model, purpose, token counts);
  - `busy` while generating, and stop by streamId giving `cancelled`;
  - `busy` shared across two shells, where the other shell gets no events;
  - shell disconnect aborting the Ollama request;
  - malformed `chat.start` / `chat.stop` giving `bad_request`;
  - an Ollama 404 giving a `model-not-found` `chat.event`;
  - `model.health` returning `ready`.
- `apps/agent/src/server.test.ts` (+1): an invalid event is refused and logged while the valid one arrives; `onDisconnect` fires once for an authenticated connection and not for a rejected handshake.
- `apps/agent/src/services.test.ts`: the served method list now includes `chat.start`, `chat.stop` and `model.health`.
- `packages/agent-client/src/client.test.ts` (+1): valid events are delivered; an invalid payload or an unregistered event is dropped; a throwing listener is isolated; unsubscribe works.
- `apps/desktop/src/main/service-chat.test.ts` (new, 9 tests): routing by streamId and after a terminal event; early-event ordering; invalid-request parity; busy passthrough and result validation; stop forwarding and malformed stop; window-close stop; destroyed-window stop; synthetic `unavailable` on disconnect with no stop afterwards; failed background stop logged.
- `apps/desktop/src/main/service-shell.test.ts`: model health and Chat are proxied, 12 routes, Chat is no longer in the unavailable list, and the multi-listener close fake still works. `agent-transport.test.ts` got its fake client updated for `onEvent`.

Manual end to end used `node apps/desktop/scripts/fake-services.mjs` (fake Ollama, `fake-model:1b`) plus the agent started with `OLLAMA_HOST=127.0.0.1:11435`, `OLLAMA_MODEL=fake-model:1b` and `--data-dir %TEMP%\rka-phase4-e2e`.

1. **CLI client against the agent:**
   - `model.health` returned `ready fake-model:1b`.
   - `chat.start` streamed the full reply and then `done`.
   - A second start while generating got `busy`.
   - Stop after 500 ms gave `cancelled`.
   - Closing the client mid-stream aborted the reply; a new client could start right away (not busy).
2. **Electron in service mode** (`AGENT_TRANSPORT=service`, `AGENT_STATE_FILE` set):
   - Log: `connected … handshake + ping 10 ms` and `serves the Dashboard and Chat`.
   - Driving the renderer's real `window.api` over a local DevTools port:
     - `getModelHealth()` returned `ready fake-model:1b`.
     - `chat.start({ messages: [] })` returned the in-process `invalid-request` message.
     - A start streamed the full reply over `chat.onEvent` and ended with `done`.
     - A concurrent start got `busy`.
     - `chat.stop(streamId)` after 400 ms ended with `cancelled` after 3 deltas.
3. **Agent killed mid-stream:** the window received `{ type: 'error', code: 'unavailable', message: 'The agent service disconnected. Restart the app to use Chat.' }`.
4. **Usage:** the agent's database held 2 `chat` usage rows (`fake-model:1b`, 20 prompt and 20 completion tokens in total), one per completed reply. Cancelled replies record none, as in-process.

The temporary probe scripts were removed afterwards.

## Behaviour

| Behaviour                | In-process                     | Service mode                                                                                                                            |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid start payload    | `rejected` / `invalid-request` | Same, checked in Electron before any round trip                                                                                         |
| One generation at a time | `busy`                         | `busy`, global across all shells connected to the agent                                                                                 |
| Stop by streamId         | aborts the matching stream     | `chat.stop` to the agent; same result                                                                                                   |
| Window closed            | `stopForSink(webContents.id)`  | Electron sends `chat.stop` for that window's streams; a dropped shell connection also triggers `stopForSink(connectionId)` in the agent |
| Malformed stop           | throws                         | throws (Electron validation; the agent also returns `bad_request`)                                                                      |
| Model usage              | desktop `chatUsageRecorder`    | agent `onChatUsage`, same record shape                                                                                                  |
| Model health             | local runtime                  | `model.health` from the agent runtime                                                                                                   |

## Risks / decisions (intentional gaps)

- **Sink granularity:** the agent sees one sink per connection, not per window. Electron restores per-window routing and per-window stop itself. If the shell process dies, the socket closes and the agent stops the stream.
- **Window closed while a start is in flight:** the stream id is unknown when `destroyed` fires. The stream is stopped as soon as the start resolves (the window is destroyed) or when its first event arrives. A few deltas may be generated in between and discarded.
- **Agent restart:** there is no reconnect (as in Phase 3). Open streams end with `unavailable`. Later Chat, Dashboard and health calls fail with `connection_closed` until the app restarts. Supervision is Phase 8.
- **Settings in service mode:** the agent's Chat uses environment configuration only. That means `OLLAMA_HOST`, `OLLAMA_MODEL`, `AGENT_ENGINE` and the other `load*Config` variables, with no saved Settings, no Ollama access token and no live reconfiguration. The agent does not read `.env`. Chat web search (`chatWebSearch`) is off in the agent until Settings move (Phase 7).
- **`model.health` early:** it is still registered as Phase 7 in `PROTOCOL_METHODS`. The registry phase numbers were left unchanged; only the serving moved earlier.
- **Event ordering:** the early-event buffer is bounded (256) and only active while a start is pending. Since the agent emits events after the start handler returns and the first delta needs an Ollama round trip, it normally holds at most the first few events.
- **Timeouts:** `chat.start` and `chat.stop` use 15 s (only acceptance is awaited; the stream is not). Model health uses the existing 60 s proxy timeout.
- `pnpm format:check` still reports only the user's `docs/agent-process-separation-plan.md`, which is intentionally not edited.
