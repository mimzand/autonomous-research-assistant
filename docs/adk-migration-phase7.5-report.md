# Phase 7.5 — Research quality, reliability and transparency

All work is deterministic: a scripted model, scripted web/HTTP fixtures and a fake Ollama
server. No local inference, no GPU, no live benchmark, no company endpoint, and the
problematic website was not contacted.

## 1. Root causes

| #   | Issue                                                               | Root cause (confirmed in code)                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "by the local model …" in reports                                   | Hardcoded in `renderReport` (`agent-runtime/src/research/grounding.ts`). The same wording appeared in the task-start log and in the `Local model failed …` step errors (`workflow.ts`). The captured endpoint (`task.input.model.url`) was never used.                                                                                               |
| 2   | Engine not visible                                                  | The pin is stored (`task.input.model.config.researchEngine`), but nothing turned it into a value for the UI. The renderer only had the raw input JSON.                                                                                                                                                                                               |
| 3   | `extraction-failed … Scanned PDFs are not supported` for HTML       | `fetch_source` (`tools/src/web/tools.ts`) raised one generic message whenever the extracted text was empty, for every document kind. Non-2xx responses fail earlier as `http-error`, so the observed failure means **the server answered 2xx with HTML whose visible text, by our extractor's rules, was empty**. The PDF advice was wrong for HTML. |
| 4   | "No contradictions between the sources were found." with one source | `renderReport` printed it whenever the analysis listed none, regardless of how many sources had usable evidence.                                                                                                                                                                                                                                     |
| 5   | Goal requirement not fully met                                      | Nothing in the workflow tracked the goal's explicit requirements. The analysis had only free-text gaps, and the review step checked claim support, not goal completeness.                                                                                                                                                                            |

## 2. Confirmed vs hypotheses

Confirmed:

- Issues 1, 2, 4 and 5: the code paths described above.
- Issue 3: the failing branch, and that the PDF hint was unconditional.

Unresolved (issue 3): why that particular page had no visible text. These can only be
told apart with the live response:

- a bot-protection or challenge page served with HTTP 200
- a page that renders its text with JavaScript
- content wrapped in `<form>`
- content marked hidden (`hidden`, `aria-hidden` or `display:none`)
- an empty body

The extractor now reports which of these it saw. A challenge page is refused instead of
being read. See the optional diagnostic procedure in §10.

## 3. Files changed

