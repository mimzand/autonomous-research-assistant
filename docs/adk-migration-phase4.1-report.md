# ADK Migration — Phase 4.1 Report

_Tool outcome integrity and approval-safe responses. Date: 2026-11-12._

The change stays inside the ADK tool boundary (`packages/adk-runtime`). Production Chat, Research, IPC, preload, renderer and the database are unchanged, and tool calling is still off in production. In a packaged Linux build, the app's HTTP requests to Ollama are byte-identical to the baseline.

## 1. Root cause

In the Phase 4 live run, the bridge behaved correctly:

- `publish_note` was refused with `status: "approval_required"`;
- the ToolRegistry never ran it.

The failure was at the boundary. The only "result" of an ADK run was the model's final text, and nothing in the app turned the real tool outcomes into an authoritative result. The model reacted to the `approval_required` tool result with the free text "The note has been approved. Let me publish it for you.", and that text would have been shown as if it were the outcome.

Prompt wording cannot prevent this. A model can always write such a sentence, in any language, so the fix must not depend on the model's text.

## 2. Outcome tracking design

**What is recorded.** `ToolOutcomeTracker` (`src/tools/outcomes.ts`) is per-invocation and in memory. `RegistryTool` records one `ToolOutcome` per tool call at the moment the call finishes:

