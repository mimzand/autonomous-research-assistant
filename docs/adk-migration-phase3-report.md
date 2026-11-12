# ADK Migration — Phase 3 Report

_Google ADK `OllamaLlm` adapter. Date: 2026-11-12._

Nothing in the app uses the adapter yet. Production Chat, Research, the research step machine, IPC, preload and renderer are unchanged. In a packaged Linux build, the app's HTTP requests to Ollama (chat and the background persistence-check task) are byte-identical to the Phase 0 baseline.

## 0. Phase 2 live results: skipped tests

The Windows run of `pnpm test:ollama` reported 16 passed and 2 skipped. Both skips are expected:

| Skipped test                                                                              | Reason                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.live.test.ts` › "a model that does not advertise tools is reported as unsupported" | Runs only when the configured model does **not** advertise tool support. qwen3:8b advertises `tools`, so the test skipped itself with "The configured model advertises tool support." |
| `settings.live.test.ts` › "switches to a second (remote) server at run time"              | `it.runIf(Boolean(OLLAMA_REMOTE_HOST))`: it needs a second Ollama server in `OLLAMA_REMOTE_HOST`, which was not set.                                                                  |

## 1. Adapter architecture

```
ADK Runner ─► LlmAgent ─► OllamaLlm (extends LocalLlm extends ADK BaseLlm)
                              │  request.ts   LlmRequest → GenerateRequest (config, tools, schema)
                              │  messages.ts  Content/Part ⇄ ChatMessage
                              │  schema.ts    GenAI Schema → JSON Schema (Zod preferred)
                              ▼
                        OllamaProvider snapshot (Phase 2) ─► Ollama /api/chat
```

**`OllamaLlm`:**

- **Location:** `packages/adk-runtime/src/ollama/ollama-llm.ts`.
- **Construction:** `new OllamaLlm({ provider, contextLength?, timeoutMs?, idleTimeoutMs? })`.
- **One HTTP client:** there is no second Ollama HTTP client. The adapter calls `provider.snapshot()`, so every model call of an agent uses the same server, model, token, limits and tool-calling flag.
- **Snapshot isolation:** a later Settings change does not affect an agent that already exists (tested).
- **Unchanged provider policy:** host and URL validation, the TLS rule for the token, redirect refusal, timeouts, idle timeout, `AbortSignal`, and the `allowToolCalls` gate all come from `OllamaProvider`.
- **Model is the configured one:** the model name is the provider's configured model; nothing is hardcoded. Agents receive the `OllamaLlm` instance, never a model string. The guard rejects strings and missing models.
- **Errors:** errors become ADK `errorCode`/`errorMessage` responses.

| Error source | ADK error codes                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider     | `OLLAMA_UNAVAILABLE`, `OLLAMA_MODEL_NOT_FOUND`, `OLLAMA_TIMEOUT`, `OLLAMA_UNSUPPORTED`, `OLLAMA_INVALID_REQUEST`, `OLLAMA_INVALID_RESPONSE`, `OLLAMA_HTTP_ERROR` |
| Adapter      | `OLLAMA_UNSUPPORTED_CONTENT`, `OLLAMA_UNSUPPORTED_CONFIG`, `OLLAMA_SCHEMA_CONVERSION`, `OLLAMA_INVALID_TOOL_CALL`, `OLLAMA_INVALID_STRUCTURED_OUTPUT`            |

A cancelled call returns nothing; ADK reports the abort itself as `INVOCATION_ABORTED`.

**Guard changes (`guards.ts`):**

- **`outputKey` is now rejected,** because ADK would store unvalidated model output in session state.
- **Test-only `allowedTools` option:** admits the exact tool instances listed.
- **Enforcement:**
  - No shipped source passes `allowedTools` (guard test).
  - `FunctionTool` is still not exported by the facade and is still prohibited in shipped code.
  - The production provider keeps `allowToolCalls` off, so even an allowed tool fails with `OLLAMA_UNSUPPORTED` against it (tested).

## 2. Files

**Created (`packages/adk-runtime`):**

| File                                               | Purpose                                         |
| -------------------------------------------------- | ----------------------------------------------- |
| `src/ollama/ollama-llm.ts`                         | The adapter class.                              |
| `src/ollama/request.ts`                            | Request and generation-config mapping.          |
| `src/ollama/messages.ts`                           | Message conversion.                             |
| `src/ollama/schema.ts`                             | Schema conversion.                              |
| `src/ollama/errors.ts`                             | Error codes.                                    |
| `src/structured.ts`                                | `structuredOutput()` and `finalResponseText()`. |
| `src/testing/fake-ollama.ts`                       | Test-only HTTP fake.                            |
| `src/ollama/conversion.test.ts`                    | Unit tests for conversion.                      |
| `src/ollama/ollama-llm.runner.test.ts`             | Real ADK Runner tests.                          |
| `src/ollama/ollama-llm.live.test.ts`               | Live tests.                                     |
| `vitest.live.config.ts`                            | Live test configuration.                        |
| `docs/adk-migration-phase3-report.md` (repository) | This report.                                    |

**Modified:**

| File                                                     | Change                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/adk-runtime/src/adk.ts`                        | Type aliases derived from ADK, so no import of `@google/genai`.      |
| `packages/adk-runtime/src/engine.ts`                     | Exports.                                                             |
| `packages/adk-runtime/src/guards.ts` (+ test)            | The guard changes above.                                             |
| `packages/adk-runtime/src/security.test.ts`              | `allowedTools` scan.                                                 |
| `packages/adk-runtime/package.json`                      | `@rka/model-provider` dependency, `zod` dev dependency, `test:live`. |
| `packages/adk-runtime/tsconfig.json`, `vitest.config.ts` | Live tests excluded from `pnpm test`.                                |
| root `package.json`                                      | `test:adk:ollama`.                                                   |
| `pnpm-lock.yaml`                                         | Only the two workspace entries above; no external package changed.   |

