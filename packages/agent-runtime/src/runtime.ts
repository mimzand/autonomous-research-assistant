import { type GenerateChunk, type ModelProvider } from '@rka/model-provider';
import { type ChatTurn, type ModelHealth, type TaskRecoveryInfo } from '@rka/shared';
import { type Storage, type TaskRecord, type TaskStepRecord } from '@rka/storage';
import { type ToolRegistry, type ToolSummary } from '@rka/tools';
import { ZodError } from 'zod';
import { createPersistenceCheck, isPersistenceCheck } from './persistence-check.js';
import {
  createResearchAgent,
  interruptionOf,
  isPausedTask,
  isResearchTask,
  isSettled,
  type ResearchEvent,
  type ResearchLimits,
  type ResearchProgress,
  type ResearchAgentDeps,
  type ResearchRequest,
} from './research/index.js';

export interface AgentRuntimeDeps {
  readonly modelProvider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly storage: Storage;
  /** Progress of research tasks (for the UI). */
  readonly onResearchEvent?: (event: ResearchEvent) => void;
  /** Default research limits (requests may override within the schema bounds). Read per task. */
  readonly researchDefaults?: Partial<ResearchLimits> | (() => Partial<ResearchLimits>);
  /** Task isolation for research tasks (see ResearchAgentDeps.taskModels). */
  readonly taskModels?: ResearchAgentDeps['taskModels'];
  /** Whether web search is configured now (Settings can change it at run time). */
  readonly searchConfigured?: () => boolean;
}

export interface StreamChatOptions {
  readonly signal?: AbortSignal;
}

export type TaskActionOutcome =
  | { readonly ok: true; readonly task: TaskRecord }
  | { readonly ok: false; readonly message: string };

/**
 * Public surface of the agent runtime: chat, the persistence check and the
 * autonomous research workflow, with their task lifecycle actions.
 */
export interface AgentRuntime {
  /** Model used for chat and new tasks (follows the current settings). */
  readonly model: string;
  getModelHealth(signal?: AbortSignal): Promise<ModelHealth>;
  listTools(): readonly ToolSummary[];
  /**
   * Plain multi-turn chat with the configured local model (playground).
   * Throws `ModelProviderError` on failure; abort `signal` to cancel.
   */
  streamChat(turns: readonly ChatTurn[], options?: StreamChatOptions): AsyncIterable<GenerateChunk>;

  readonly tasks: {
    /** Creates and starts a persistence check task. */
    runPersistenceCheck(): TaskRecord;
    /**
     * Validates the goal, checks that Ollama and the model are available, then
     * creates and starts an autonomous research task.
     */
    startResearch(request: ResearchRequest): Promise<TaskActionOutcome>;
    /** Runs the failed step(s) of a failed research task again. */
    retry(taskId: string): TaskActionOutcome;
    /** Pauses a running research task; its current step is repeated on resume. */
    pause(taskId: string): TaskActionOutcome;
    /** Step progress of a research task, or null for other task types. */
    progress(task: TaskRecord, steps: readonly TaskStepRecord[]): ResearchProgress | null;
    /** Resumes an interrupted task if an executor exists for it. Never automatic. */
    resume(taskId: string): TaskActionOutcome;
    /** Cancels a pending/interrupted/awaiting task, or stops a running check. */
    cancel(taskId: string): TaskActionOutcome;
    /** What the UI may offer for this task (resume/cancel), and why. */
    recoveryInfo(task: TaskRecord, steps: readonly TaskStepRecord[]): TaskRecoveryInfo;
    /** Resolves when background task executions have finished (tests, shutdown). */
    whenIdle(): Promise<void>;
  };
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const { storage } = deps;
  const persistenceCheck = createPersistenceCheck({
    storage,
    modelProvider: deps.modelProvider,
  });
  const research = createResearchAgent({
    storage,
    modelProvider: deps.modelProvider,
    tools: deps.tools,
    ...(deps.onResearchEvent && { onEvent: deps.onResearchEvent }),
    ...(deps.researchDefaults && { defaults: deps.researchDefaults }),
    ...(deps.taskModels && { taskModels: deps.taskModels }),
    ...(deps.searchConfigured && { searchConfigured: deps.searchConfigured }),
  });
  const isExecuting = (id: string) => persistenceCheck.isRunning(id) || research.isRunning(id);

