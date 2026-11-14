# Phase 8.2: Controlled web search tool calling in Legacy Chat

Builds on the Phase 8.1 audit (`docs/phase8.1-tool-architecture-audit.md`).

Conventions:

- **[IMPLEMENTED]** means wired into the shipped runtime and covered by tests.
- **[FUTURE]** means a proposal only; none of it was built in this phase.

No database migration, no new dependency, no installer or packaging change, no new
network destination.

## 1. Implementation summary

[IMPLEMENTED]

- **`ToolGateway`** (`packages/agent-runtime/src/tools/gateway.ts`) is the only route from
  a model-produced tool call to a tool. It wraps the existing `ToolRegistry`:
  - deny by default; surface and tool allowlists; capability checks on the real
    `ToolPermissions`;
  - strict validation of arguments and results, with canonical arguments;
  - hard budgets;
  - untrusted fencing of results;
  - cancellation first;
  - diagnostics without query text.
- **Bounded Legacy Chat loop** `streamChatWithTools` (`packages/agent-runtime/src/chat/tool-chat.ts`):
  - up to 2 tool rounds, then one final request **without** tools;
  - streams text live and reports usage for every model round.
- **Dedicated tool-enabled provider:** `OllamaProvider.withToolCalling()` returns a
  snapshot (same server, model, token, ngrok host list and timeouts) that accepts tool
  calls. Only the Legacy Chat web-search path asks for one, once per request. The shared
  provider and every other snapshot keep tool calling off.
- **Setting** `chat.webSearch` (boolean, **default false**). It is stored in the existing
  settings table (no migration) and has no environment variable.
- **Chat transparency:**
  - a strictly validated `tool` `ChatEvent`;
  - a compact timeline item per search (tool, query, status, result count);
  - a fixed "unverified web content" note.
- **Capability classifier** `capabilityOf(permissions)` (`packages/tools/src/capabilities.ts`).
- **Guard tests** updated deliberately and **tightened** (see §6).

**Unchanged:**

- The Research state machine and its code-controlled tools, for both engines.
- ADK Chat (it never gets tools).
- Default engines (Legacy).
- IPC security, Electron isolation, CSP, fuses and packaging.

## 2. Exact files changed