## 3. Message conversion

**ADK → Ollama, via provider messages:**

- `config.systemInstruction` (string, Content or parts) becomes one leading system message.
- **User content:**
  - Text parts become a user message.
  - Each `functionResponse` becomes a tool message with its **id**, function name and JSON result, in the original order.
- **Model content:**
  - Text becomes assistant text.
  - Each `functionCall` becomes an assistant tool call, keeping its **id**, name and arguments.
- **`thought` parts** are deliberately not sent back to the model (tested).
- **Rejected, never dropped** (`OLLAMA_UNSUPPORTED_CONTENT`):
  - images and other inline data, files, executable code and code results;
  - function calls or responses without an id;
  - invalid function names;
  - unknown roles.

**Ollama → ADK:**

- Thinking (only when requested) becomes a `thought` part.
- Text becomes a text part.
- Each tool call becomes a `functionCall` part with the server's id, so the tool result is matched to the same id. The live Ollama 0.40.14 sends ids.

## 4. Schema conversion

**Source of the JSON Schema (authoritative first):**

1. `responseJsonSchema`, or a declaration's `parametersJsonSchema`.
2. The tool's own **Zod** schema: ADK `FunctionTool.parameters`, converted losslessly. `additionalProperties: false` and numeric limits are kept.
3. ADK's GenAI `Schema`, converted.

**GenAI → JSON Schema conversion:**

- Supported:
  - types `OBJECT`, `ARRAY`, `STRING`, `NUMBER`, `INTEGER`, `BOOLEAN` and `NULL`;
  - `properties`, `required`, `items`, `enum`, `anyOf`/`allOf`/`oneOf`, `nullable` (becomes `type: [t, "null"]`);
  - `minimum`/`maximum`, OpenAPI boolean exclusive bounds (converted to JSON Schema numeric bounds), `multipleOf`, `pattern`, `format`, `description`, `title`, `default` and `const`;
  - string-typed `minLength`/`maxLength`/`minItems`/`maxItems`/`minProperties`/`maxProperties`, converted to integers.
- **Dropped deliberately** (no validation meaning): `propertyOrdering` and `example`.
- **Errors** (`OLLAMA_SCHEMA_CONVERSION`): unknown types or keywords (e.g. `$ref`), non-integer limits, arrays without `items`, schemas without a type, empty enums, and exclusive flags without a bound.
- **Known loss in ADK's own GenAI path:** `additionalProperties` is already lost before the adapter sees the schema. The adapter avoids that path whenever the Zod schema is available. The `structuredOutput()` helper always sends the Zod-derived schema.

## 5. Streaming