| Field              | Meaning                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invocationId`     | The ADK invocation.                                                                                                                                                                                                          |
| `callId`           | The model's function-call id.                                                                                                                                                                                                |
| `tool`             | The tool name.                                                                                                                                                                                                               |
| `status`           | The bridge status: `ok`, `approval_required`, `approval_denied`, `failed`, `timeout`, `cancelled`, `invalid_input`, `invalid_output`, `limit_exceeded`, `duplicate_call`, `result_too_large`, or `not_executed` (see below). |
| `approval`         | `not_required`, `required`, `granted` or `denied`.                                                                                                                                                                           |
| `executionStarted` | Set immediately before `ToolRegistry.execute` is called; false for every refusal before that point.                                                                                                                          |
| `succeeded`        | True only when the registry returned a validated result and the run was not cancelled.                                                                                                                                       |
| `reason`           | The safe, redacted error message.                                                                                                                                                                                            |

**Reconciliation.** `summarizeInvocation(events, tracker)` matches every `functionCall` in the run's events, by call id, against the recorded outcomes. A call with no record never reached a tool and is reported as `not_executed`. The presence of a function call is never treated as an execution. Several calls are reported individually, in order.

## 3. Authoritative status precedence

The first matching rule wins.

| #   | Status                | When                                                                                                                                                                              |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `cancelled`           | The run was aborted (`INVOCATION_ABORTED`), or any call was cancelled.                                                                                                            |
| 2   | `approval_denied`     | Any call was denied.                                                                                                                                                              |
| 3   | `approval_required`   | Any call still needs approval (no resolver, or approval pending).                                                                                                                 |
| 4   | `limit_exceeded`      | Any call hit the call budget or the repeated-call limit.                                                                                                                          |
| 5   | `failed`              | The adapter or model reported an error (e.g. an undeclared tool, invalid structured output); or the run ended without a final answer; or tools were requested and none succeeded. |
| 6   | `partially_completed` | Some calls succeeded and some did not. Every outcome is preserved.                                                                                                                |
| 7   | `completed`           | Every requested call succeeded, or no tool was requested, and the model gave a final answer.                                                                                      |

Consequences:

- A missing approval outranks partial success.
- A cancellation outranks everything else.
- A call that was never executed is never reported as executed.

## 4. User-visible response behaviour

`InvocationResult` contains:

| Field         | Content                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | The authoritative status.                                                                                                                   |
| `message`     | Deterministic and app-generated, built only from the outcomes. For example: `Not done: "publish_note" needs your approval and was not run.` |
| `outcomes`    | Every call, individually.                                                                                                                   |
| `modelText`   | The model's final answer, **only when the status is `completed`**.                                                                          |
| `diagnostics` | `rawModelText`, redacted with the app's `redactText`, plus the error codes. For logs and tests only.                                        |

**Rules:**

- **Withheld when blocked:** for every blocked, failed, partial, cancelled or limited run, the model's text is withheld from the result entirely. No phrase search is used, so the behaviour is the same in every language.
- **Facts stay separate when completed:** when the status is `completed`, the model's text is passed through, but the status and message remain the facts. Example: if the tool succeeded and the model claims it failed, the status is still `completed`, with the message `Done: "calculator" completed successfully.`.
- **No tool requested:** the message is `Answered without running any tools.`, so an action the model merely claims is not confirmed by the app.

## 5. Automated tests

| Check                      | Result                                        |
| -------------------------- | --------------------------------------------- |
| `pnpm typecheck`           | pass                                          |
| `pnpm lint`                | pass                                          |
| `pnpm format:check`        | pass                                          |
| `pnpm test`                | pass: 59 files, 777 tests (Phase 4: 58 / 758) |
| `pnpm build`               | pass                                          |
| `pnpm package:dir` (Linux) | pass                                          |

`outcomes.runner.test.ts` (19 tests) runs the real ADK Runner, `OllamaLlm`, `OllamaProvider` (real HTTP to a fake Ollama), `ToolRegistry` and `RegistryTool`, with a scripted model that lies. It covers:

| #     | Case                                                                                       | Status                                                                                                | Model text                                 |
| ----- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1 / 4 | False approval and publication claims in **English, Persian, German, Chinese and Spanish** | `approval_required`; not executed; deterministic message                                              | withheld; raw kept redacted in diagnostics |
| 2     | Success claimed after a real failure                                                       | `failed`                                                                                              | withheld                                   |
| 3     | Failure claimed after a real success                                                       | `completed`; message states the success                                                               | passed as the model's answer               |
| 5     | Denied (and, as a control, granted)                                                        | `approval_denied`, not executed (granted: `completed`, executed once)                                 | —                                          |
| 6     | Tool failure                                                                               | `failed`                                                                                              | —                                          |
| 7     | Timeout                                                                                    | `failed`; outcome `timeout` with `executionStarted: true`                                             | withheld                                   |
| 8     | Cancellation                                                                               | `cancelled`                                                                                           | withheld                                   |
| 9     | Mixed outcomes                                                                             | ok + failed → `partially_completed`, both outcomes listed; ok + approval needed → `approval_required` | —                                          |
| 10    | Undeclared tool                                                                            | `failed` (`OLLAMA_INVALID_TOOL_CALL`); no outcomes; nothing executed                                  | —                                          |
| 11    | No tool requested                                                                          | `completed`, message "Answered without running any tools."                                            | —                                          |
| 12    | Legitimate success                                                                         | `completed`                                                                                           | passed                                     |

Also tested:

- `limit_exceeded` from a repeated identical call;
- a function call that never reached a tool is reported as `not_executed`;
- the diagnostic model text is redacted.

## 6. Live Ollama tests

`pnpm test:adk:ollama` now includes "Phase 4.1 regression: the authoritative result says approval_required, whatever the model claims". It repeats the Phase 4 approval prompt (real Runner, OllamaLlm, RegistryTool, ToolRegistry and the configured model) and asserts:

- `publish_note` was not executed;
- `status` is `approval_required`;
- `message` is exactly `Not done: "publish_note" needs your approval and was not run.`;
- no outcome started or succeeded;
- `modelText` is undefined.

It prints the redacted raw model text for diagnostics only.

**Status: unverified in this environment** (no real Ollama reachable). The test was dry-run against a stand-in that answers with the false claim "The note has been approved. Let me publish it for you."; it passed.

Windows command:

```powershell
cd C:\Users\zandm\Projects\Algoalliance\sample-agent
pnpm install
pnpm test:adk:ollama
```

## 7. Security regression results

- **All earlier guards pass:**
  - ADK imported only by the facade;
  - no Google client imports and no prohibited ADK classes;
  - environment sanitisation and network isolation;
  - `RegistryTool` admitted only by type and identity;
  - no production wiring of bridged tools;
  - `outputKey` rejected;
  - no `allowToolCalls`, tool harness or `allowedTools` in shipped code;
  - the Electron source guards.
- **Bundle:** no new modules; `child_process` still comes only from `google-auth-library`; no code-executor or `LocalEnvironment` modules.
- **Approvals:** no approval is inferred from model or user text, nothing is auto-approved, and no approval UI or resume mechanism was added.

## 8. Files changed

**Created:**

- `packages/adk-runtime/src/tools/outcomes.ts`
- `packages/adk-runtime/src/tools/outcomes.runner.test.ts`
- `docs/adk-migration-phase4.1-report.md`

**Modified:**

| File                                                        | Change                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/adk-runtime/src/tools/registry-tool.ts`           | Optional `outcomes` tracker. Records approval state, execution start and the final status per call. Results unchanged. |
| `packages/adk-runtime/src/tools/registry-tool.live.test.ts` | The live regression test.                                                                                              |
| `packages/adk-runtime/src/engine.ts`                        | Exports.                                                                                                               |

## 9. Remaining risks

- **The boundary is only a library so far.** Phase 5 code that shows ADK results must use `summarizeInvocation` and display `status`/`message`, never the raw final text. A guard for that can be added when the consumer exists.
- **A completed answer can still contain false text.** In `completed` runs the model's answer is shown with its own wording, which may still say something false (e.g. "it failed"). The authoritative status and message must be displayed next to it.
- **Persuasion without a tool call is not detected.** If the model claims an action without calling any tool, the run is `completed` with "Answered without running any tools.". The app does not know the user wanted a tool to run; only the message makes that visible.
- **The tracker is in memory, per process,** and keeps up to 100 invocations.
- **Live regression unverified** until `pnpm test:adk:ollama` is run on Windows.