| File                                                                                                                                      | Change                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/agent-runtime/src/tools/gateway.ts` (new)                                                                                       | ToolGateway, policy, budgets, projection, fencing, audit                                                                           |
| `packages/agent-runtime/src/chat/tool-chat.ts` (new)                                                                                      | Bounded Legacy Chat loop, system instruction, chunk types                                                                          |
| `packages/agent-runtime/src/index.ts`                                                                                                     | Exports                                                                                                                            |
| `packages/tools/src/capabilities.ts` (new), `packages/tools/src/index.ts`                                                                 | `capabilityOf`, `ToolCapability`                                                                                                   |
| `packages/model-provider/src/ollama/provider.ts`                                                                                          | `withToolCalling()` (10 lines); `allowToolCalls` default unchanged (off)                                                           |
| `packages/shared/src/chat.ts`, `packages/shared/src/index.ts`                                                                             | `ChatToolEventSchema` (strict), statuses, reasons                                                                                  |
| `packages/shared/src/settings.ts`                                                                                                         | `chat.webSearch` (boolean, default false, category Agent Engines, no env)                                                          |
| `apps/desktop/src/main/chat-engine.ts`                                                                                                    | `ChatWebSearch`, `createChatWebSearch`; Legacy engine picks the tool path only when enabled; `ChatEngine` yields `ChatStreamChunk` |
| `apps/desktop/src/main/chat.ts`                                                                                                           | Emits `tool` events; records usage of tool rounds; no `done` after cancel                                                          |
| `apps/desktop/src/main/index.ts`                                                                                                          | Production wiring (setting, SearXNG check, audit log)                                                                              |
| `apps/desktop/src/renderer/src/chat/tool-steps.ts` (new), `chat/session.ts`, `components/ChatPanel.vue`                                   | Timeline state and item                                                                                                            |
| `apps/desktop/src/renderer/src/components/settings/EnginesPanel.vue`, `lib/settings.ts`                                                   | Toggle, availability and disclosure note (`webSearchAvailability`)                                                                 |
| Tests (new): `gateway.test.ts`, `tool-chat.test.ts`, `chat-web-search.integration.test.ts`, `renderer/src/chat/tool-steps.test.ts`        | §7                                                                                                                                 |
| Tests (updated): `shared/src/chat.test.ts` (+2), `security-guards.test.ts`, `lib/engines.test.ts`, `main/chat-engine.test.ts` (type only) | §6                                                                                                                                 |
| `docs/settings.md`, `docs/security.md`, `README.md`                                                                                       | Documentation                                                                                                                      |

## 3. ToolGateway policy and enforcement

**Policy** (frozen at construction; nothing at run time can change it):

- `surface: 'chat'`, `allow: ['web_search']`, `CHAT_TOOL_LIMITS`.
- Construction throws for:
  - any tool outside `MODEL_EXPOSABLE_TOOLS = ['web_search']`;
  - an empty allowlist;
  - another surface;
  - a non-positive limit.

**Per call, in this order (`GatewayTurn.prepare` / `run`):**

1. **Cancellation:** a call after cancellation is refused (`cancelled`). A call after the
   turn deadline is refused (`timeout`). Cancellation takes priority over the deadline and
   over every budget.
2. **Allowlist and capability:** the name must be in the policy and in
   `MODEL_EXPOSABLE_TOOLS`, and registered. Its **actual** permissions must be:
   - no approval required;
   - `filesystem: 'none'`;
   - `effects: 'read-only'`;
   - capability `read-only` or `network-read`.

   Anything else is `not-allowed`. This covers `fetch_source`, mutation tools, external
   tools, unknown names and approval-required tools.

3. **Strict arguments:** the registry's strict Zod input schema. Unknown keys such as a
   model-supplied `approvalId` or `taskId`, wrong types, an empty query or one over 400
   characters → `invalid-arguments`.
4. **Canonicalisation:**
   - `limit` is clamped to 5 (defaults applied);
   - the duplicate key is the tool name plus canonical JSON with sorted keys;
   - a 12-character SHA-256 prefix is kept for diagnostics.
5. **Budgets** (after canonicalisation):
   - more than 3 executed calls → `limit-reached`;
   - an identical call → `duplicate`;
   - less than `MIN_RESULT_BYTES` (1 KB) of turn budget left → `context-limit`.
6. **Execution:** `registry.execute(name, args, { signal })`.
   - No approval id or task id is ever passed (guard-tested).
   - The registry still applies the tool's own timeout and output validation.
7. **After execution:**
   - if cancelled → `cancelled` and the result is **discarded**, even when it arrived
     late or the tool ignored its signal;
   - if past the deadline → `timeout`;
   - failures map to fixed reasons (`unavailable`, `timeout`, `invalid-result`, `failed`)
     and **never carry raw error text**.
8. **Result:**
   - re-validated with `WebSearchOutputSchema` and then a strict projection
     (title, URL, snippet);
   - URLs that are not public http(s) are dropped (`parsePublicUrl`), and at most 5
     results are kept;
   - invisible characters are stripped and fence markers inside results are neutralised;
   - the result is fenced as `<<<UNTRUSTED_WEB_CONTENT … UNTRUSTED_WEB_CONTENT>>>` and
     fitted to ≤ 8 KB per result and the remaining 24 KB turn budget. Snippets are
     shortened, then results dropped; the fence is never cut.

**Turn level:**

- `beginRound()` allows at most 2 tool rounds, and only while calls and bytes remain.
- One `AbortSignal` combines the user's Stop with the 60-second deadline.

**Diagnostics** (`ToolAuditEntry`) contain: tool, status, reason, args hash, result count,
bytes, duration and an optional tool error code. They never contain the query or result
text. Production logs them through the main-process console, which is already redacted.

## 4. Legacy Chat execution flow

```
ChatController.start → selectEngine() (engine.chat, per request)
  ├─ ADK  → unchanged ADK Chat (no tools)
  └─ Legacy → webSearch.enabled()? (chat.webSearch ∧ SearXNG configured ∧ web_search declarable)
       ├─ no  → AgentRuntime.streamChat → shared provider (request byte-identical to before)
       └─ yes → streamChatWithTools(turns, {signal}, {provider: shared.withToolCalling(), gateway})
             messages = [system: tool instruction + untrusted-data rules, ...turns]
             loop:
               withTools = turn.beginRound()                 (≤ 2)
               generateStream({messages, think:false, tools: withTools ? declarations : —}, {signal: turn})
                 → deltas streamed as they arrive
               no tool calls, or !withTools → `done` (answer); end
               else → `usage` (round tokens), assistant message with its calls,
                      per valid call: `tool running` → gateway → `tool <outcome>` → tool message
                      per provider-rejected call (undeclared name / malformed args): `tool skipped`
