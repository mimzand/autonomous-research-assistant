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
  classifyModelError,
  classifySearchError,
  formatStepError,
  interruptionOf,
  isNetworkLevel,
  NON_FATAL_STEP_KINDS,
  PAUSED_MESSAGE,
  parseStepError,
  sourceErrorCode,
  StepFailure,
  TRANSIENT_SOURCE_CODES,
  waitingMessage,
  type FailureKind,
} from './failures.js';
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
  TaskModelConfigSchema,
  ReviewSchema,
  SourceEvidenceSchema,
  type Analysis,
  type ReportDraft,
  type ResearchLimits,
  type ResearchRequest,
  type ResearchTaskInput,
  type TaskModelConfig,
} from './schemas.js';

export { PAUSED_MESSAGE } from './failures.js';
const CANCELLED_MESSAGE = 'Cancelled by the user.';
/** Evidence items given to the model in the compare/report steps (context window). */
const MAX_EVIDENCE_ITEMS = 40;
const REVIEW_BATCH = 8;
/** Network failures on this many different sites in a row mean "offline". */
const OFFLINE_HOST_THRESHOLD = 2;
const MAX_BACKOFF_MS = 30_000;

/** Exponential backoff: base, 2×base, 4×base … capped at 30 s. */
export const backoffDelay = (baseMs: number, attempt: number) =>
  Math.min(baseMs * 2 ** attempt, MAX_BACKOFF_MS);

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
  /** The live provider: follows the current settings. */
  readonly modelProvider: ModelProvider;
  /**
   * Task isolation. When present, a task captures the model configuration
   * when it starts (stored in the task input) and uses a provider built from
   * that capture for its whole life, including Resume and Retry after a
   * settings change or a restart. New tasks use the latest settings.
   */
  readonly taskModels?: {
    capture(): TaskModelConfig;
    providerFor(captured: TaskModelConfig): ModelProvider;
  };
  /** Whether web search is configured now. Defaults to "the web_search tool exists". */
  readonly searchConfigured?: () => boolean;
  readonly tools: ToolRegistry;
  readonly onEvent?: (event: ResearchEvent) => void;
  /** Defaults for limits not given in a request (read when a task starts). */
  readonly defaults?: Partial<ResearchLimits> | (() => Partial<ResearchLimits>);
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A fatal step error (the task fails; the user can retry). */
export class ResearchStepError extends Error {
  override readonly name = 'ResearchStepError';
}

/** Refused before anything was created or changed (e.g. Ollama not running). */
export class ResearchStartError extends Error {
  override readonly name = 'ResearchStartError';
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
  interruptionOf(task)?.kind === 'paused';

/** A step that no longer blocks the run: done, skipped, or a failed per-source step. */
export const isSettled = (s: Pick<TaskStepRecord, 'status' | 'kind'>) =>
  s.status === 'completed' ||
  s.status === 'skipped' ||
  (s.status === 'failed' && NON_FATAL_STEP_KINDS.has(s.kind));

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
const RETRYABLE_TOOL = new Set([
  'timeout',
  'network-error',
  'dns-failed',
  'http-error',
  'engines-unreachable',
]);
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
  const { storage, modelProvider: liveProvider, tools } = deps;
  const now = deps.now ?? (() => new Date());
  const defaults = () => (typeof deps.defaults === 'function' ? deps.defaults() : deps.defaults);
  /** Providers built from a task's captured model configuration, per running task. */
  const taskProviders = new Map<string, ModelProvider>();

  function providerFor(task: TaskRecord): ModelProvider {
    const captured = (task.input as { model?: unknown }).model;
    if (!deps.taskModels || captured === undefined) return liveProvider;
    const cached = taskProviders.get(task.id);
    if (cached) return cached;
    const provider = deps.taskModels.providerFor(TaskModelConfigSchema.parse(captured));
    taskProviders.set(task.id, provider);
    return provider;
  }
  const sleep = deps.sleep ?? defaultSleep;
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** Hosts that failed at network level since the last successful fetch, per task. */
  const networkFailures = new Map<string, Set<string>>();

  // --- helpers ---------------------------------------------------------------------------

  function taskInput(task: TaskRecord): ResearchTaskInput {
    return ResearchTaskInputSchema.parse(task.input);
  }

