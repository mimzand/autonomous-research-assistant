# ADK Migration — Phase 2 Report

_Ollama provider: tool calling. Date: 2026-11-12._

Chat, Research and the research step machine are unchanged and do not use tools. ADK is not wired to the provider yet.

## 1. Provider capabilities added

**Contract (`packages/model-provider/src/schemas.ts`, Zod-validated):**

| Type              | Purpose                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ToolDefinition`  | Name (letters, digits, `_`, `-`), description, and JSON Schema `parameters` with type `object`.                                            |
| `ToolCall`        | Id, name, and parsed JSON-object `arguments`.                                                                                              |
| `InvalidToolCall` | Id, name, reason (`unknown-tool` or `malformed-arguments`), message and raw arguments.                                                     |
| `ChatMessage`     | Now also covers assistant turns with `toolCalls` and `tool` result messages (`toolCallId`, `name`, `content`).                             |
| `GenerateRequest` | New `tools` field, up to 64. Validation rejects duplicate tool names, duplicate call ids and tool results without a matching earlier call. |
| `GenerateResult`  | Optional `toolCalls` and `invalidToolCalls`, present only when non-empty.                                                                  |

The following are unchanged, so existing code is untouched:

- the `ModelProvider` interface;
- `GenerateChunk`;
- `FinishReason`;
- text and structured-output generation.

**Helpers (`src/tools.ts`):**

- `defineTool` builds a tool definition from a Zod schema.
- `validateToolArguments` checks arguments against the Zod schema.
- `toolResultMessage` and `toolErrorMessage` build tool-result messages.
- `assistantToolCallMessage` builds the assistant turn to put back into the history.

None of these executes a tool.

**`OllamaProvider`:**

- **Off by default:**
  - Tool calling is disabled unless the provider is created with `allowToolCalls: true`.
  - Without it, any request with tools or tool history is rejected (`unsupported`) before contacting the server.
  - The app never sets this flag, and a guard test enforces that.
- **Request translation:** `tools`, assistant `tool_calls` and `tool` messages (`tool_name` and `tool_call_id`) are translated to Ollama's native `/api/chat` format.
- **Version check:** tool requests need Ollama 0.3.0 or newer. The provider makes a single `/api/version` call, shared with structured output.
- **Parsing calls:**
  - Arguments may be a JSON object or a JSON string.
  - Missing or duplicate server ids are replaced with generated ids.
  - A call re-sent with the same `index` replaces the earlier one.
  - Calls to undeclared tools and malformed arguments are returned as `invalidToolCalls`, so the caller can send the error back to the model.
- **Tool support check:** `checkToolSupport(model)` uses `/api/version` and `/api/show` and returns `advertised: yes | no | unknown`.
- **Unchanged:** authentication (token only over HTTPS or loopback), timeouts, idle timeout, AbortSignal, redirect refusal, host validation and error mapping. A `does not support tools` response (HTTP 400) maps to `unsupported`.

## 2. Streaming behaviour

- Text deltas stream as before.
- Tool calls are **accumulated and returned only in the final `done` chunk**, after the complete response has been received and every call parsed.
- A stream that is cancelled, times out, drops its connection, reports an in-stream error, or ends without `done` delivers **no** tool calls.
- This works the same whether a server sends tool calls in a middle chunk (streamed tool calls, Ollama 0.8.0+) or only in the final chunk (older servers).

## 3. Model capability detection

`checkToolSupport()` distinguishes three cases:

- **Advertised:** `capabilities` includes `tools`.
- **Not advertised:** `capabilities` without `tools`. The live tests skip the tool tests and check that a tool request is rejected as `unsupported`.
- **Unknown:** the server reports no capabilities.

Advertised support is not treated as proof. Only a successful round trip in `pnpm test:ollama` counts as verified.

## 4. Test harness

`src/testing/tool-harness.ts` is test-only: it is not exported from the package and is not imported by shipped code (guard test).

The calculator tool (`add`, `subtract`, `multiply`, `divide`; plain arithmetic, no expression evaluation) runs this loop:

1. Send the request with the tool definitions.
2. Receive the tool calls.
3. Validate the arguments with Zod.
4. Execute the tool.
5. Send the results back.
6. Repeat, up to the round limit.

Invalid arguments and unknown tools are never executed; the model receives an error result instead.

## 5. Automated tests

| Check                      | Result                                        |
| -------------------------- | --------------------------------------------- |
| `pnpm typecheck`           | pass                                          |
| `pnpm lint`                | pass                                          |
| `pnpm format:check`        | pass                                          |
| `pnpm test`                | pass: 55 files, 698 tests (Phase 1: 53 / 663) |
| `pnpm build`               | pass                                          |
| `pnpm package:dir` (Linux) | pass                                          |

New test files:

- **`tools.test.ts` (mocked fetch, 29 tests)** covers:
  - serialisation of definitions, history and results;
  - request validation;
  - the off-by-default gate;
  - non-streaming parsing: multiple calls, missing or duplicate ids, string, malformed, array and number arguments, unknown tools, missing names;
  - streaming: deltas plus final-chunk delivery, calls across chunks, index replacement, early end and in-stream errors;
  - servers older than 0.3.0 and models without tool support;
  - `checkToolSupport` returning yes, no and unknown;
  - pre-cancellation;
  - helpers;
  - calculator round trips (streaming and non-streaming, including rejected calls and the round limit);
  - text-only and structured-output regression.
- **`tools.integration.test.ts` (real HTTP, 5 tests)** covers:
  - a streamed calculator round trip that yields 6000;
  - cancellation after a tool call arrived (the connection closes and nothing is delivered);
  - an idle timeout after a tool call;
  - a dropped connection;
  - a non-streaming timeout.
- **`security-guards.test.ts`:** no shipped source sets `allowToolCalls`, and the harness is never imported or exported.
- **Unchanged and passing:** all existing text, streaming and structured-output tests.

**Electron smoke test (Linux, packaged):**

- The app starts.
- ADK self-check passes.
- Chat, the persistence-check task and the integrity check all work.
- The HTTP requests the app sends to Ollama are **byte-identical** to the Phase 0 baseline build, with no `tools` field in any request.

## 6. Live Ollama tests

Run by the user on Windows (`pnpm test:ollama`, 2026-11-12) against **Ollama 0.40.14** with **qwen3:8b** on `http://127.0.0.1:11434`.

