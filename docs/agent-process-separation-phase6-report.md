# Agent process separation — Phase 6 report

## Summary

- With `AGENT_TRANSPORT=service`, the agent serves Research Tools (`researchTools.status`, `checkSearch`, `search`, `fetchUrl`, `pickFile`, `extractFile`, `saveSource`, `openUrl`, `cancel`) and `storage.backup`. Electron main proxies the matching IPC channels.
- The protocol now has **reverse calls**: the agent sends a `shell.*` request and the shell sends back a response. Dialogs (`shell.chooseBackupPath`, `shell.chooseFile`, `shell.chooseFolder`), `shell.openExternal`, `shell.getSecret` and `shell.encryptionAvailable` are answered by Electron with the same `createElectronHostPorts` code the in-process app uses.
- Research Tools guarantees are unchanged. A picked path goes Electron → agent only, and the renderer still receives an opaque token. `openExternal` is checked in the agent (only URLs it returned from a search or fetch) and again in Electron (`isSafeExternalUrl`). The save dialog, including its overwrite confirmation, stays in Electron.
- A dialog left open when its shell disconnects fails at once with `shell_unavailable`, and every reverse call has a timeout. Nothing waits for a shell that is gone.
- The default `inprocess` mode behaves as before. Its only code change is that `createElectronHostPorts` now takes `{ backupDirectory, getSecret }` instead of the whole runtime config.

## Design

### Reverse-call correlation

| Side                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent (`server.ts`)          | `AgentConnection.call(method, params, { timeoutMs })`. It validates params with `parseRequest(…, 'toShell')`, sends a `req` with a fresh UUID id and keeps it in a per-connection pending map. A `res`/`error` from the client settles the entry only if both id **and** method match; a `res` must also pass `parseResult`. Anything else is logged ("Ignoring unsolicited …") and dropped.                                                                    |
| Agent, on close              | Every pending call on that connection is rejected with `ShellCallError('shell_unavailable')`.                                                                                                                                                                                                                                                                                                                                                                   |
| Agent, on timeout            | The entry is removed and the call is rejected with `ShellCallError('timeout')`. A late answer is then treated as unsolicited.                                                                                                                                                                                                                                                                                                                                   |
| Client (`@rka/agent-client`) | `client.serve(handlers)` registers typed `ShellHandlers`. Each incoming `req` goes through `parseRequest(…, 'toShell')`, so an agent method is `unknown_method` and bad params are `bad_request`. A method with no handler answers `not_implemented`. A handler's result is checked with `parseResult` before sending. A throwing handler answers `internal` "`<method>` failed in the shell." and its details stay local (never logged for `shell.getSecret`). |

`ShellMethodName` (protocol) is the type of the six `toShell` request methods. Fixing it required the `request()` helper in `methods.ts` to keep the literal direction type; the runtime registry is unchanged.

### Which shell is asked

- **Dialogs and `openExternal`** go to the connection whose request is being served. The server runs each handler inside `runWithConnection` (`AsyncLocalStorage`, `connection-context.ts`), so a port called anywhere in that async work (for example `ResearchToolsService.pickFile` → `chooseFile`) reaches the shell that made the request. With no requesting connection (code outside a request), or once it has closed, the port throws `shell_unavailable`. A dialog is never shown on another client: a `cli` client calling `researchTools.pickFile` gets an error from its own (missing) handler, and other shells are never asked (`research-tools.test.ts`).
- **Secrets** go to the requesting connection if its `system.hello` kind is `shell`, otherwise to the most recently authenticated open `shell` connection, otherwise they fail with `shell_unavailable`. They are never asked of a `cli` or `test` client.

### Timeouts

| Where                                                            | Value                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Agent → shell dialog (`shell.choose*`)                           | `SHELL_DIALOG_TIMEOUT_MS` = 10 min (protocol constant)                          |
| Agent → shell `openExternal`, `getSecret`, `encryptionAvailable` | 30 s                                                                            |
| Electron → agent `storage.backup`, `researchTools.pickFile`      | 15 min (`SERVICE_DIALOG_TIMEOUT_MS`), so the agent's dialog timeout fires first |
| Electron → agent other `researchTools.*`                         | 5 min (network fetches and document parsing)                                    |
| Electron → agent everything else                                 | 60 s (unchanged)                                                                |

### Files

- `packages/agent-protocol`: `ShellMethodName`, `SHELL_DIALOG_TIMEOUT_MS`, and the generic direction in `request()`.
- `packages/agent-client`: `serve()`, `ShellHandler(s)`.
- `apps/agent`:
  - `connection-context.ts` (new): `ShellCallError`, `runWithConnection`, `requestingConnection`.
  - `shell-ports.ts` (new): `createShellPorts` builds the dialog, `openExternal` and secret ports with the routing rules and timeouts above.
  - `server.ts`: `AgentConnection.kind` and `call()`, response routing, rejecting pending calls on close, `connections()`, `AgentServerLink`.
  - `handlers.ts`: `researchToolsHandlers` (Research Tools and `storage.backup`).
  - `services.ts`: the ports come from `createShellPorts`; `attachServer` replaces `attachEvents`; `secrets` is exposed for Phase 7.
  - `run.ts`: calls `attachServer`.
