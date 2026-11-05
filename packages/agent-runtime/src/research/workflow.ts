import {
  generateObject,
  isModelProviderError,
  type ChatMessage,
  type ModelProvider,
} from '@rka/model-provider';
import { type JsonValue, type Storage, type TaskRecord, type TaskStepRecord } from '@rka/storage';
import {
  canonicalizeUrl,
  FetchSourceOutputSchema,
  parsePublicUrl,
  type ToolRegistry,
  WebSearchOutputSchema,
} from '@rka/tools';
import { z } from 'zod';
import {
  cleanAnalysis,
  draftParagraphs,
  groundClaims,
  indexEvidence,
  renderReport,
  type DraftParagraph,
  type EvidenceItem,
  type GroundedClaim,
  type SourceRef,
  type Verdict,
} from './grounding.js';
import {
  analysisPrompt,
  evidencePrompt,
  planPrompt,
  reportPrompt,
  reviewPrompt,
} from './prompts.js';
import {
  AnalysisSchema,
  RESEARCH_TASK_KIND,
  ReportDraftSchema,
  ResearchLimitsSchema,
  ResearchPlanSchema,
  ResearchRequestSchema,
  ResearchTaskInputSchema,
  ReviewSchema,
  SourceEvidenceSchema,
  type Analysis,
  type ReportDraft,
  type ResearchLimits,
  type ResearchRequest,
  type ResearchTaskInput,
} from './schemas.js';

export const PAUSED_MESSAGE = 'Paused by the user. Resume to continue from the current step.';
const CANCELLED_MESSAGE = 'Cancelled by the user.';
/** Evidence items given to the model in the compare/report steps (context window). */
const MAX_EVIDENCE_ITEMS = 40;
const REVIEW_BATCH = 8;

export type StepKind =
  'plan' | 'search' | 'select' | 'fetch' | 'evidence' | 'analyze' | 'report' | 'review' | 'save';

export interface ResearchProgress {
  readonly completed: number;
  readonly total: number;
  /** True while the final number of steps is not known yet (before sources are chosen). */
  readonly estimated: boolean;
  readonly current: { readonly seq: number; readonly name: string; readonly kind: string } | null;
}

export interface ResearchEvent {
  readonly type: 'task' | 'step-started' | 'step-completed' | 'step-failed' | 'source';
  readonly taskId: string;
  readonly taskStatus: TaskRecord['status'];
  readonly progress: ResearchProgress;
  readonly message?: string;
}

export interface ResearchAgentDeps {
  readonly storage: Storage;
  readonly modelProvider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly onEvent?: (event: ResearchEvent) => void;
  /** Defaults for limits not given in a request. */
  readonly defaults?: Partial<ResearchLimits>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class ResearchStepError extends Error {
  override readonly name = 'ResearchStepError';
}

export function isResearchTask(task: Pick<TaskRecord, 'input'>): boolean {
  const input = task.input;
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    input['kind'] === RESEARCH_TASK_KIND
  );
}

export const isPausedTask = (task: Pick<TaskRecord, 'status' | 'error'>) =>
  task.status === 'interrupted' && task.error === PAUSED_MESSAGE;

// --- Step outputs (persisted) ---------------------------------------------------------

const QuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  searchQueries: z.array(z.string()),
});
const PlanOutput = z.object({
  title: z.string(),
  objective: z.string(),
  questions: z.array(QuestionSchema),
});
const SearchOutput = z.object({
  questionId: z.string(),
  results: z.array(z.object({ url: z.string(), title: z.string(), snippet: z.string() })),
  errors: z.array(z.string()),
});
const SelectOutput = z.object({
  sources: z.array(
    z.object({ url: z.string(), title: z.string(), questionIds: z.array(z.string()) }),
  ),
  candidates: z.int(),
});
const FetchOutput = z.object({
  url: z.string(),
  ok: z.boolean(),
  sourceId: z.string().nullable(),
  duplicate: z.boolean(),
  title: z.string().nullable(),
  error: z.string().nullable(),
});
const ClaimSchema = z.object({
  claim: z.string(),
  quote: z.string(),
  questions: z.array(z.string()),
  confidence: z.enum(['high', 'medium', 'low']),
});
const EvidenceOutput = z.object({
  sourceId: z.string().nullable(),
  used: z.boolean(),
  reason: z.string().nullable(),
  summary: z.string(),
  claims: z.array(ClaimSchema),
  droppedClaims: z.int(),
});
const AnalyzeOutput = z.object({
  evidence: z.array(ClaimSchema.extend({ id: z.string(), sourceId: z.string() })),
  analysis: AnalysisSchema,
  droppedFindings: z.int(),
});
const ReportOutput = z.object({ draft: ReportDraftSchema });
const ReviewOutput = z.object({
  paragraphs: z.array(
    z.object({
      id: z.string(),
      section: z.string().nullable(),
      text: z.string(),
      evidence: z.array(z.string()),
      certainty: z.enum(['high', 'medium', 'low']),
    }),
  ),
  verdicts: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(['supported', 'partially-supported', 'unsupported', 'unverified']),
      note: z.string(),
    }),
  ),
});