- **SSE mode:** each text delta becomes an ADK `partial` event. Then **one** final event carries the complete text, the tool calls, `finishReason` (`STOP`, `MAX_TOKENS` or `OTHER`) and usage.
- **No duplicate text:** ADK stores only the final event, so the session holds the text once (tested). A UI must render partials and treat the final event as the result.
- **Tool calls:** they are only ever in the final, non-partial event. They are never emitted from a partial chunk, an interrupted stream, a malformed stream or a cancelled run.
- **Regression fixture:** the Phase 2 live probe shape is used as a fixture: the tool call arrives in chunk 0 of 2, with an id, an index and object arguments.

## 6. Tool calling

**Mocked HTTP results (real ADK Runner):**

- **Calculator round trip (streaming and non-streaming):**
  1. ADK declares the calculator; the Zod-derived JSON Schema is sent to Ollama.
  2. The model's call arrives as `functionCall` id `call_live_1`.
  3. The test-only calculator is **executed exactly once** with `{multiply, 125, 48}`.
  4. ADK's `functionResponse` `{result: 6000}` returns to Ollama as a tool message with `tool_call_id: call_live_1`.
  5. The final answer is "125 multiplied by 48 is 6000."
- **Malformed arguments or an unknown tool:** the response becomes `OLLAMA_INVALID_TOOL_CALL`, no `functionCall` is emitted, and **no tool runs** (fail closed).
- **Arguments failing the tool's Zod schema** (e.g. `operation: "power"`): ADK refuses to execute and returns an error result to the model.
- **Production provider** (tool calling off): `OLLAMA_UNSUPPORTED`; no request reaches Ollama and no tool runs.

## 7. Cancellation

| Scenario                                                                                            | Result                                                                                                   |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Abort mid-stream                                                                                    | The fake server sees its HTTP connection closed. The run ends with `INVOCATION_ABORTED`; no final event. |
| Abort while a tool-call response is streaming (the tool-call line arrived, the final chunk had not) | **Tool not executed**, no `functionCall` emitted, `INVOCATION_ABORTED`.                                  |
| Abort before the run                                                                                | No request is sent to Ollama.                                                                            |
| Timeout                                                                                             | `OLLAMA_TIMEOUT`                                                                                         |
| Dropped connection                                                                                  | `OLLAMA_UNAVAILABLE` or `OLLAMA_INVALID_RESPONSE`                                                        |
| Ollama unreachable                                                                                  | `OLLAMA_UNAVAILABLE`                                                                                     |

## 8. Structured output

- **Adapter check:** for a structured request, the final text must parse as JSON (`extractJson` tolerates think tags and code fences). Otherwise the response becomes `OLLAMA_INVALID_STRUCTURED_OUTPUT`, nothing reaches the session as a result, and `finalResponseText()` returns `undefined`.
- **Application boundary:** `structuredOutput(zodSchema).parse(text)` validates with the same Zod schema. It is the only way a structured result is accepted. Tested cases:
  - valid output (including fenced) is accepted;
  - a missing field, a wrong type or an extra field (strict schema) is rejected;
  - non-JSON output is rejected.
- **ADK paths:** both work and are validated the same way:
  - ADK's `outputSchema` (GenAI schema converted);
  - `structuredOutput().beforeModelCallback` (lossless Zod JSON Schema).
- **`outputKey`** is rejected by the guard.
- **Tools and structured output** are not combined in one agent, because ADK's `set_model_response` workaround for non-Gemini models is unverified.

## 9. Automated tests

| Check                                | Result                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| `pnpm typecheck`                     | pass                                                                  |
| `pnpm lint`                          | pass                                                                  |
| `pnpm format:check`                  | pass                                                                  |
| `pnpm test`                          | pass: 57 files, 736 tests (Phase 2: 55 / 698)                         |
| `pnpm build`                         | pass                                                                  |
| `pnpm package:dir` (Linux)           | pass                                                                  |
| Packaged Electron smoke test (Linux) | ADK self-check passes; app→Ollama requests byte-identical to baseline |

New `adk-runtime` tests:

- **`conversion.test.ts` (11):**
  - GenAI schema conversion, including ADK's real Zod → GenAI output, and its failure cases;
  - message conversion, including ordering, ids, thought handling and multimodal rejection;
  - config mapping and rejection;
  - Zod-first tool schemas.
- **`ollama-llm.runner.test.ts` (23):** the real ADK `Runner`, real `OllamaProvider` and real HTTP, covering scenarios A–F and every error case.
- **Guards (+3) and security (+1).**

## 10. Live Ollama tests