| File                                                     | Change                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tools/src/web/extract/html.ts`                 | Counts skipped text by reason (noscript, form, hidden; the text itself is never returned). Adds an `includeForms` fallback option, `looksLikeAccessChallenge()` (conservative: known interstitial title or marker **and** ≤ 1,500 characters of visible text), and `explainEmptyHtml()`. |
| `packages/tools/src/web/fetcher.ts`                      | Rejects challenge pages (web downloads only). Re-reads a page whose only text is inside `<form>`, with form controls still skipped. Records `emptyReason` for every kind; the PDF advice is only given for PDFs.                                                                         |
| `packages/tools/src/web/http-client.ts`                  | New error code `access-blocked`. Non-retryable; never bypassed.                                                                                                                                                                                                                          |
| `packages/tools/src/web/tools.ts`                        | The empty-text error now includes kind, HTTP status, byte size and the specific reason.                                                                                                                                                                                                  |
| `packages/agent-runtime/src/research/schemas.ts`         | `AnalysisSchema.requirements` (defaults to `[]`, so stored analyses stay valid). New `GoalCheckSchema`, `GoalCorrectionSchema` and `RequirementStatus`.                                                                                                                                  |
| `packages/agent-runtime/src/research/goal.ts` (new)      | Pure goal-completeness decisions: resolve the check, choose correction candidates, filter correction paragraphs, apply verified corrections.                                                                                                                                             |
| `packages/agent-runtime/src/research/prompts.ts`         | The analysis asks for the goal's explicit requirements. The report prompt lists them and, with one usable source, forbids claiming agreement. New `goalCheckPrompt` and `goalCorrectionPrompt`. The system prompt no longer says "offline with a local model".                           |
| `packages/agent-runtime/src/research/grounding.ts`       | `modelLocation` in the metadata line (escaped). Contradictions are based on usable sources. New "Goal coverage" section and stats.                                                                                                                                                       |
| `packages/agent-runtime/src/research/workflow.ts`        | Bounded `checkGoal` at the end of the **review** step. The save step takes the location from the **captured** URL. `callModel` takes an optional usage purpose. Neutral start-log and failure wording.                                                                                   |
| `packages/shared/src/dashboard.ts`, `index.ts`           | `ResearchTaskInfoSchema`; `TaskDetails.research`.                                                                                                                                                                                                                                        |
| `apps/desktop/src/main/research-engine.ts`               | `researchTaskInfo(input)`: pinned engine, captured model and location, from the stored input only.                                                                                                                                                                                       |
| `apps/desktop/src/main/dashboard.ts`                     | Adds `research` to the task details.                                                                                                                                                                                                                                                     |
| `apps/desktop/src/renderer/src/pages/TaskDetailPage.vue` | A "Research engine: Legacy / Google ADK · model · Local/Remote Ollama" line, plus rows in the Details card.                                                                                                                                                                              |
| `apps/desktop/src/renderer/src/lib/research.ts`          | Hints for `extraction-failed` and `access-blocked`.                                                                                                                                                                                                                                      |
| `apps/desktop/src/bench/plan.ts`                         | The worst-case workload includes the 3 bounded goal calls. Historical Phase 7.1 numbers are unchanged.                                                                                                                                                                                   |
| Tests                                                    | New: `tools/src/web/extraction-diagnostics.test.ts` (17), `agent-runtime/src/research/phase75.test.ts` (25), and 4 in `research-engine.integration.test.ts`. Updated wording or budgets in `grounding.test.ts`, `workflow.test.ts` and `bench.test.ts`.                                  |

## 4. Architecture decisions

- **No new steps, no migrations.** The goal pass lives inside the existing review step, so
  durable step lists, resume, retry and crash recovery are unchanged. A crash or Retry
  repeats the review step, as before. Results become durable only with the review step's
  output, and the new output fields are optional.
- **Bounded correction:**
  - at most 1 goal check, 1 correction call (for at most 3 requirements, one paragraph
    each) and 1 claim review of those paragraphs; no loop
  - a correction paragraph may cite only its requirement's evidence ids
  - each correction paragraph passes the same unsupported-claim review; rejected text stays
    listed as "Removed", and the gap stays explicit
  - no new sources are fetched
- **Conservative status:**
  - "satisfied" requires a kept, review-verified paragraph that the check names
  - a requirement without valid evidence ends as "insufficient evidence"
  - no verdict counts as not satisfied
- **No extra calls for goals without explicit requirements**, or for analyses stored before
  this phase.
- **Usage rows** for the goal pass use the purposes `research:review:goal-check` and
  `research:review:goal-correction`. The plain `research:review` count is unchanged.
- **Engine and location** for the UI come from the main process's single interpretation of
  the pin (`pinnedEngine`). Unpinned and older tasks are Legacy; ADK is never guessed.
- **Model location** uses the shared `ollamaConnectionLabel`, the same classification as the
  Chat header.

## 5. Improvements implemented

1. **Model location.** Reports say "by the model `…` via Local Ollama / Remote Ollama /
   Ollama from N usable source(s)", based on the endpoint captured when the task started.
   Saved reports are never rewritten.
2. **Engine visibility.** Task details show the pinned engine, model and location. This stays
   correct after a Settings change, Pause/Resume and crash recovery.
3. **Extraction.**
   - **Specific messages:** an empty body, a JavaScript-only page, hidden text, and HTML
     without visible text each get their own reason; the PDF advice appears only for PDFs.
   - **Challenge pages:** refused as `access-blocked` and never saved as evidence.
   - **`<form>`-wrapped pages** are now read.
   - **Unchanged:** HTTP failures and unsupported content types keep their codes; SSRF, redirect, size and timeout rules are unchanged; one failed source still does not stop a task.
4. **Contradictions by usable sources:**
   - **0 sources:** "Not applicable — no usable source evidence."
   - **1 source:** "Not applicable — only one usable source, so sources could not be
     compared." (contradictions inside that source are labelled as such)
   - **2 or more:** the existing analysis, worded with the source count.
5. **Goal completeness.** Explicit requirements are extracted, addressed by the writer,
   checked, corrected once if the evidence supports it, and shown in a "Goal coverage"
   section: Satisfied, Partly satisfied, Not satisfied or Insufficient evidence.

## 6. Deferred

- **Root cause of the specific HTML failure.** It needs the live response; see §10.
- **JavaScript rendering, or a fallback via a headless browser.** That is a heavyweight
  dependency, needs approval, and pages that block bots must not be worked around.
- **Fetching extra sources to fill gaps.** Correction uses existing evidence only, by
  design.
- **Showing the engine in the task list (not only in details).** Small follow-up if wanted.

## 7. Tests and results

| Check               | Result                                            |
| ------------------- | ------------------------------------------------- |
| `pnpm typecheck`    | pass                                              |
| `pnpm lint`         | pass                                              |
| `pnpm format:check` | pass                                              |
| `pnpm test`         | 79 files, **1,081 tests passed** (was 1,035; +46) |
| `pnpm build`        | pass                                              |

Coverage:

- **Metadata:** local, remote, LAN, invalid and missing captured endpoints; a captured
  endpoint different from the current server; a single saved version; escaping.
- **Engine:** Legacy and ADK tasks; Settings changed after creation; Pause/Resume; a restart
  plus crash recovery with `RESEARCH_ENGINE` overriding; tasks without a pin, without a
  captured model, or with an unknown pin.
- **Extraction:**
  - readable HTML; empty, JavaScript-only, hidden and blank pages; the `<form>` fallback
  - challenge pages and false-positive guards
  - an unsupported type and an HTTP 403
  - a scanned PDF; no PDF advice for HTML
  - SSRF blocking before any request
- **Report semantics:** 0, 1 and multiple usable sources; counting from evidence, not
  selection; contradictions within a single source; an end-to-end run with only one useful
  source.
- **Goal:**
  - satisfied, partial, not satisfied, and insufficient evidence
  - correction with sufficient evidence: citations preserved, invented id dropped
  - unsupported correction rejected
  - the bound: 5 unmet requirements still produce one check and one correction for at most 3
  - older analyses unaffected
  - cancel during the check
  - a failed check, then Retry, completes without repeating earlier steps
  - Legacy and ADK send identical requests and store identical results

## 8. Legacy/ADK compatibility

Both engines run the same step machine, prompts, schemas and validation. The new calls go
through the same `callModel` and `ModelProvider` path. The parity test shows identical
request bodies and stored outputs for a full task with the goal pass.

Unchanged:

- engine defaults, pinning format, task data and migrations
- the transport, authentication and ngrok rules
- no autonomous tools and no persistent ADK sessions

Tasks already in progress remain resumable: new fields are optional, and analyses stored
without `requirements` take the old path.

## 9. Remaining risks

- **The model must fill `requirements` well.** The JSON schema marks the field as required,
  but the quality of what it lists is untested against real models. Wrong requirements can
  only add a Goal coverage line; corrections still need verified evidence.
- **Cost.** Typically one extra model call per task (the check), and at most three.
- **Challenge detection is heuristic.** It errs towards false negatives. A challenge page with
  more than 1,500 characters of visible text would still be read; the model and review
  then see it as untrusted text.
- **Duplicate report version after an upgrade.** A task that crashed _after_ saving its
  report under the old code and is resumed under the new code gets a second report version,
  because the wording differs. Earlier versions are kept.
- **Not verified live.** No real model or website was used in this phase.

## 10. Manual Windows acceptance checklist

1. With the company remote model and approval for remote inference, run Research: "Explain
   what SQLite is and list two advantages, using at most two public sources."
2. **Report header:** "by the model `qwen3.5:9b-mlx` via Remote Ollama from N usable
   source(s)".
3. **Task details:** "Research engine: Google ADK" (or Legacy) matches the engine chosen
   when the task was created. Change Settings afterwards: the line does not change.
4. **Goal coverage:** "List two advantages …" is Satisfied, with a cited paragraph (possibly
   under "Requested details"), or shown as an explicit gap.
5. **One usable source:** Contradictions says "Not applicable — only one usable source…".
6. **A failed source:** the timeline shows the specific reason (for example "the page only
   shows text when JavaScript runs" or "Access check"), with no PDF advice for HTML, and the
   task still completes.
7. **Optional diagnosis of the original page (manual, in a normal browser, outside the
   app):** open the URL and view the page source. Check whether its title is "Just a
   moment…" or similar, whether the article text is present in the HTML source or only after
   scripts run, and whether it is inside `<form>` or hidden elements. Do not use scripts,
   proxies or bypass tools.
