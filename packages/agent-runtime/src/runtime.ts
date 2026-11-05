import { type GenerateChunk, type ModelProvider } from '@rka/model-provider';
import { type ChatTurn, type ModelHealth, type TaskRecoveryInfo } from '@rka/shared';
import { type Storage, type TaskRecord, type TaskStepRecord } from '@rka/storage';
import { type ToolRegistry, type ToolSummary } from '@rka/tools';
import { createPersistenceCheck, isPersistenceCheck } from './persistence-check.js';

export interface AgentRuntimeDeps {
  readonly modelProvider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly storage: Storage;
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

  function recoveryInfo(task: TaskRecord, steps: readonly TaskStepRecord[]): TaskRecoveryInfo {
    const done = steps.filter((s) => s.status === 'completed' || s.status === 'skipped');
    const next = steps.find((s) => s.status !== 'completed' && s.status !== 'skipped');
    const hasExecutor = isPersistenceCheck(task);
    const executing = persistenceCheck.isRunning(task.id);

    let reason: string | null = null;
    if (task.status === 'interrupted' && !hasExecutor) {
      reason =
        'No executor is available for this task type yet, so it cannot be resumed. It stays interrupted until resumed or cancelled.';
    }
    return {
      resumable: task.status === 'interrupted' && hasExecutor && !executing,
      reason,
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
          return { ok: true, task: persistenceCheck.resume(taskId) };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      },

      cancel(taskId) {
        try {
          if (persistenceCheck.cancel(taskId)) {
            return { ok: true, task: storage.tasks.require(taskId) };
          }
          return { ok: true, task: storage.tasks.cancel(taskId) };
        } catch (error) {
          return { ok: false, message: errorMessage(error) };
        }
      },

      recoveryInfo,
      whenIdle: () => persistenceCheck.whenIdle(),
    },
  };
}