  function recoveryInfo(task: TaskRecord, steps: readonly TaskStepRecord[]): TaskRecoveryInfo {
    const done = steps.filter((s) => s.status === 'completed' || s.status === 'skipped');
    const next = steps.find((s) =>
      isResearchTask(task) ? !isSettled(s) : s.status !== 'completed' && s.status !== 'skipped',
    );
    const hasExecutor = isPersistenceCheck(task) || isResearchTask(task);
    const executing = isExecuting(task.id);
    const paused = isPausedTask(task);

    let reason: string | null = null;
    if (task.status === 'interrupted' && !hasExecutor) {
      reason =
        'No executor is available for this task type yet, so it cannot be resumed. It stays interrupted until resumed or cancelled.';
    }
    return {
      resumable: task.status === 'interrupted' && hasExecutor && !executing,
      reason,
      paused,
      interruption: interruptionOf(task),
      pausable: task.status === 'running' && isResearchTask(task) && research.isRunning(task.id),
      retryable:
        task.status === 'failed' &&
        isResearchTask(task) &&
        !executing &&
        steps.some((s) => s.status === 'failed'),
      failedSteps: steps.filter((s) => s.status === 'failed').length,
      cancellable:
        ['pending', 'interrupted', 'awaiting-approval'].includes(task.status) ||
        (task.status === 'running' && executing),
      completedSteps: done.length,
      totalSteps: steps.length,
      nextStep: next ? { seq: next.seq, name: next.name } : null,
    };
  }

  return {
    get model() {
      return deps.modelProvider.defaultModel;
    },
    getModelHealth: (signal) => deps.modelProvider.checkHealth({ signal }),
    listTools: () => deps.tools.list(),
    streamChat: (turns, options = {}) =>
      deps.modelProvider.generateStream(
        { messages: turns.map(({ role, content }) => ({ role, content })), think: false },
        { signal: options.signal },
      ),

    tasks: {
      runPersistenceCheck: () => persistenceCheck.start(),

      async startResearch(request) {
        const ready = research.readiness();
        if (!ready.ok) return { ok: false, message: ready.message };
        try {
          return { ok: true, task: await research.start(request) };
        } catch (error) {
          if (error instanceof ZodError) {
            return { ok: false, message: error.issues.map((i) => i.message).join(' ') };
          }
          return { ok: false, message: errorMessage(error) };
        }
      },

      pause(taskId) {
        try {
          const task = storage.tasks.require(taskId);
          if (!isResearchTask(task) || !research.pause(taskId)) {
            return { ok: false, message: 'Only running research tasks can be paused.' };
          }
          return { ok: true, task: storage.tasks.require(taskId) };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      },

      retry(taskId) {
        try {
          const task = storage.tasks.require(taskId);
          if (!isResearchTask(task)) {
            return { ok: false, message: 'Only research tasks can be retried.' };
          }
          return { ok: true, task: research.retry(taskId) };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      },

      progress: (task, steps) => (isResearchTask(task) ? research.progress(task, steps) : null),

      resume(taskId) {
        try {
          const task = storage.tasks.require(taskId);
          const info = recoveryInfo(task, storage.steps.listByTask(taskId));
          if (!info.resumable) {
            return {
              ok: false,
              message:
                info.reason ?? `Only interrupted tasks can be resumed (task is "${task.status}").`,
            };
          }
          return {
            ok: true,
            task: isResearchTask(task) ? research.resume(taskId) : persistenceCheck.resume(taskId),
          };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      },

      cancel(taskId) {
        try {
          if (persistenceCheck.cancel(taskId) || research.cancel(taskId)) {
            return { ok: true, task: storage.tasks.require(taskId) };
          }
          const cancelled = storage.tasks.cancel(taskId);
          if (isResearchTask(cancelled)) {
            research.note(taskId, 'task.cancelled', 'Cancelled by the user while not running.');
          }
          return { ok: true, task: cancelled };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      },

      recoveryInfo,
      whenIdle: async () => {
        await Promise.all([persistenceCheck.whenIdle(), research.whenIdle()]);
      },
    },
  };
}