type StepInput = { key: string } & Record<string, JsonValue>;

const keyOf = (step: TaskStepRecord): string => {
  const input = step.input;
  return input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    typeof input['key'] === 'string'
    ? input['key']
    : '';
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const short = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Tool error codes worth another attempt. */
const RETRYABLE_TOOL = new Set(['timeout', 'network-error', 'dns-failed', 'http-error']);
const RETRYABLE_MODEL = new Set(['invalid-response', 'timeout', 'http-error', 'unavailable']);

/**
 * The autonomous research workflow (local Ollama only):
 *
 *   plan → search (per question) → select sources → fetch + extract evidence
 *   (per source) → compare findings → write report → review → save
 *
 * Every step is persisted before the next one starts; later steps are
 * appended from earlier outputs (idempotently), so a crash, pause or restart
 * continues at the first unfinished step and never repeats completed ones.
 */
export function createResearchAgent(deps: ResearchAgentDeps) {
  const { storage, modelProvider, tools } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  // --- helpers ---------------------------------------------------------------------------

  function taskInput(task: TaskRecord): ResearchTaskInput {
    return ResearchTaskInputSchema.parse(task.input);
  }

  function outputOf<S extends z.ZodType>(steps: readonly TaskStepRecord[], key: string, schema: S) {
    const step = steps.find((s) => keyOf(s) === key && s.status === 'completed');
    return step ? (schema.parse(step.output) as z.output<S>) : undefined;
  }

  function progress(task: TaskRecord, steps: readonly TaskStepRecord[]): ResearchProgress {
    const done = steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
    const current =
      steps.find((s) => s.status === 'running') ??
      steps.find((s) => s.status !== 'completed' && s.status !== 'skipped') ??
      null;
    const selected = steps.some((s) => keyOf(s) === 'select' && s.status === 'completed');
    let total = steps.length;
    if (!selected && isResearchTask(task)) {
      const limits = taskInput(task).limits;
      const plan = outputOf(steps, 'plan', PlanOutput);
      const questions = plan?.questions.length ?? limits.maxQuestions;
      total = Math.max(steps.length, 1 + questions + 1 + 2 * sourceBudget(limits, questions) + 4);
    }
    return {
      completed: done,
      total: Math.max(total, done),
      estimated: !selected,
      current: current ? { seq: current.seq, name: current.name, kind: current.kind } : null,
    };
  }

  function emit(
    taskId: string,
    type: ResearchEvent['type'],
    extra: { message?: string } = {},
  ): void {
    if (!deps.onEvent) return;
    try {
      const task = storage.tasks.require(taskId);
      deps.onEvent({
        type,
        taskId,
        taskStatus: task.status,
        progress: progress(task, storage.steps.listByTask(taskId)),
        ...extra,
      });
    } catch (error) {
      console.error('Research event listener failed:', error);
    }
  }

  /** Sources affordable within maxSteps: plan + searches + select + 2/source + 4 final steps. */
  function sourceBudget(limits: ResearchLimits, questions: number): number {
    const fixed = 1 + questions + 1 + 4;
    return Math.max(0, Math.min(limits.maxSources, Math.floor((limits.maxSteps - fixed) / 2)));
  }

  /** Appends the steps implied by completed outputs. Idempotent (keys are unique). */
  function expand(taskId: string): void {
    const steps = storage.steps.listByTask(taskId);
    const keys = new Set(steps.map(keyOf));
    const ensure = (kind: StepKind, name: string, input: StepInput) => {
      if (keys.has(input.key)) return;
      storage.steps.append(taskId, { kind, name, input });
      keys.add(input.key);
    };
    ensure('plan', 'Create research plan', { key: 'plan' });
    const plan = outputOf(steps, 'plan', PlanOutput);
    if (!plan) return;
    for (const q of plan.questions) {
      ensure('search', `Search: ${short(q.question)}`, { key: `search:${q.id}`, questionId: q.id });
    }
    ensure('select', 'Choose sources', { key: 'select' });
    const selected = outputOf(steps, 'select', SelectOutput);
    if (!selected) return;
    selected.sources.forEach((s, i) => {
      const n = i + 1;
      ensure('fetch', `Read source ${n}: ${short(s.title || s.url, 60)}`, {
        key: `fetch:${n}`,
        index: n,
      });
      ensure('evidence', `Extract evidence from source ${n}`, { key: `evidence:${n}`, index: n });
    });
    ensure('analyze', 'Compare findings', { key: 'analyze' });
    ensure('report', 'Write report', { key: 'report' });
    ensure('review', 'Review report for unsupported claims', { key: 'review' });
    ensure('save', 'Save report', { key: 'save' });
  }

  /** One model call with timeout, validation and retries (feeding the error back). */
  async function callModel<S extends z.ZodType>(
    task: TaskRecord,
    step: TaskStepRecord,
    prompt: ChatMessage[],
    schema: S,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<z.output<S>> {
    const limits = taskInput(task).limits;
    let messages = prompt;
    for (let attempt = 0; ; attempt++) {
      const deadline = AbortSignal.timeout(limits.modelTimeoutMs);
      try {
        const { object, result } = await generateObject(
          modelProvider,
          { messages, options: { temperature: 0, maxTokens }, think: false },
          schema,
          { signal: AbortSignal.any([signal, deadline]) },
        );
        storage.modelUsage.record({
          taskId: task.id,
          stepId: step.id,
          provider: modelProvider.id,
          model: result.model,
          purpose: `research:${step.kind}`,
          ...result.usage,
        });
        return object;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        const code = deadline.aborted
          ? 'timeout'
          : isModelProviderError(error)
            ? error.code
            : 'failed';
        const text = deadline.aborted
          ? `no answer within ${Math.round(limits.modelTimeoutMs / 1000)} s`
          : message(error);
        if (!RETRYABLE_MODEL.has(code) || attempt >= limits.modelRetries) {
          throw new ResearchStepError(`Local model failed (${code}): ${text}`);
        }
        if (code === 'invalid-response') {
          messages = [
            ...prompt,
            {
              role: 'user',
              content: `Your previous answer was rejected: ${text.slice(0, 500)}\nAnswer again with JSON that matches the schema exactly.`,
            },
          ];
        }
        await sleep(limits.retryBackoffMs * (attempt + 1), signal);
      }
    }
  }

  /** One tool call with retries for transient failures. Returns the error text on failure. */
  async function callTool(
    task: TaskRecord,
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string; code: string }> {
    const limits = taskInput(task).limits;
    for (let attempt = 0; ; attempt++) {
      const result = await tools.execute(name, input, { signal, taskId: task.id });
      if (result.ok) return { ok: true, value: result.value };
      if (signal.aborted) throw signal.reason;
      const e = result.error;
      const code = e.kind === 'failed' ? (e.code ?? 'failed') : e.kind;
      const text = 'message' in e ? e.message : 'issues' in e ? e.issues.join('; ') : e.kind;
      const retryable =
        e.kind === 'timeout' ||
        (RETRYABLE_TOOL.has(code) && !(code === 'http-error' && /HTTP 4\d\d/.test(text)));
      if (!retryable || attempt >= limits.toolRetries) return { ok: false, error: text, code };
      await sleep(limits.retryBackoffMs * (attempt + 1), signal);
    }
  }

  // --- steps -------------------------------------------------------------------------------

  async function executeStep(
    task: TaskRecord,
    step: TaskStepRecord,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const input = taskInput(task);
    const { limits } = input;
    const steps = storage.steps.listByTask(task.id);
    const plan = outputOf(steps, 'plan', PlanOutput);
    const questions = plan?.questions ?? [];
    const stepInput = step.input as Record<string, JsonValue>;

    switch (step.kind as StepKind) {
      case 'plan': {
        const raw = await callModel(
          task,
          step,
          planPrompt(input.goal, limits.maxQuestions, limits.maxQueriesPerQuestion),
          ResearchPlanSchema,
          900,
          signal,
        );
        // Enforce limits (the model may ask for more than allowed).
        const seen = new Set<string>();
        const planned = raw.questions
          .filter((q) => {
            const k = q.question.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, limits.maxQuestions)
          .map((q, i) => ({
            id: `q${i + 1}`,
            question: q.question,
            searchQueries: [...new Set(q.searchQueries.map((s) => s.trim()).filter(Boolean))].slice(
              0,
              limits.maxQueriesPerQuestion,
            ),
          }))
          .filter((q) => q.searchQueries.length > 0);
        if (!planned.length) throw new ResearchStepError('The plan contains no usable questions.');
        storage.tasks.rename(task.id, `Research: ${short(raw.title, 140)}`);
        return { title: raw.title, objective: raw.objective, questions: planned };
      }

      case 'search': {
        const questionId = String(stepInput['questionId']);
        const question = questions.find((q) => q.id === questionId);
        if (!question) throw new ResearchStepError(`Unknown question ${questionId}.`);
        const results: { url: string; title: string; snippet: string }[] = [];
        const errors: string[] = [];
        for (const query of question.searchQueries) {
          const res = await callTool(
            task,
            'web_search',
            { query, limit: limits.resultsPerQuery },
            signal,
          );
          if (!res.ok) {
            errors.push(`${query}: ${res.error}`);
            continue;
          }
          const out = WebSearchOutputSchema.parse(res.value);
          for (const r of out.results) {
            if (!results.some((x) => x.url === r.url)) {
              results.push({ url: r.url, title: r.title, snippet: r.snippet });
            }
          }
        }
        emit(task.id, 'source', {
          message: `${results.length} search result(s) for ${questionId}`,
        });
        return { questionId, results, errors };
      }

      case 'select': {
        const perQuestion = questions.map(
          (q) => outputOf(steps, `search:${q.id}`, SearchOutput)?.results ?? [],
        );
        const budget = sourceBudget(limits, questions.length);
        const chosen: { url: string; title: string; questionIds: string[] }[] = [];
        const seen = new Map<string, number>();
        const candidates = perQuestion.reduce((n, r) => n + r.length, 0);
        // Round-robin across questions so every question gets sources.
        for (let rank = 0; chosen.length < budget; rank++) {
          let any = false;
          perQuestion.forEach((results, qi) => {
            const r = results[rank];
            if (!r || chosen.length >= budget) return;
            any = true;
            const checked = parsePublicUrl(r.url);
            if (!checked.ok) return;
            const key = canonicalizeUrl(checked.value);
            const qid = questions[qi]?.id ?? '';
            const existing = seen.get(key);
            if (existing !== undefined) {
              chosen[existing]?.questionIds.push(qid);
              return;
            }
            seen.set(key, chosen.length);
            chosen.push({ url: checked.value.href, title: r.title, questionIds: [qid] });
          });
          if (!any) break;
        }
        if (!chosen.length) {
          const errors = questions.flatMap(
            (q) => outputOf(steps, `search:${q.id}`, SearchOutput)?.errors ?? [],
          );
          throw new ResearchStepError(
            `Web search returned no usable results.${errors[0] ? ` First error: ${errors[0]}` : ''}`,
          );
        }
        return { sources: chosen, candidates };
      }

      case 'fetch': {
        const index = Number(stepInput['index']);
        const selected = outputOf(steps, 'select', SelectOutput);
        const target = selected?.sources[index - 1];
        if (!target) throw new ResearchStepError(`Unknown source ${index}.`);
        const res = await callTool(task, 'fetch_source', { url: target.url }, signal);
        if (!res.ok) {
          // One unreadable source does not stop the research.
          return {
            url: target.url,
            ok: false,
            sourceId: null,
            duplicate: false,
            title: target.title,
            error: res.error,
          };
        }
        const out = FetchSourceOutputSchema.parse(res.value);
        emit(task.id, 'source', { message: out.title ?? out.url });
        return {
          url: out.url,
          ok: true,
          sourceId: out.sourceId,
          duplicate: out.status === 'duplicate',
          title: out.title,
          error: null,
        };
      }

      case 'evidence': {
        const index = Number(stepInput['index']);
        const fetched = outputOf(steps, `fetch:${index}`, FetchOutput);
        const skip = (reason: string) => ({
          sourceId: fetched?.sourceId ?? null,
          used: false,
          reason,
          summary: '',
          claims: [],
          droppedClaims: 0,
        });
        if (!fetched?.ok || !fetched.sourceId)
          return skip(`Source could not be read: ${fetched?.error ?? 'unknown error'}`);
        // The same document reached through another URL is only read once.
        for (let i = 1; i < index; i++) {
          const earlier = outputOf(steps, `evidence:${i}`, EvidenceOutput);
          if (earlier?.used && earlier.sourceId === fetched.sourceId) {
            return skip(`Same document as source ${i}.`);
          }
        }
        const source = storage.sources.get(fetched.sourceId);
        const content = storage.sources.getContent(fetched.sourceId);
        if (!source || !content?.text.trim()) return skip('No stored text for this source.');
        const text = content.text.slice(0, limits.maxSourceChars);
        const evidence = await callModel(
          task,
          step,
          evidencePrompt(
            questions,
            { url: source.url, title: source.title, text },
            limits.maxClaimsPerSource,
          ),
          SourceEvidenceSchema,
          1200,
          signal,
        );
        const { kept, dropped } = groundClaims(
          evidence,
          text,
          questions.map((q) => q.id),
          limits.maxClaimsPerSource,
        );
        return {
          sourceId: source.id,
          used: evidence.relevant && kept.length > 0,
          reason: !evidence.relevant
            ? 'Not relevant to the questions.'
            : kept.length
              ? null
              : 'No claim could be matched to an exact quote in the source.',
          summary: evidence.summary.slice(0, 1000),
          claims: kept.map((c) => ({ ...c, questions: [...c.questions] })),
          droppedClaims: dropped,
        };
      }

      case 'analyze': {
        const perSource: { sourceId: string; claims: GroundedClaim[] }[] = [];
        for (const s of steps.filter((x) => x.kind === 'evidence')) {
          const out = outputOf(steps, keyOf(s), EvidenceOutput);
          if (out?.used && out.sourceId)
            perSource.push({ sourceId: out.sourceId, claims: out.claims });
        }
        const evidence = indexEvidence(perSource, MAX_EVIDENCE_ITEMS);
        if (!evidence.length) {
          const fetches = steps
            .filter((x) => x.kind === 'fetch')
            .map((x) => outputOf(steps, keyOf(x), FetchOutput));
          const readable = fetches.filter((f) => f?.ok).length;
          throw new ResearchStepError(
            readable
              ? `None of the ${readable} readable source(s) contained evidence that could be verified against the source text.`
              : `None of the ${fetches.length} selected source(s) could be read.`,
          );
        }
        const raw = await callModel(
          task,
          step,
          analysisPrompt(input.goal, questions, evidence),
          AnalysisSchema,
          1500,
          signal,
        );
        const cleaned = cleanAnalysis(
          raw,
          new Set(evidence.map((e) => e.id)),
          new Set(questions.map((q) => q.id)),
        );
        return {
          evidence: evidence.map((e) => ({ ...e, questions: [...e.questions] })),
          analysis: cleaned.analysis,
          droppedFindings: cleaned.droppedFindings,
        };
      }

      case 'report': {
        const analyzed = outputOf(steps, 'analyze', AnalyzeOutput);
        if (!analyzed) throw new ResearchStepError('Missing analysis.');
        const draft = await callModel(
          task,
          step,
          reportPrompt(input.goal, questions, analyzed.analysis, analyzed.evidence),
          ReportDraftSchema,
          2000,
          signal,
        );
        return { draft } satisfies { draft: ReportDraft };
      }

      case 'review': {
        const analyzed = outputOf(steps, 'analyze', AnalyzeOutput);
        const reported = outputOf(steps, 'report', ReportOutput);
        if (!analyzed || !reported) throw new ResearchStepError('Missing report draft.');
        const evidenceById = new Map(analyzed.evidence.map((e) => [e.id, e]));
        const paragraphs = draftParagraphs(reported.draft, new Set(evidenceById.keys()));
        const verdicts: { id: string; verdict: Verdict; note: string }[] = [];
        // Deterministic first: no valid evidence → unsupported (no model needed).
        for (const p of paragraphs) {
          if (!p.evidence.length) {
            verdicts.push({ id: p.id, verdict: 'unsupported', note: 'Cites no valid evidence.' });
          }
        }
        const toCheck = paragraphs.filter((p) => p.evidence.length);
        for (let i = 0; i < toCheck.length; i += REVIEW_BATCH) {
          const batch = toCheck.slice(i, i + REVIEW_BATCH);
          const review = await callModel(
            task,
            step,
            reviewPrompt(
              batch.map((p) => ({
                id: p.id,
                text: p.text,
                quotes: p.evidence.flatMap((id) => {
                  const e = evidenceById.get(id);
                  return e ? [e.quote.slice(0, 300)] : [];
                }),
              })),
            ),
            ReviewSchema,
            800,
            signal,
          );
          for (const p of batch) {
            const v = review.verdicts.find((x) => x.id.trim().toUpperCase() === p.id);
            verdicts.push(
              v
                ? { id: p.id, verdict: v.verdict, note: v.note.slice(0, 300) }
                : { id: p.id, verdict: 'unverified', note: 'The review returned no verdict.' },
            );
          }
        }
        return {
          paragraphs: paragraphs.map((p) => ({ ...p, evidence: [...p.evidence] })),
          verdicts,
        };
      }

      case 'save': {
        const analyzed = outputOf(steps, 'analyze', AnalyzeOutput);
        const reported = outputOf(steps, 'report', ReportOutput);
        const reviewed = outputOf(steps, 'review', ReviewOutput);
        if (!analyzed || !reported || !reviewed || !plan) {
          throw new ResearchStepError('Missing earlier results.');
        }
        const sourceIds = [...new Set(analyzed.evidence.map((e) => e.sourceId))];
        const sources: SourceRef[] = sourceIds.flatMap((id) => {
          const s = storage.sources.get(id);
          return s && s.taskId === task.id
            ? [{ sourceId: s.id, url: s.url, title: s.title, retrievedAt: s.retrievedAt }]
            : [];
        });
        const lastModel =
          storage.modelUsage.listByTask(task.id).at(-1)?.model ?? modelProvider.defaultModel;
        const rendered = renderReport({
          goal: input.goal,
          title: reported.draft.title,
          paragraphs: reviewed.paragraphs as DraftParagraph[],
          verdicts: new Map(
            reviewed.verdicts.map((v) => [v.id, { verdict: v.verdict, note: v.note }]),
          ),
          analysis: analyzed.analysis as Analysis,
          evidence: analyzed.evidence as EvidenceItem[],
          sources,
          questions,
          generatedAt: now().toISOString(),
          model: lastModel,
        });
        // A crash after saving must not create a second identical version on resume.
        const latest = storage.reports.latest(task.id);
        const report =
          latest && latest.content === rendered.markdown
            ? latest
            : storage.reports.create(task.id, {
                title: rendered.title,
                content: rendered.markdown,
                citedSourceIds: rendered.citedSourceIds,
              });
        return {
          reportId: report.id,
          version: report.version,
          title: rendered.title,
          citedSourceIds: rendered.citedSourceIds,
          stats: { ...rendered.stats },
        };
      }
    }
  }

  // --- run loop -----------------------------------------------------------------------------

  function stop(taskId: string, stepId: string | null, reason: unknown): void {
    if (reason === 'pause') {
      if (stepId) storage.steps.interrupt(stepId, PAUSED_MESSAGE);
      storage.tasks.transition(taskId, 'interrupted', { error: PAUSED_MESSAGE });
    } else {
      if (stepId) storage.steps.fail(stepId, CANCELLED_MESSAGE);
      storage.tasks.cancel(taskId);
    }
    emit(taskId, 'task', { message: reason === 'pause' ? 'Paused' : 'Cancelled' });
  }

  async function run(taskId: string, controller: AbortController): Promise<void> {
    const { signal } = controller;
    for (;;) {
      expand(taskId);
      const task = storage.tasks.require(taskId);
      const steps = storage.steps.listByTask(taskId);
      const limits = taskInput(task).limits;
      if (steps.length > limits.maxSteps) {
        storage.tasks.fail(
          taskId,
          `The task needs ${steps.length} steps; the limit is ${limits.maxSteps}.`,
        );
        emit(taskId, 'task');
        return;
      }
      const next = steps.find((s) => s.status !== 'completed' && s.status !== 'skipped');
      if (!next) break;
      if (signal.aborted) return stop(taskId, null, signal.reason);

      storage.steps.start(next.id);
      emit(taskId, 'step-started', { message: next.name });
      let output: JsonValue;
      try {
        const started = storage.steps.get(next.id);
        if (!started) throw new ResearchStepError(`Step ${next.id} disappeared.`);
        output = await executeStep(task, started, signal);
      } catch (error) {
        if (signal.aborted) return stop(taskId, next.id, signal.reason);
        const text = message(error);
        storage.steps.fail(next.id, text);
        storage.tasks.fail(taskId, `Step ${next.seq} (${next.name}) failed: ${text}`);
        emit(taskId, 'step-failed', { message: text });
        return;
      }
      storage.steps.complete(next.id, output);
      emit(taskId, 'step-completed', { message: next.name });
    }

    const steps = storage.steps.listByTask(taskId);
    const saved = outputOf(
      steps,
      'save',
      z.object({ reportId: z.string(), stats: z.record(z.string(), z.number()) }).loose(),
    );
    const plan = outputOf(steps, 'plan', PlanOutput);
    storage.tasks.complete(taskId, {
      kind: RESEARCH_TASK_KIND,
      reportId: saved?.reportId ?? null,
      title: plan?.title ?? null,
      questions: plan?.questions.length ?? 0,
      sources: storage.sources.listByTask(taskId).length,
      ...(saved && { stats: saved.stats as Record<string, number> }),
    });
    emit(taskId, 'task', { message: 'Completed' });
  }

  function launch(taskId: string): void {
    const controller = new AbortController();
    const done = run(taskId, controller)
      .catch((error: unknown) => {
        // Last resort: never leave a task "running" after an unexpected error.
        console.error('Research task crashed:', error);
        try {
          const task = storage.tasks.require(taskId);
          if (task.status === 'running')
            storage.tasks.fail(taskId, `Unexpected error: ${message(error)}`);
          for (const s of storage.steps.listByTask(taskId)) {
            if (s.status === 'running') storage.steps.fail(s.id, message(error));
          }
          emit(taskId, 'task');
        } catch {
          // Database unavailable; startup recovery marks it interrupted.
        }
      })
      .finally(() => running.delete(taskId));
    running.set(taskId, { controller, done });
  }

  return {
    /** Whether the tools the workflow needs are registered (search needs SEARXNG_URL). */
    readiness(): { ok: true } | { ok: false; message: string } {
      if (!tools.get('web_search')) {
        return {
          ok: false,
          message: 'Web search is not configured. Set SEARXNG_URL in .env and restart the app.',
        };
      }
      if (!tools.get('fetch_source'))
        return { ok: false, message: 'The fetch_source tool is not available.' };
      return { ok: true };
    },

    /** Validates the request, creates the task with its first step and starts it. */
    start(request: ResearchRequest): TaskRecord {
      const parsed = ResearchRequestSchema.parse(request);
      const limits = ResearchLimitsSchema.parse({ ...deps.defaults, ...parsed.limits });
      const goal = parsed.goal.replace(/\s+/g, ' ');
      const task = storage.transaction((repos) => {
        const created = repos.tasks.create({
          title: `Research: ${short(goal, 140)}`,
          input: { kind: RESEARCH_TASK_KIND, goal, limits },
        });
        repos.steps.append(created.id, {
          kind: 'plan',
          name: 'Create research plan',
          input: { key: 'plan' },
        });
        return repos.tasks.start(created.id);
      });
      emit(task.id, 'task', { message: 'Started' });
      launch(task.id);
      return task;
    },

    /** Continues an interrupted or paused task at its first unfinished step. */
    resume(taskId: string): TaskRecord {
      const task = storage.tasks.require(taskId);
      if (!isResearchTask(task)) throw new Error('Not a research task.');
      const plan = storage.recovery.resume(taskId);
      emit(taskId, 'task', { message: 'Resumed' });
      launch(taskId);
      return plan.task;
    },

    /** Stops a running task after aborting its current step; it can be resumed. */
    pause(taskId: string): boolean {
      const entry = running.get(taskId);
      if (!entry) return false;
      entry.controller.abort('pause');
      return true;
    },

    cancel(taskId: string): boolean {
      const entry = running.get(taskId);
      if (!entry) return false;
      entry.controller.abort('cancel');
      return true;
    },

    isRunning: (taskId: string) => running.has(taskId),
    progress,

    async whenIdle(): Promise<void> {
      while (running.size) await Promise.all([...running.values()].map((r) => r.done));
    },
  };
}

export type ResearchAgent = ReturnType<typeof createResearchAgent>;