  function outputOf<S extends z.ZodType>(steps: readonly TaskStepRecord[], key: string, schema: S) {
    const step = steps.find((s) => keyOf(s) === key && s.status === 'completed');
    return step ? (schema.parse(step.output) as z.output<S>) : undefined;
  }

  function progress(task: TaskRecord, steps: readonly TaskStepRecord[]): ResearchProgress {
    const done = steps.filter(isSettled).length;
    const current =
      steps.find((s) => s.status === 'running') ?? steps.find((s) => !isSettled(s)) ?? null;
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

  /** Appends to the task's execution log. Logging never breaks the workflow. */
  function log(
    taskId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    text: string,
    options: { stepId?: string | null; data?: Record<string, JsonValue> } = {},
  ): void {
    try {
      let data: JsonValue | undefined = options.data;
      if (data !== undefined && JSON.stringify(data).length > 3800) {
        data = { truncated: true, preview: JSON.stringify(data).slice(0, 3500) };
      }
      storage.logs.append(taskId, {
        level,
        event,
        message: text.slice(0, 2000) || event,
        ...(options.stepId && { stepId: options.stepId }),
        ...(data !== undefined && { data }),
      });
    } catch (error) {
      console.error('Could not write the execution log:', error);
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
    const modelProvider = providerFor(task);
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
        log(task.id, 'debug', 'model.call', `Model answered (${step.kind}).`, {
          stepId: step.id,
          data: {
            model: result.model,
            attempt: attempt + 1,
            promptTokens: result.usage.promptTokens ?? null,
            completionTokens: result.usage.completionTokens ?? null,
            durationMs: result.usage.totalDurationMs ?? null,
          },
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
          log(task.id, 'error', 'model.failed', `Local model failed (${code}): ${text}`, {
            stepId: step.id,
            data: { code, attempts: attempt + 1 },
          });
          throw classifyModelError(code, `Local model failed (${code}): ${text}`);
        }
        const delayMs = backoffDelay(limits.retryBackoffMs, attempt);
        log(task.id, 'warn', 'model.retry', `Model call failed (${code}): ${text}. Retrying.`, {
          stepId: step.id,
          data: { code, attempt: attempt + 1, of: limits.modelRetries + 1, delayMs },
        });
        if (code === 'invalid-response') {
          messages = [
            ...prompt,
            {
              role: 'user',
              content: `Your previous answer was rejected: ${text.slice(0, 500)}\nAnswer again with JSON that matches the schema exactly.`,
            },
          ];
        }
        await sleep(delayMs, signal);
      }
    }
  }

  /** One tool call with retries for transient failures. Returns the error text on failure. */
  async function callTool(
    task: TaskRecord,
    name: string,
    input: unknown,
    signal: AbortSignal,
    stepId: string,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string; code: string }> {
    const limits = taskInput(task).limits;
    // The workflow never approves its own actions: tools that change anything
    // outside the app (or need approval) are refused here.
    const definition = tools.get(name);
    if (!definition)
      throw new StepFailure('fatal', 'unknown-tool', `Tool ${name} is not available.`);
    if (definition.permissions.requiresApproval || definition.permissions.effects === 'external') {
      log(
        task.id,
        'error',
        'tool.refused',
        `${name} needs user approval; the workflow does not run it.`,
        { stepId },
      );
      throw new StepFailure(
        'fatal',
        'approval-required',
        `${name} requires user approval and was not run.`,
      );
    }
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
      if (!retryable || attempt >= limits.toolRetries) {
        log(task.id, 'warn', 'tool.failed', `${name} failed (${code}): ${text}`, {
          stepId,
          data: { tool: name, code, attempts: attempt + 1 },
        });
        return { ok: false, error: text, code };
      }
      const delayMs = backoffDelay(limits.retryBackoffMs, attempt);
      log(task.id, 'warn', 'tool.retry', `${name} failed (${code}): ${text}. Retrying.`, {
        stepId,
        data: { tool: name, code, attempt: attempt + 1, of: limits.toolRetries + 1, delayMs },
      });
      await sleep(delayMs, signal);
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
            step.id,
          );
          if (!res.ok) {
            // SearXNG down or no internet: wait for the user instead of failing.
            const environment = classifySearchError(res.code, res.error);
            if (environment) throw environment;
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
        const res = await callTool(task, 'fetch_source', { url: target.url }, signal, step.id);
        if (!res.ok) {
          const code = sourceErrorCode(res.code, res.error);
          if (isNetworkLevel(res.code)) {
            const hosts = networkFailures.get(task.id) ?? new Set<string>();
            hosts.add(new URL(target.url).hostname);
            networkFailures.set(task.id, hosts);
            if (hosts.size >= OFFLINE_HOST_THRESHOLD) {
              throw new StepFailure(
                'offline',
                code,
                `${hosts.size} different sites could not be reached (${res.error}).`,
              );
            }
          }
          // One unreadable source does not stop the research, but the step is
          // marked failed (visible in the timeline, the log and the report).
          throw new StepFailure('source', code, res.error);
        }
        networkFailures.delete(task.id);
        const out = FetchSourceOutputSchema.parse(res.value);
        log(
          task.id,
          'info',
          'source.read',
          `${out.status === 'duplicate' ? 'Already saved' : 'Saved'}: ${out.url}`,
          {
            stepId: step.id,
            data: { url: out.url, sourceId: out.sourceId, status: out.status },
          },
        );
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
        let evidence;
        try {
          evidence = await callModel(
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
        } catch (error) {
          // A bad answer about one source loses that source, not the task.
          if (error instanceof StepFailure && error.kind === 'fatal') {
            throw new StepFailure('source', error.code, error.message);
          }
          throw error;
        }
        const { kept, dropped } = groundClaims(
          evidence,
          text,
          questions.map((q) => q.id),
          limits.maxClaimsPerSource,
        );
        if (dropped) {
          log(
            task.id,
            'info',
            'grounding.dropped',
            `${dropped} claim(s) dropped: quote not found in the source.`,
            {
              stepId: step.id,
              data: { kept: kept.length, dropped },
            },
          );
        }
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
          const total = steps.filter((x) => x.kind === 'fetch').length;
          throw new ResearchStepError(
            readable
              ? `None of the ${readable} readable source(s) contained evidence that could be verified against the source text.`
              : `None of the ${total} selected source(s) could be read. Retry to read them again.`,
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
          storage.modelUsage.listByTask(task.id).at(-1)?.model ?? providerFor(task).defaultModel;
        const selected = outputOf(steps, 'select', SelectOutput);
        const unusable = steps.flatMap((s) => {
          if (s.status !== 'failed' && !(s.kind === 'evidence' && s.status === 'skipped'))
            return [];
          if (s.kind !== 'fetch' && s.kind !== 'evidence') return [];
          const index = Number((s.input as Record<string, JsonValue>)['index']);
          // A skipped evidence step repeats its fetch failure; report each source once.
          if (
            s.kind === 'evidence' &&
            steps.some((f) => keyOf(f) === `fetch:${index}` && f.status === 'failed')
          ) {
            return [];
          }
          return [
            {
              url: selected?.sources[index - 1]?.url ?? s.name,
              reason: parseStepError(s.error).message,
            },
          ];
        });
        const rendered = renderReport({
          unusable,
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
      log(taskId, 'info', 'task.paused', 'Paused by the user.', { stepId });
    } else {
      if (stepId) storage.steps.fail(stepId, CANCELLED_MESSAGE);
      storage.tasks.cancel(taskId);
      log(taskId, 'info', 'task.cancelled', 'Cancelled by the user.', { stepId });
    }
    emit(taskId, 'task', { message: reason === 'pause' ? 'Paused' : 'Cancelled' });
  }

  /** Ollama, SearXNG or the internet is unavailable: wait for the user to resume. */
  function waitForEnvironment(
    taskId: string,
    step: TaskStepRecord,
    failure: StepFailure & { kind: Exclude<FailureKind, 'source' | 'fatal'> },
  ): void {
    storage.steps.interrupt(step.id, formatStepError(failure.code, failure.message));
    const reason = waitingMessage(failure.kind, failure.message);
    storage.tasks.transition(taskId, 'interrupted', { error: reason });
    log(taskId, 'warn', 'task.waiting', reason, {
      stepId: step.id,
      data: { kind: failure.kind, code: failure.code },
    });
    emit(taskId, 'task', { message: reason });
  }

  /** A per-source step failed: mark it (and the evidence step that needs it) and go on. */
  function recordSourceFailure(taskId: string, step: TaskStepRecord, failure: StepFailure): void {
    storage.steps.fail(step.id, formatStepError(failure.code, failure.message));
    log(
      taskId,
      'warn',
      'step.failed',
      `Step ${step.seq} (${step.name}) failed; continuing without this source: ${failure.message}`,
      {
        stepId: step.id,
        data: { code: failure.code, fatal: false },
      },
    );
    if (step.kind === 'fetch') {
      const index = Number((step.input as Record<string, JsonValue>)['index']);
      const dependent = storage.steps
        .listByTask(taskId)
        .find(
          (s) =>
            keyOf(s) === `evidence:${index}` &&
            (s.status === 'pending' || s.status === 'interrupted'),
        );
      if (dependent) {
        const reason = `Skipped: source ${index} could not be read (${failure.message}).`;
        storage.steps.skip(dependent.id, reason);
        log(taskId, 'warn', 'step.skipped', `Step ${dependent.seq} (${dependent.name}) ${reason}`, {
          stepId: dependent.id,
        });
      }
    }
    emit(taskId, 'step-failed', { message: failure.message });
  }

  async function run(taskId: string, controller: AbortController): Promise<void> {
    const { signal } = controller;
    for (;;) {
      expand(taskId);
      const task = storage.tasks.require(taskId);
      const steps = storage.steps.listByTask(taskId);
      const limits = taskInput(task).limits;
      if (steps.length > limits.maxSteps) {
        const text = `The task needs ${steps.length} steps; the limit is ${limits.maxSteps}.`;
        storage.tasks.fail(taskId, text);
        log(taskId, 'error', 'task.failed', text);
        emit(taskId, 'task');
        return;
      }
      const next = steps.find((s) => !isSettled(s));
      if (!next) break;
      if (signal.aborted) return stop(taskId, null, signal.reason);

      const started = storage.steps.start(next.id); // Throws for completed steps.
      log(
        taskId,
        'info',
        'step.started',
        `Step ${next.seq}: ${next.name} (attempt ${started.attempts}).`,
        {
          stepId: next.id,
          data: { seq: next.seq, kind: next.kind, attempt: started.attempts },
        },
      );
      emit(taskId, 'step-started', { message: next.name });
      const startedAt = Date.now();
      let output: JsonValue;
      try {
        output = await executeStep(task, started, signal);
      } catch (error) {
        if (signal.aborted) return stop(taskId, next.id, signal.reason);
        if (error instanceof StepFailure && error.kind !== 'fatal') {
          if (error.kind === 'source') {
            // Only per-source steps may fail without failing the task; anything
            // else falls through to the fatal path below (same code and message).
            if (NON_FATAL_STEP_KINDS.has(next.kind)) {
              recordSourceFailure(taskId, started, error);
              continue;
            }
          } else {
            waitForEnvironment(
              taskId,
              started,
              error as StepFailure & { kind: Exclude<FailureKind, 'source' | 'fatal'> },
            );
            return;
          }
        }
        const code = error instanceof StepFailure ? error.code : 'failed';
        const text = message(error);
        storage.steps.fail(next.id, formatStepError(code, text));
        const reason = `Step ${next.seq} (${next.name}) failed: ${text}`;
        storage.tasks.fail(taskId, reason);
        log(taskId, 'error', 'task.failed', `${reason} Use Retry to run the failed step again.`, {
          stepId: next.id,
          data: { code, fatal: true },
        });
        emit(taskId, 'step-failed', { message: text });
        return;
      }
      storage.steps.complete(next.id, output);
      log(taskId, 'info', 'step.completed', `Step ${next.seq} completed: ${next.name}.`, {
        stepId: next.id,
        data: { durationMs: Date.now() - startedAt },
      });
      emit(taskId, 'step-completed', { message: next.name });
    }

    const steps = storage.steps.listByTask(taskId);
    const saved = outputOf(
      steps,
      'save',
      z.object({ reportId: z.string(), stats: z.record(z.string(), z.number()) }).loose(),
    );
    const plan = outputOf(steps, 'plan', PlanOutput);
    const failedSteps = steps.filter((s) => s.status === 'failed').length;
    storage.tasks.complete(taskId, {
      kind: RESEARCH_TASK_KIND,
      reportId: saved?.reportId ?? null,
      title: plan?.title ?? null,
      questions: plan?.questions.length ?? 0,
      sources: storage.sources.listByTask(taskId).length,
      failedSteps,
      ...(saved && { stats: saved.stats as Record<string, number> }),
    });
    log(
      taskId,
      failedSteps ? 'warn' : 'info',
      'task.completed',
      failedSteps
        ? `Completed with ${failedSteps} failed source step(s); see the report's review notes.`
        : 'Completed.',
      { data: { failedSteps } },
    );
    emit(taskId, 'task', { message: 'Completed' });
  }

  function launch(taskId: string): void {
    const controller = new AbortController();
    networkFailures.delete(taskId);
    const done = run(taskId, controller)
      .catch((error: unknown) => {
        // Last resort: never leave a task "running" after an unexpected error.
        console.error('Research task crashed:', error);
        try {
          for (const s of storage.steps.listByTask(taskId)) {
            if (s.status === 'running')
              storage.steps.fail(s.id, formatStepError('crash', message(error)));
          }
          const task = storage.tasks.require(taskId);
          if (task.status === 'running')
            storage.tasks.fail(taskId, `Unexpected error: ${message(error)}`);
          log(taskId, 'error', 'task.crashed', `Unexpected error: ${message(error)}`);
          emit(taskId, 'task');
        } catch {
          // Database unavailable; startup recovery marks it interrupted.
        }
      })
      .finally(() => {
        running.delete(taskId);
        taskProviders.delete(taskId);
      });
    running.set(taskId, { controller, done });
  }

  /** Re-queues steps (and evidence steps skipped because of them) in one transaction. */
  function requeue(taskId: string, stepsToRequeue: readonly TaskStepRecord[]): string[] {
    const all = storage.steps.listByTask(taskId);
    const ids = new Set(stepsToRequeue.map((s) => s.id));
    for (const s of stepsToRequeue) {
      if (s.kind !== 'fetch') continue;
      const index = Number((s.input as Record<string, JsonValue>)['index']);
      const dependent = all.find((d) => keyOf(d) === `evidence:${index}` && d.status === 'skipped');
      if (dependent) ids.add(dependent.id);
    }
    return [...ids];
  }

  /** Failed per-source steps can only help while their evidence is still unused. */
  const sourcesStillUseful = (steps: readonly TaskStepRecord[]) =>
    !steps.some((s) => keyOf(s) === 'analyze' && s.status === 'completed');

  return {
    /** Whether the tools the workflow needs are registered (search needs SEARXNG_URL). */
    readiness(): { ok: true } | { ok: false; message: string } {
      if (!(deps.searchConfigured ? deps.searchConfigured() : tools.get('web_search'))) {
        return {
          ok: false,
          message: 'Web search is not configured. Set SEARXNG_URL in .env and restart the app.',
        };
      }
      if (!tools.get('fetch_source'))
        return { ok: false, message: 'The fetch_source tool is not available.' };
      return { ok: true };
    },

    /**
     * Validates the request, checks that Ollama and the model are available,
     * then creates the task with its first step and starts it. Throws
     * ResearchStartError (nothing created) when the model is not usable.
     */
    async start(request: ResearchRequest): Promise<TaskRecord> {
      const parsed = ResearchRequestSchema.parse(request);
      // Zod fills defaults inside .partial(), so only keep limits the caller actually set;
      // otherwise the schema defaults would silently override the configured ones.
      const requested = Object.fromEntries(
        Object.entries(parsed.limits ?? {}).filter(([key]) => key in (request.limits ?? {})),
      );
      const limits = ResearchLimitsSchema.parse({ ...defaults(), ...requested });
      // Task isolation: the configuration captured here is used for the whole task.
      const taskModels = deps.taskModels;
      const captured = taskModels?.capture();
      const modelProvider =
        taskModels && captured ? taskModels.providerFor(captured) : liveProvider;
      const health = await modelProvider.checkHealth({ signal: AbortSignal.timeout(15_000) });
      if (health.status === 'unreachable' && health.reason === 'disconnected') {
        throw new ResearchStartError(health.error);
      }
      if (health.status === 'unreachable') {
        throw new ResearchStartError(
          // The provider's message usually names the address already; do not repeat it.
          `Ollama is not reachable at ${health.baseUrl}: ${health.error.replace(/^Cannot reach Ollama at \S+?:?\s+/, '').replace(/\.?$/, '.')} Start Ollama and try again.`,
        );
      }
      if (health.status === 'model-missing') {
        throw new ResearchStartError(
          `The model ${health.model} is not installed. Run "ollama pull ${health.model}" and try again.`,
        );
      }
      const goal = parsed.goal.replace(/\s+/g, ' ');
      const task = storage.transaction((repos) => {
        const created = repos.tasks.create({
          title: `Research: ${short(goal, 140)}`,
          input: {
            kind: RESEARCH_TASK_KIND,
            goal,
            limits,
            ...(captured && { model: captured }),
          },
        });
        repos.steps.append(created.id, {
          kind: 'plan',
          name: 'Create research plan',
          input: { key: 'plan' },
        });
        return repos.tasks.start(created.id);
      });
      log(
        task.id,
        'info',
        'task.started',
        `Research started with the local model ${health.model} at ${health.baseUrl}.`,
        {
          data: {
            goal: short(goal, 300),
            limits: { ...limits },
            model: health.model,
            server: health.baseUrl,
          },
        },
      );
      emit(task.id, 'task', { message: 'Started' });
      launch(task.id);
      return task;
    },

    /**
     * Continues an interrupted task (paused, waiting, or stopped by an app
     * restart) at its first unfinished step. Source steps that failed for a
     * transient reason (network, timeout) are re-queued as well.
     */
    resume(taskId: string): TaskRecord {
      const task = storage.tasks.require(taskId);
      if (!isResearchTask(task)) throw new Error('Not a research task.');
      if (running.has(taskId)) throw new Error('The task is already running.');
      const why = interruptionOf(task);
      const plan = storage.recovery.resume(taskId); // interrupted → running, or throws
      const steps = storage.steps.listByTask(taskId);
      const transient = sourcesStillUseful(steps)
        ? steps.filter(
            (s) =>
              s.status === 'failed' &&
              NON_FATAL_STEP_KINDS.has(s.kind) &&
              TRANSIENT_SOURCE_CODES.has(parseStepError(s.error).code),
          )
        : [];
      const ids = requeue(taskId, transient);
      storage.transaction((repos) => ids.forEach((id) => repos.steps.requeue(id)));
      log(taskId, 'info', 'task.resumed', `Resumed${why ? ` (${why.kind})` : ''}.`, {
        data: { requeuedSteps: ids.length, nextStep: plan.nextStep?.seq ?? null },
      });
      emit(taskId, 'task', { message: 'Resumed' });
      launch(taskId);
      return storage.tasks.require(taskId);
    },

    /**
     * Retries a failed task: its failed step runs again, and so do failed
     * per-source steps whose evidence is still needed. Completed steps are
     * never repeated.
     */
    retry(taskId: string): TaskRecord {
      const task = storage.tasks.require(taskId);
      if (!isResearchTask(task)) throw new Error('Not a research task.');
      if (task.status !== 'failed') {
        throw new Error(`Only failed tasks can be retried (task is "${task.status}").`);
      }
      const steps = storage.steps.listByTask(taskId);
      const useful = sourcesStillUseful(steps);
      const failed = steps.filter(
        (s) => s.status === 'failed' && (!NON_FATAL_STEP_KINDS.has(s.kind) || useful),
      );
      const fatal = failed.filter((s) => !NON_FATAL_STEP_KINDS.has(s.kind));
      const failedSources = steps.filter(
        (s) => s.status === 'failed' && NON_FATAL_STEP_KINDS.has(s.kind),
      );
      if (!fatal.length && (!useful || !failedSources.length)) {
        throw new Error(
          'There is no failed step that can run again. Start a new research task instead.',
        );
      }
      const ids = requeue(taskId, failed);
      const updated = storage.transaction((repos) => {
        ids.forEach((id) => repos.steps.requeue(id));
        return repos.tasks.transition(taskId, 'running');
      });
      log(taskId, 'info', 'task.retry', `Retrying ${ids.length} step(s).`, {
        data: { steps: steps.filter((s) => ids.includes(s.id)).map((s) => s.seq) },
      });
      emit(taskId, 'task', { message: 'Retrying' });
      launch(taskId);
      return updated;
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

    /** Records a lifecycle action taken outside the run loop (e.g. cancelling a paused task). */
    note(taskId: string, event: string, text: string): void {
      log(taskId, 'info', event, text);
    },

    isRunning: (taskId: string) => running.has(taskId),
    progress,

    async whenIdle(): Promise<void> {
      while (running.size) await Promise.all([...running.values()].map((r) => r.done));
    },
  };
}

export type ResearchAgent = ReturnType<typeof createResearchAgent>;
