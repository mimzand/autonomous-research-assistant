# ADK Migration — Phase 5 Report

_Durable SQLite session service for Google ADK. Date: 2026-11-12._

Phase 5 adds infrastructure only. Production Chat stays stateless; Chat, Research, IPC,
preload and the renderer are unchanged. In a packaged Linux build, the app's requests to
Ollama are byte-identical to the baseline, and a fresh profile's database gets migration
`0002_adk_sessions`.

## 1. Schema and migration

Migration `0002_adk_sessions` is additive: it only creates four tables and their indexes.
It does not alter or drop anything. The hashes of `0000` and `0001` are unchanged.

| Table            | Key                                      | Holds                                                                        |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `adk_sessions`   | PK `(app_name, user_id, id)`             | Session-scoped state, `update_time_ms` (ADK `lastUpdateTime`), `event_count` |
| `adk_events`     | PK `(app_name, user_id, session_id, id)` | One ADK event as JSON, its `seq`, invocation id, author, timestamp, size     |
| `adk_app_state`  | PK `app_name`                            | Shared `app:` state (prefix removed)                                         |
| `adk_user_state` | PK `(app_name, user_id)`                 | Shared `user:` state (prefix removed)                                        |

**Constraints and indexes:**

- `adk_events` has a foreign key `(app_name, user_id, session_id)` → `adk_sessions` with
  `ON DELETE CASCADE`.
- `seq` is unique per session and must be ≥ 1 (CHECK); `event_count` must be ≥ 0 (CHECK).
- Indexes: sessions by `(app, user, update_time_ms)`; events by invocation.

**Tests:**

- A 0001 → 0002 upgrade test checks that the schema SQL and every row of the existing
  tables are identical before and after the upgrade.
- The packaged app applied the migration to a fresh profile.

Documented in `packages/storage/SCHEMA.md`.

## 2. Architecture

There are two layers:

**`@rka/storage` → `storage.adkSessions`.** Synchronous and ADK-agnostic:

- `create`, `get`, `list`, `delete`, `appendEvent`;
- Zod-validated input, parameterised Drizzle queries, one transaction per write;
- also available inside `storage.transaction()`, where it nests as a savepoint.

**`@rka/adk-runtime` → `SqliteSessionService extends BaseSessionService`.** Maps ADK
semantics onto those primitives:

- splits state by prefix;
- serialises and restores events;
- handles stale writes;
- keeps the caller's in-memory session in sync.

**Ownership and access:**

- The service receives the repository from the main process. It never opens a database
  itself.
- Nothing is wired into production yet. Nothing is reachable from IPC or the renderer.
- `createGuardedRunner` now admits only `InMemorySessionService` or `SqliteSessionService`,
  never ADK's Database or Vertex AI services.

## 3. ADK API compatibility (2.4.0)