- `apps/desktop/src/main`:
  - `service-shell-ports.ts` (new, no Electron import): maps `shell.*` to a `HostPorts` subset.
  - `service-shell.ts`: `client.serve(...)` and the log text.
  - `service-ipc.ts`: 10 new routes (27 in total) and per-method timeouts.
  - `host-ports.ts`: narrower config.
  - `index.ts`: service mode builds Electron ports with no saved backup folder and no secret store.
  - `security-guards.test.ts`: `service-shell-ports.ts` added to the reviewed `openExternal` call sites; it only delegates to `host-ports.ts`.

## Tests

- `client.test.ts` (+1): the client serves a valid request; a throwing `getSecret` handler answers a generic `internal` and the secret text appears in neither the reply nor the logs. Bad params give `bad_request`, an agent method gives `unknown_method`, a missing handler gives `not_implemented`, and an invalid handler result gives `internal`.
- `shell-ports.test.ts` (new, 8 tests: real server, real clients as shells):
  - each of two shells gets its own dialog;
  - a cancelled dialog gives `null`, and `openExternal` params pass through;
  - a shell without handlers gives `not_implemented`;
  - a raw socket answering `{ path: 42 }` is rejected by the agent's `parseResult`, and an unsolicited `res` is logged and ignored;
  - a dialog timeout;
  - **a disconnect mid-dialog fails the operation within the test's 2 s bound**;
  - dialogs outside a request are refused;
  - secrets go to the newest shell and fall back to the older one when the newer one leaves; `cli` clients are never asked.
- `research-tools.test.ts` (new, 6 tests: real agent services, real database):
  - pick a real DOCX through the shell dialog, where the result has a token and no path, then extract it by token;
  - a cancelled pick;
  - `openUrl` is refused for an unseen URL, and after `fetchUrl` it goes to the shell's `openExternal`;
  - backup writes a verified file to the path the shell chose, and a cancelled dialog gives `cancelled`;
  - **a shell that disconnects mid-pick**: the agent logs the failure and a new shell can pick again;
  - a `cli` client's pick never shows a dialog on the connected shell.
- `service-shell.test.ts` (+2, updated):
  - Research Tools and backup channels use the longer timeouts, and the dialog timeout is checked against `SHELL_DIALOG_TIMEOUT_MS`;
  - the handlers registered with `serve` call the Electron ports (`getSecret` gives `null`, and a non-https URL is refused by the port);
  - 27 routes, and the unavailable list is now the Settings channels;
  - the storage-import guard also covers `service-shell-ports.ts`.
- `services.test.ts`: the served method list includes `researchTools.*` and `storage.backup`, and the `not_implemented` example is now `settings.get`.
- `run.test.ts`: `attachServer` receives the server.
- `methods.test.ts`: a type test for `ShellMethodName`.

Checks: `pnpm lint`, `pnpm -r typecheck`, `pnpm test` (105 files, 1,390 tests) and `pnpm build` pass.

### Manual end to end

I ran `fake-services.mjs`, then the agent (`--data-dir %TEMP%\rka-phase6-e2e`), then Electron with `AGENT_TRANSPORT=service` and a local DevTools port. The renderer's real `window.api` was called over DevTools, and the native dialogs were answered on the desktop.

- `researchTools.pickFile()` opened the Windows "Choose a PDF or Word document" dialog. After a DOCX was picked, the renderer received `{ status: 'selected', file: { token, name: 'notes.docx', size: 807, kind: 'docx' } }`, and no path appeared anywhere in its results. `extractFile` with that token returned the document text.
- `openUrl('https://example.org/not-fetched')` was refused ("Only URLs from a search result or fetch can be opened."). After `fetchUrl('https://example.com/')`, `openUrl` returned `opened` and the page opened in the default browser.
- `storage.backup()` opened the "Export database backup" save dialog in Documents with the usual file name. Saving to a temp path returned `{ status: 'saved', bytes: 196608, verified: true }`.
- With a file dialog open, the Electron process tree was killed. The agent logged `researchTools.pickFile failed: The shell disconnected during shell.chooseFile.` straight away and still answered `agent:ping` afterwards.

## Risks / decisions (intentional gaps)

- **No secret source in service mode yet.** Electron has no database in service mode, so `shell.getSecret` answers `null`. The port and routing work (tested), but nothing in the agent consumes them until Phase 7, which decides where the encrypted Ollama token lives. The agent still reads Ollama settings from the environment.
- **Saved backup folder not used in service mode.** The save dialog opens in Documents because the Settings value lives in the agent's database (Phase 7). The default name and the overwrite confirmation are unchanged.
- **Settings stay unavailable in service mode** (`settings.*`, `settings:choose-backup-folder`, `settings:set-secret`). `shell.chooseFolder` is served by the shell already, for Phase 7.
- **Research Tools state is per agent, not per window.** Picked-file tokens, openable URLs and cancellable request ids live in the one `ResearchToolsService`, as in-process, where they are per app. A token issued to one shell could be used by another connected shell. Both are trusted local processes behind the token handshake, so this matches the in-process trust boundary.
- **A shell that dies mid-dialog** fails the operation and nothing is written. A dialog that is already on screen in a still-running Electron is not closed by an agent-side timeout; its late answer is ignored.
- **`researchTools.cancel`** cancels by request id across the agent. The renderer generates the ids, as in-process.
- `pnpm format:check` still reports only the user's `docs/agent-process-separation-plan.md`, which is intentionally not edited.
