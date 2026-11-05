import { type GenerateChunk, type ModelProvider } from '@rka/model-provider';
import { type ChatTurn, type ModelHealth, type TaskRecoveryInfo } from '@rka/shared';
import { type Storage, type TaskRecord, type TaskStepRecord } from '@rka/storage';
import { type ToolRegistry, type ToolSummary } from '@rka/tools';
import { ZodError } from 'zod';
import { createPersistenceCheck, isPersistenceCheck } from './persistence-check.js';
import {
  createResearchAgent,
  isPausedTask,
  isResearchTask,
  type ResearchEvent,
  type ResearchLimits,
  type ResearchProgress,
  type ResearchRequest,
} from './research/index.js';

export interface AgentRuntimeDeps {
  readonly modelProvider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly storage: Storage;
  /** Progress of research tasks (for the UI). */
  readonly onResearchEvent?: (event: ResearchEvent) => void;
  /** Default research limits (requests may override within the schema bounds). */
  readonly researchDefaults?: Partial<ResearchLimits>;
}

export interface StreamChatOptions {
  readonly signal?: AbortSignal;
}

export type TaskActionOutcome =
  | { readonly ok: true; readonly task: TaskRecord }
  | { readonly ok: false; readonly message: string };

/**
 * Public surface of the agent runtime. The research agent loop is not
 * implemented yet; the only task executor is the persistence check.
 */
export interface AgentRuntime {
  /** Model used for chat and (later) agent runs. */
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
    /** Validates the goal, then creates and starts an autonomous research task. */
    startResearch(request: ResearchRequest): TaskActionOutcome;
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
  });
  const isExecuting = (id: string) => persistenceCheck.isRunning(id) || research.isRunning(id);

  function recoveryInfo(task: TaskRecord, steps: readonly TaskStepRecord[]): TaskRecoveryInfo {
    const done = steps.filter((s) => s.status === 'completed' || s.status === 'skipped');
    const next = steps.find((s) => s.status !== 'completed' && s.status !== 'skipped');
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
      pausable: task.status === 'running' && isResearchTask(task) && research.isRunning(task.id),
      cancellable:
        ['pending', 'interrupted', 'awaiting-approval'].includes(task.status) ||
        (task.status === 'running' && executing),
      completedSteps: done.length,
      totalSteps: steps.length,
      nextStep: next ? { seq: next.seq, name: next.name } : null,
    };
  }

  return {
    model: deps.modelProvider.defaultModel,
    getModelHealth: (signal) => deps.modelProvider.checkHealth({ signal }),
    listTools: () => deps.tools.list(),
    streamChat: (turns, options = {}) =>
      deps.modelProvider.generateStream(
        { messages: turns.map(({ role, content }) => ({ role, content })), think: false },
        { signal: options.signal },
      ),

    tasks: {
      runPersistenceCheck: () => persistenceCheck.start(),

      startResearch(request) {
        const ready = research.readiness();
        if (!ready.ok) return { ok: false, message: ready.message };
        try {
          return { ok: true, task: research.start(request) };
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
          return { ok: true, task: storage.tasks.cancel(taskId) };
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