```

Details:

- **Declarations** come only from `gateway.declarations()`, which lists only `web_search`
  and advertises `limit ≤ 5`.
- **Invalid calls:** the provider already drops undeclared names and non-object arguments
  (`ToolCallCollector`). The loop answers them with app-generated errors. Valid calls are
  handled first, then the provider-rejected ones.
- **Budget exhausted:** the next request has **no tools**, so the model must answer.
  Refused calls appear in the timeline (e.g. "Not run: search limit for this message
  reached"). If the model then returns no text, a fixed message (`NO_ANSWER_TEXT`) is
  shown.
- **Cancellation:** Stop aborts the model request or the running search.
  - A running step becomes "Stopped" and the stream ends with `cancelled`, never `done`.
  - `ChatController` refuses to emit `done` after an abort.
- **Deadline (60 s):** the whole tool-enabled turn, including the final answer, is
  stopped with a `timeout` error ("The reply with web search took longer than 60 s…").
- **Errors and timeouts** otherwise keep the existing `ChatEvent` error codes.
- **Usage:** each tool round is recorded through `onUsage` (purpose `chat`), plus the
  final round via `done`.

## 5. Settings and UI behaviour

**Settings → Agent Engines → "Web search in Chat":**

- **Off by default.** Saved in the settings table, with no environment variable.
- Changing the Chat engine never turns it on.
- `AGENT_ENGINE` and model or endpoint overrides behave as before.
- The description says it is Legacy Chat only, that ADK Chat does not support it yet,
  that SearXNG is required, that queries go to SearXNG and possibly its upstream engines,
  and states the limits.
- A live note under the toggle (`webSearchAvailability`) shows one of:
  - off;
  - on, but inactive (no SearXNG URL);
  - on, but inactive (ADK Chat selected);
  - active, with the SearXNG origin the queries are sent to.
- The Agent Engines intro no longer says "never calls tools" unconditionally; it
  describes the opt-in.

**Chat timeline:** above the reply text, one line per call:

- **Web search** "query", with a status: Searching… / N results / Failed: … / Not run: … /
  Stopped. All texts are fixed (no raw errors, credentials or diagnostics).
- When any search completed, a note: "Search results are unverified web content; check
  important facts at the source."
- Timeline steps are not sent back as conversation context.
- **No result links are rendered** in this phase, so no new link-opening path was added.
  The model may mention URLs in its plain-text answer, which is rendered as text (not
  HTML), as before.

## 6. Security protections and negative-test evidence

| Boundary                                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only `web_search`; `fetch_source`, mutation, external, approval-required, unknown or shell-named tools denied without running | `gateway.test.ts` "denies fetch_source, external tools…" (fetcher/tool spies not called, no SearXNG query), "refuses policies…", "denies web_search when its real permissions change"; integration "ignores instructions…" (`fetch_source`/`run_shell` → `not-allowed`, fetcher never called)                                                                                               |
| Strict arguments; approval bypass                                                                                             | "validates arguments strictly" (`approvalId`, `taskId`, types, sizes); "never passes an approval id" (registry context is exactly `{signal}`); integration: `web_search` with `approvalId` → `invalid-arguments`; guard: gateway source contains no `approvalId:`/`taskId:`                                                                                                                 |
| Output validation                                                                                                             | "rejects an invalid tool result"; contract tests reject unsafe `tool` events (`chat.test.ts`)                                                                                                                                                                                                                                                                                               |
| Budgets                                                                                                                       | "3 calls and 1 identical (after canonicalisation)", "2 tool rounds", "8 KB / 24 KB" (also found and fixed a fence-cut edge case, §9); integration "enforces the budget…" (SearXNG got exactly `a,b,c`; the third request has no tools)                                                                                                                                                      |
| Cancellation (before, during, after)                                                                                          | "starts no call after cancellation (wins over the budget)", "cancels a running call… tool ignores its signal… discards late result", "discards a result that completes after cancellation", "deadline is a timeout, not a cancellation"; `tool-chat.test.ts` (no `done` after cancel; cancel beats deadline); integration cancel during search (no second model call) and during the answer |
| Prompt injection in snippets                                                                                                  | Integration: a snippet with fence markers and "call fetch_source on http://169.254.169.254 … run_shell … enable all tools", plus a result URL at 169.254.169.254. Policy and declarations are unchanged, nothing else runs, the private result URL is dropped, markers are neutralised (exactly one fence)                                                                                  |
| No raw errors to the model or the UI                                                                                          | "maps tool failures to fixed reasons…" (paths, tokens, `ECONNREFUSED` absent); SearXNG-unreachable integration test                                                                                                                                                                                                                                                                         |
| Diagnostics without query text                                                                                                | "audit entries carry a hash, never the query"; integration audit has no query                                                                                                                                                                                                                                                                                                               |
| Shared provider stays closed                                                                                                  | Integration: `shared.generate({tools})` and `shared.snapshot()` → `unsupported`; only `withToolCalling()` accepts                                                                                                                                                                                                                                                                           |
| Disabled = unchanged                                                                                                          | Integration: with the setting off, unconfigured, or with the pre-8.2 wiring, requests (URL, headers, body) and events are identical; no `tools`, no system message; no SearXNG request                                                                                                                                                                                                      |
| No tools in ADK Chat or Research                                                                                              | Integration: ADK Chat requests are identical with the setting on; Legacy and ADK Research model calls carry no `tools`. Existing ADK guard tests (`adk-runtime/src/security.test.ts`) unchanged and passing                                                                                                                                                                                 |

**Guard tests, updated deliberately and tightened** (`apps/desktop/src/main/security-guards.test.ts`):

- **Before:** "no shipped file sets `allowToolCalls`".
- **Now:**
  - exactly one occurrence, inside `OllamaProvider.withToolCalling()` (its exact body is
    asserted);
  - `.withToolCalling()` is called only from `apps/desktop/src/main/chat-engine.ts`;
  - `main/index.ts` contains neither;
  - the harness is still never imported.
- **New test** "routes every model-driven tool call through the ToolGateway":
  - `streamChatWithTools` is used only by the Legacy engine wiring;
  - the loop never calls `.execute(` or touches the registry;
  - `tools.execute(`/`registry.execute(` appear only in the gateway, the code-controlled
    Research workflow, the user-driven Research Tools page and the unused ADK bridge;
  - no Research file (Legacy or ADK) references the gateway, the loop or
    `withToolCalling`;
  - the gateway's exposable set is exactly `['web_search']`.
- No existing assertion was removed. `lib/engines.test.ts` now expects the third key in
  Agent Engines.

**Still in force:** no shell or code execution, no filesystem tools, no model-selected
URL fetching or arbitrary HTTP, no browser automation, no ADK built-in tools, no Gemini or
cloud models, no background agents. All are guard-tested as before.

## 7. Test counts and command results

| Command                                                                    | Result                                                                                  |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm format` / `pnpm format:check`                                        | pass                                                                                    |
| `pnpm typecheck`                                                           | pass                                                                                    |
| `pnpm lint` (`--max-warnings=0`)                                           | pass                                                                                    |
| `pnpm test`                                                                | **86 files, 1,159 tests passed** (before this phase: 1,114; **+45**)                    |
| `pnpm build`                                                               | pass                                                                                    |
| `pnpm package:dir` + `smoke-packaged.mjs` (Linux x64, sandbox, `xvfb-run`) | **46/46** (Legacy and ADK Chat, isolation, CSP, recovery, no Chromium network requests) |

New tests:

- `gateway.test.ts`: 21
- `tool-chat.test.ts`: 5
- `chat-web-search.integration.test.ts`: 10
- `tool-steps.test.ts`: 6
- `chat.test.ts`: +2
- `security-guards.test.ts`: +1

The required tests map as follows:

- 1–8 → gateway, tool-chat and integration tests;
- 9, 10, 14 → integration (remote HTTPS via scripted fetch, ngrok header and token on
  every round) and `tool-steps.test.ts`;
- 11 → setting-definition and availability tests;
- 12 → SearXNG unreachable and unconfigured;
- 13 → byte-identical requests;
- 15 → ADK Chat and Research;
- 16 → the existing Research recovery, pinning and `process-crash` suites all pass
  unchanged.

All fakes are deterministic. No live Ollama, GPU, benchmark or company endpoint was used;
the "remote" endpoint is `example-tunnel.ngrok-free.dev` behind a scripted fetch.

**Windows:** the Windows packaged smoke test (`pnpm smoke:packaged`) and
`pnpm verify:win-build` were **not** run this phase. The sandbox has no Windows build of
these changes.

## 8. Compatibility changes

- **`ChatEvent`** has a new `tool` variant. The preload validates events with the shared
  schema, so renderer and main must come from the same build (as always).
- **`ChatEngine.streamChat`** now yields `ChatStreamChunk` (a superset of `GenerateChunk`).
  ADK and plain Legacy still yield only provider chunks.
- **New setting key** `chat.webSearch` (default false). Existing databases need nothing;
  the default applies until it is saved.
- **No changes** to migrations, IPC channels, preload API shape, dependencies,
  `electron-builder.yml`, installer, fuses or default engines.

## 9. Known limitations

- **The 60 s deadline covers the final answer too.** On a slow model a long answer after
  a search can be stopped with a timeout. The plain path is unaffected.
- **Timeline order** shows valid calls first, then calls the provider rejected
  (undeclared names, malformed arguments), not the model's original order.
- **Tool calling needs the model and Ollama to support it** (native tool calls). A model
  that answers without calling the tool simply answers.
- **No result links** in the timeline. URLs appear only as plain text in the answer.
- **Answers are not grounded or verified** (unlike Research). The UI says so.
- **Search queries leave the machine** (SearXNG and its upstream engines). With a remote
  Ollama, results join the conversation sent to that server. Both are disclosed in
  Settings.
- **Edge case fixed during testing:** with less than ~1 KB of turn budget left, a result
  could have been cut through its fence. Calls are now refused with `context-limit`
  below `MIN_RESULT_BYTES`.

## 10. Remaining Windows manual acceptance steps

Not performed; they need a Windows build of this phase.

1. `pnpm check`, then `pnpm package:win`, then `pnpm verify:win-build` (expect 26/26) and
   `pnpm smoke:packaged` (expect 46/46).
2. In a disposable account (see the 7.7.1 checklist), run the installed app:
   - Settings → Agent Engines: "Web search in Chat" is **off**. The note says off.
   - Turn it on without a SearXNG URL: the note says "inactive".
3. With your SearXNG configured and Legacy Chat:
   - ask something current;
   - the timeline shows "Web search … N results" and the answer streams;
   - press Stop during "Searching…": the step shows "Stopped" and no answer follows.
4. Switch Chat to Google ADK: the note says unsupported, and Chat shows no web-search
   steps.
5. Turn the setting off: Chat behaves as before.
6. Remote inference (for steps 3–5) only with your explicit approval, using your own
   endpoint. No local GPU inference, no benchmarks.

## 11. Final Phase 8.2 status

**IMPLEMENTED — automated acceptance PASS. Windows packaged and manual acceptance
pending (§10).**

Not started: ADK tool calling, Research tools for the model, approvals UI, a tool-call
ledger, Phase 8.3. These remain **[FUTURE]** per the Phase 8.1 design.