| ADK method           | Behaviour                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSession`      | As ADK's `DatabaseSessionService`: generates a UUID if no id is given; splits `app:` / `user:` / session state; drops `temp:` keys; duplicate id → error (`conflict`).    |
| `getSession`         | Returns the merged state and the events in append order. `numRecentEvents` returns the most recent N; `afterTimestamp` is a strict `>` filter; `0`/unset means no filter. |
| `getOrCreateSession` | Inherited from ADK.                                                                                                                                                       |
| `listSessions`       | Sessions without events, with merged state. `limit`/`offset`/`page`/`order` and the response fields follow ADK.                                                           |
| `deleteSession`      | Deletes one scoped session; its events go by cascade. A missing session is a no-op, as in ADK.                                                                            |
| `appendEvent`        | Ignores partial events. Stores the event and its delta atomically, then runs ADK's own in-memory bookkeeping (`super.appendEvent`).                                       |

Deliberate differences from ADK's `DatabaseSessionService`:

- **`listSessions` requires `userId`.** ADK lists every user's sessions when it is omitted;
  here that is refused.
- **Stale writes are always rejected.** ADK's optional "last write wins" mode does not
  exist here.
- **`lastUpdateTime` is strictly increasing,** not simply the last event's timestamp (see §6).
- **Ids and sizes are bounded** (see §9).

**`StaleSessionError`.** The service throws its own `StaleSessionError`, which ADK's
`isStaleSessionError()` recognises (tested both ways). ADK's class is not imported, because
ADK exports it through `database_session_service.js`. Importing it made the bundler keep
that module, and with it the code executors, `LocalEnvironment`, MikroORM and a
`child_process` import. This was found by the bundle check. The facade comment records why
the import must stay out.

## 4. Event serialisation and ordering

**Format.**

- Events are stored as JSON, which is ADK's own storage format (`DatabaseSessionService`
  stores the event as JSON).
- `temp:` keys are removed from the stored `stateDelta`.
- Values JSON would silently change are refused with `SessionDataError`, never stored
  altered: functions, `NaN`/`Infinity`, `Date`, `bigint`, class instances, sparse arrays.
- Events are restored with ADK's own `createEvent`, after a minimal Zod shape check. A
  malformed row is an error, never skipped.

**Ordering.**

- Each new event gets `seq = event_count + 1` inside the write transaction. Reads order by
  `seq`, not by timestamp, so equal or backward timestamps keep append order.

**Duplicates.**

- Re-appending an identical event with the same id is a no-op: not duplicated in storage
  or in memory.
- A changed event with the same id replaces the stored one in place and keeps its `seq`,
  matching ADK's upsert semantics.

## 5. State scopes

| Scope   | Key in ADK state | Stored in                           | Visible to                      |
| ------- | ---------------- | ----------------------------------- | ------------------------------- |
| Session | `key`            | `adk_sessions.state`                | That session only               |
| User    | `user:key`       | `adk_user_state` (per app and user) | All of that user's sessions     |
| App     | `app:key`        | `adk_app_state` (per app)           | All users' sessions in that app |
| Temp    | `temp:key`       | Never stored                        | The current invocation only     |

Deleting a session keeps the user and app state. After an append, the caller's
`session.state` is replaced with the stored merged state, as in ADK's database service.

## 6. Transactions and concurrency

**One transaction per `appendEvent`.** It covers, in order:

1. The stale check.
2. The event insert or replacement.
3. The app, user and session state merges.
4. The session's `update_time_ms` and `event_count`.

Any failure rolls back all of it. The caller's in-memory session is changed only after the
commit.

**Optimistic concurrency.**

- A writer whose `lastUpdateTime` is older than the stored one gets `StaleSessionError`,
  and nothing is written.
- `update_time_ms = max(previous + 1, event timestamp)`, so a stale writer is detected even
  when both writers' events carry the same millisecond. ADK's own check would let that
  case through.
- The test uses two separate connections to the same file.

**SQLite settings** come from the existing storage layer: WAL, `synchronous=NORMAL`,
foreign keys on, `busy_timeout` 5 s.

## 7. Cancellation and partial events

- **Partial events are never stored:** ADK's Runner does not append them, and the service
  ignores them if asked to.
- **Mid-stream cancellation** (real Runner, streaming, abort after the first chunk), after a
  restart:
  - stored history: the question plus ADK's `INVOCATION_ABORTED` event;
  - no partial text, and `finalResponseText` is undefined;
  - `summarizeInvocation` gives `cancelled`, with no model text.
- **Cancellation is never stored as success.**

## 8. Crash recovery

| Scenario                                                     | Result after reopening                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Create, one turn, close, reopen, reload, continue            | Identical session, events and state. The next Ollama request contains the earlier turn.                                                      |
| Crash right after an event was stored (connection abandoned) | The committed event survives. `findIncompleteInvocations` reports the invocation; there is no answer.                                        |
| Failure during the event insert                              | Full rollback; DB and in-memory session unchanged.                                                                                           |
| Failure during the state update / session update             | Full rollback.                                                                                                                               |
| Runner turn whose model answer cannot be stored              | The run rejects. Only the user message is stored, and the invocation shows as incomplete.                                                    |
| Cancellation during streaming                                | See §7.                                                                                                                                      |
| Incomplete tool invocation (tool call stored, no response)   | Reported as incomplete. `summarizeInvocation` reports the call as `not_executed`. The next turn runs, and the stored call is never executed. |

**`findIncompleteInvocations(events)`** (new) lists invocations with no final answer and no
error or abort event. These invocations are never shown as answered.

**Tool outcomes.** They still come only from the `ToolOutcomeTracker` of the process that
ran the tools. A stored function response is history, not evidence of execution: summarising
reloaded history with a fresh tracker reports no call as executed or succeeded, and never
`completed`. The Phase 4.1 guarantees (no `outputKey`, Zod at the boundary, authoritative
status) are unchanged.

## 9. Security and privacy

- **Scoping.** Every query is scoped by `(app, user, session)`, so a guessed session id
  finds nothing. Covered by tests:
  - another user's or app's `getSession` → undefined;
  - a forged session object → `not-found`;
  - a Runner for another user cannot open the session;
  - delete is scoped too.
- **Validation and queries.**
  - Ids: 1–128 characters of `A–Z a–z 0–9 . _ : @ -`, starting with a letter or digit, so
    paths, wildcards and whitespace are rejected.
  - Queries are parameterised: Drizzle, plus `LIKE`-free equality filters.
- **Limits (`ADK_STORAGE_LIMITS`).** Exceeding one is an `invalid-input` error, never a
  silent truncation:

  | Limit                                          | Value  |
  | ---------------------------------------------- | ------ |
  | Event size                                     | 1 MiB  |
  | Each state scope                               | 1 MiB  |
  | Events per session (also the history read cap) | 10,000 |
  | Sessions per list call                         | 500    |

- **No exposure or logging.**
  - Nothing is logged by the service: no prompts, events or state.
  - No IPC, preload or renderer change.
  - The ADK tables are not in the renderer-visible storage status table list.
  - The status does list migration tags, so `0002_adk_sessions` appears there. That is a
    name, not data.
- **No background cleanup.** Deletion happens only on an explicit `deleteSession`.

## 10. Automated tests

| Check                      | Result                                             |
| -------------------------- | -------------------------------------------------- |
| `pnpm typecheck`           | pass                                               |
| `pnpm lint`                | pass                                               |
| `pnpm format:check`        | pass                                               |
| `pnpm test`                | pass: 61 files, 819 tests (Phase 4.1: 59 / 777)    |
| `pnpm build`               | pass                                               |
| `pnpm package:dir` (Linux) | pass; packaged smoke run identical to the baseline |

**New and changed test files:**

- `storage/src/repositories/adk-sessions.test.ts` (16 tests):
  - scoping, id validation, list isolation and pagination;
  - ordering (including backward timestamps);
  - stale writers (including the same millisecond);
  - idempotent and replaced events;
  - bounded reads, size limits;
  - rollback on injected insert and state failures, rollback inside an outer transaction;
  - persistence across reopen.
- `storage/src/migrations.test.ts`: the 0001 → 0002 upgrade test; the table list is
  updated.
- `adk-runtime/src/sessions/sqlite-session-service.runner.test.ts` (24 tests). It uses the
  real Runner, `OllamaLlm`, `OllamaProvider` (real HTTP to a fake Ollama), `ToolRegistry`
  and `RegistryTool`, and temporary database files:

  | Group                       | Covers                                                                                   |
  | --------------------------- | ---------------------------------------------------------------------------------------- |
  | A. Create and retrieve      | Including `getOrCreateSession` and generated ids                                         |
  | B. List isolation           | Pagination; missing `userId` refused                                                     |
  | C. Delete                   | No orphans; other sessions and shared state kept                                         |
  | D/F. History and reopen     | Event history and continuing after reopen; bounded reads                                 |
  | E. State scopes             | Scopes, `temp:` never stored, non-JSON values refused                                    |
  | G. Duplicates               | Duplicate event ids                                                                      |
  | H. Rollback                 | Event, user-state and session failures; a Runner turn whose answer cannot be stored      |
  | I. Concurrency and ordering | Stale writer across two connections; ADK's `isStaleSessionError` both ways; ordering     |
  | J. Cancellation             | Mid-stream cancellation with restart; partial events ignored                             |
  | K. Tool ids                 | Function-call and function-response ids after reopen; outcomes not inferred from history |
  | Crash recovery              | Crash after an event; incomplete tool invocation                                         |
  | L. Cross-user and cross-app | Cross-user/app access; malformed ids                                                     |
  | Limits                      | Oversized event                                                                          |
  | M. Research data            | Research tables byte-identical after ADK activity; ADK tables not in `TABLE_NAMES`       |

- `guards.test.ts`: only the in-memory and SQLite session services are admitted.
- `security.test.ts`: the facade allowlist now also contains `createEvent` and `State`.

## 11. Live Ollama test

`pnpm test:adk:ollama` now includes `sessions/sqlite-session-service.live.test.ts`. On a
temporary database file it:

1. creates a session with session and `user:` state;
2. runs one turn ("remember the code word PELICAN");
3. closes the database, reopens it with a new connection and service, and reloads the
   session;
4. checks the history, the state and that no invocation is incomplete;
5. asks for the code word and expects `pelican`;
6. checks that the four events are stored without partials.

It pulls no models.

**Status: unverified in this environment** (no real Ollama). It was dry-run against a
stand-in server that answers only from the conversation history it receives; it passed.

```powershell
cd C:\Users\zandm\Projects\Algoalliance\sample-agent
pnpm install
pnpm test:adk:ollama
```

## 12. Windows compatibility

**Pending.** Everything above ran on Linux (Node 22.23.4; Electron 44.10.1 for the packaged
app).

**Expected to be the same on Windows:**

- `better-sqlite3` is already the app's database driver on Windows;
- the new code uses only SQLite features already in use (WAL, foreign keys, composite keys,
  `RETURNING`);
- temporary files use `os.tmpdir()` and `path.join`.

**Points to check on Windows:**

- `pnpm test` (temporary database cleanup while WAL files are open);
- `pnpm test:adk:ollama`;
- starting the existing app once, to confirm that the upgrade of the real database to
  `0002` succeeds and the Research data is intact.

## 13. Files changed

**Created:**

- `packages/storage/drizzle/0002_adk_sessions.sql`
- `packages/storage/drizzle/meta/0002_snapshot.json`
- `packages/storage/src/repositories/adk-sessions.ts`
- `packages/storage/src/repositories/adk-sessions.test.ts`
- `packages/adk-runtime/src/sessions/sqlite-session-service.ts`
- `packages/adk-runtime/src/sessions/history.ts`
- `packages/adk-runtime/src/sessions/sqlite-session-service.runner.test.ts`
- `packages/adk-runtime/src/sessions/sqlite-session-service.live.test.ts`
- `docs/adk-migration-phase5-report.md`

**Modified:**

| File                                           | Change                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/storage/src/schema.ts`               | The four ADK tables and their record types.                                            |
| `packages/storage/src/migrations.generated.ts` | Embedded `0002`.                                                                       |
| `packages/storage/drizzle/meta/_journal.json`  | Journal entry for `0002`.                                                              |
| `packages/storage/src/storage.ts`              | `adkSessions` repository (also inside `transaction()`).                                |
| `packages/storage/src/index.ts`                | Exports.                                                                               |
| `packages/storage/src/migrations.test.ts`      | Table list; upgrade test.                                                              |
| `packages/storage/src/inspect.test.ts`         | Expected migration list.                                                               |
| `packages/storage/SCHEMA.md`                   | ADK tables, rules and limits.                                                          |
| `packages/adk-runtime/src/adk.ts`              | `createEvent`, `State` and session request types; why `StaleSessionError` is excluded. |
| `packages/adk-runtime/src/engine.ts`           | Exports.                                                                               |
| `packages/adk-runtime/src/guards.ts`           | Session-service allowlist.                                                             |
| `packages/adk-runtime/src/guards.test.ts`      | Test for the session-service allowlist.                                                |
| `packages/adk-runtime/src/security.test.ts`    | Facade allowlist.                                                                      |
| `packages/adk-runtime/package.json`            | Depends on `@rka/storage` (workspace; no new external dependency).                     |
| `pnpm-lock.yaml`                               | Workspace link.                                                                        |

**Removed:** none.

## 14. Remaining risks

- **Not used yet.** No production code creates a `SqliteSessionService`; Chat is still
  stateless. Wiring it in (and showing `summarizeInvocation` results) is later work.
- **Synchronous writes.** better-sqlite3 runs in the main process; a 1 MiB event write
  blocks it briefly. The limits keep this small.
- **History growth.** Long sessions grow up to 10,000 events. There is no automatic
  compaction or cleanup by design; a retention policy needs an explicit decision.
- **Stored data is plaintext.** Session events contain conversation text, stored like the
  rest of the app's data (no field encryption). Secrets must never be put in ADK state.
- **Stale writes surface as errors.** Callers must reload and retry. Nothing retries
  automatically.
- **Coupling to ADK internals.** The service reimplements ADK's state-splitting and merge
  rules (from 2.4.0's `DatabaseSessionService`), because ADK does not export them. A future
  ADK upgrade must re-check them; ADK is pinned at 2.4.0.
- **Live and Windows verification are pending** (§11, §12).