The user ran `pnpm test:adk:ollama` on Windows (2026-11-12) against **Ollama 0.40.14** with **qwen3:8b** at `http://127.0.0.1:11434`, using the real ADK Runner and `OllamaLlm`. **Result: 8 of 8 passed** (1 file, 15.4 s).

| Test                                                  | Live result                                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server / model                                        | Ollama 0.40.14, qwen3:8b, tools advertised: yes                                                                                                                                         |
| Basic generation and usage metadata                   | Text "READY". Usage: prompt 49, candidates 2, total 51. `finishReason` STOP.                                                                                                            |
| Streaming                                             | 9 partial events and 1 final event. Final text "1 2 3 4 5".                                                                                                                             |
| Tool round trip, non-streaming                        | ADK received `functionCall` id `call_02afxqmr` with `{a: 125, b: 48, operation: "multiply"}`. The calculator ran once. Answer: "The result of 125 multiplied by 48 is 6000." No errors. |
| Tool round trip, streaming                            | Same, with id `call_99hqv5m5`. The calculator ran once. Same answer. No errors.                                                                                                         |
| Structured output (Zod-validated at the app boundary) | `ok: true`. Topic plus 3 questions.                                                                                                                                                     |
| Cancellation                                          | `INVOCATION_ABORTED` after 2 events (235 ms).                                                                                                                                           |
| Cancellation during a tool request                    | `INVOCATION_ABORTED`; calculator executed 0 times.                                                                                                                                      |
| Missing model                                         | `OLLAMA_MODEL_NOT_FOUND`                                                                                                                                                                |

What the live run showed:

- **ADK warning on cancellation.** ADK logged `The last event is partial, which is not expected.` during the cancellation test. The run was aborted right after a partial text event, so no final event followed it. ADK reports the run as `INVOCATION_ABORTED`, as expected. The warning is informational, but later phases should not treat it as an error.
- **What the tool-cancellation test proved.** It finished in 32 ms. The abort at 20 ms most likely happened before qwen3:8b had produced any of the tool call. Live, it proves that a run cancelled during a tool request never executes the tool. Cancelling _after_ the tool-call chunk has arrived but before the stream ends is covered deterministically by the mocked HTTP test (§7), not by this live test.

## 11. Security checks

- **Phase 1 guards still pass:**
  - only `adk.ts` imports `@google/adk`;
  - no Google client library imports;
  - no prohibited ADK classes in shipped code;
  - environment sanitisation and network-isolation tests;
  - no `allowToolCalls` or tool harness in shipped code.
- **New guards:**
  - `outputKey` rejected;
  - `allowedTools` absent from shipped code;
  - the adapter rejects custom `httpOptions.baseUrl`, `headers` or `fetch`, so ADK cannot redirect the transport;
  - non-function tools (e.g. Google Search) are rejected.
- **Bundle:**
  - The ADK engine chunk is 2.57 MB (+23 KB vs Phase 1).
  - `child_process` still comes only from `google-auth-library` (unreachable without a Gemini/Vertex model).
  - `UnsafeLocalCodeExecutor`, `ContainerCodeExecutor`, `AgentEngineSandboxCodeExecutor` and `LocalEnvironment` remain absent from the bundle.
- **Logs:** no secrets are logged. Error messages come from the provider, which never includes the token.

## 12. Known limitations and remaining risks

- **Live coverage is one server and model:** Ollama 0.40.14 with qwen3:8b only. Other models may call tools differently.
- **Benign ADK warning on cancellation:** ADK logs "The last event is partial" when a stream is cancelled after a partial event (see §10).
- **Duplicate final text in streaming mode:** the final event repeats the streamed text (ADK convention). The Phase 4 chat bridge must render partials and not append the final text again.
- **Invalid tool calls fail the whole turn:** a single invalid tool call rejects every call in that turn (fail closed). The model is not given a chance to correct it within the same ADK turn.
- **Thinking with tools and multi-turn tool loops** are untested live.
- **Unvalidated JSON reaches the session:** the adapter checks only that structured output is valid JSON. Schema validation must happen through `structuredOutput().parse()`, and Phase 4 code must never read ADK session state as a validated result.
- **Tools plus structured output in one agent** is not supported.
- **Live cancellation-during-tool test is timing-based:** it aborts 20 ms after the request starts. That is reliable for a local 8B model; a much faster server could finish first. The mocked test covers the case deterministically.
- **Windows Electron smoke test** (dev and packaged) is still pending.