**Result:** 3 files, 16 tests passed, 2 skipped. Both skips are expected:

- the `unsupported` check, which applies only to models that do not advertise tools;
- one existing `settings.live.test.ts` check that runs only when a remote server is configured.

| Check                                                                                              | Result                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools advertised (`/api/show`)                                                                     | yes                                                                                                                                                                                                     |
| Raw streaming probe                                                                                | 2 chunks. The tool call arrived in chunk 0, a non-final chunk, so the server streams tool calls. The server sends call ids and `function.index`. `arguments` is a JSON object. `done_reason` is `stop`. |
| Non-streaming round trip                                                                           | `calculator` called with `{"operation":"multiply","a":125,"b":48}` → `{"result":6000}`. Answer: "The result of 125 multiplied by 48 is **6000**."                                                       |
| Streaming round trip                                                                               | same call and result; same answer                                                                                                                                                                       |
| Cancel a streaming tool request                                                                    | pass                                                                                                                                                                                                    |
| Existing live tests (generate, stream, structured output, cancel, missing model, runtime settings) | pass                                                                                                                                                                                                    |

**What this confirms about the wire format:**

- Ollama 0.40.14 sends tool calls with ids, indexes and object arguments.
- It accepts tool results sent with `tool_name` and `tool_call_id`, because the model answered from the returned result in both round trips.
- Holding streamed tool calls until the final chunk works with a server that sends them mid-stream.

## 7. Windows verification

**Partially verified.** The provider's live tests ran on Windows with Node and passed (§6). The Electron app itself has not yet been checked on Windows: dev mode, the packaged build, ADK start-up, Chat, SQLite and Research. See [the Windows smoke-test procedure](adk-migration-windows-smoke-test.md).

## 8. Known limitations

- **Tested on one server and model only:** the live results cover Ollama 0.40.14 with qwen3:8b. Other models and older servers may format tool calls differently. The provider accepts string arguments and missing ids, but those cases are tested with mocks only.
- **Version cutoffs not verified live:** the 0.3.0 minimum for tools and 0.8.0 for streamed tool calls come from Ollama's release history.
- **Semantic validation is the caller's job:** the provider checks structure only (known tool name, JSON-object arguments). Schema validation of arguments is done with Zod by the caller (`validateToolArguments`), not against the JSON Schema.
- **Tool calling depends on the model:** small local models may answer without calling the tool, or call it with wrong arguments. The harness feeds errors back, with a round limit.
- **`think: true` with tools is untested live.**
