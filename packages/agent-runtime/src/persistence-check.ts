import { createHash } from 'node:crypto';
import { isModelProviderError, type ModelProvider } from '@rka/model-provider';
import { type JsonValue, type Storage, type TaskRecord, type TaskStepRecord } from '@rka/storage';

/**
 * A small, fixed diagnostic task that exercises the whole persistence path
 * with real data: the local model, task/step state, model usage and a
 * read-back from SQLite. It is NOT the research agent.
 */
export const PERSISTENCE_CHECK_KIND = 'persistence-check';
export const PERSISTENCE_CHECK_QUESTION = 'In one sentence, what is SQLite?';

const STEPS = [
  { kind: 'check', name: 'Check the local model' },
  { kind: 'generate', name: 'Ask the model a short question' },
  { kind: 'verify', name: 'Read the stored answer back from SQLite' },
] as const;

type StepKind = (typeof STEPS)[number]['kind'];

export interface PersistenceCheckDeps {
  readonly storage: Storage;
  readonly modelProvider: ModelProvider;
  readonly now?: () => Date;
}

/** "2026-11-04 21:05" in the user's local time zone. */
export function localStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function isPersistenceCheck(task: Pick<TaskRecord, 'input'>): boolean {
  const input = task.input;
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    input['kind'] === PERSISTENCE_CHECK_KIND
  );
}

export function createPersistenceCheck(deps: PersistenceCheckDeps) {
  const { storage, modelProvider } = deps;
  const now = deps.now ?? (() => new Date());
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  async function executeStep(
    kind: StepKind,
    task: TaskRecord,
    step: TaskStepRecord,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    switch (kind) {
      case 'check': {
        const health = await modelProvider.checkHealth({ signal });
        if (health.status !== 'ready') {
          throw new Error(
            health.status === 'model-missing'
              ? `Model ${health.model} is not installed.`
              : `Ollama is not reachable: ${health.error}`,
          );
        }
        return {
          status: health.status,
          model: health.model,
          serverVersion: health.serverVersion,
          capabilities: [...health.capabilities],
        };
      }
      case 'generate': {
        const question = PERSISTENCE_CHECK_QUESTION;
        const result = await modelProvider.generate(
          {
            messages: [{ role: 'user', content: question }],
            options: { temperature: 0, maxTokens: 120 },
          },
          { signal },
        );
        storage.modelUsage.record({
          taskId: task.id,
          stepId: step.id,
          provider: modelProvider.id,
          model: result.model,
          purpose: PERSISTENCE_CHECK_KIND,
          ...result.usage,
        });
        const answer = result.content.trim();
        if (!answer) throw new Error('The model returned an empty answer.');
        return {
          question,
          answer,
          sha256: sha256(answer),
          model: result.model,
          finishReason: result.finishReason,
          completionTokens: result.usage.completionTokens,
        };
      }
      case 'verify': {
        // Re-read the previous step from the database, not from memory.
        const generated = storage.steps.listByTask(task.id).find((s) => s.kind === 'generate');
        const output = generated?.output;
        if (
          !generated ||
          generated.status !== 'completed' ||
          !output ||
          typeof output !== 'object' ||
          Array.isArray(output)
        ) {
          throw new Error('The generate step has no stored output.');
        }
        const answer = output['answer'];
        const expected = output['sha256'];
        if (
          typeof answer !== 'string' ||
          typeof expected !== 'string' ||
          sha256(answer) !== expected
        ) {
          throw new Error('Stored answer does not match its checksum.');
        }
        return {
          verified: true,
          sha256: expected,
          answerLength: answer.length,
          checkedAt: now().toISOString(),
        };
      }
    }
  }

  /** Runs every step that is not completed yet, in order. Completed steps are skipped. */
  async function run(taskId: string, controller: AbortController): Promise<void> {
    const task = storage.tasks.require(taskId);
    const pending = storage.steps
      .listByTask(taskId)
      .filter((s) => s.status !== 'completed' && s.status !== 'skipped');

    for (const step of pending) {
      if (controller.signal.aborted) break;
      storage.steps.start(step.id); // Throws if the step had already completed.
      try {
        const output = await executeStep(step.kind as StepKind, task, step, controller.signal);
        storage.steps.complete(step.id, output);
      } catch (error) {
        const cancelled =
          controller.signal.aborted || (isModelProviderError(error) && error.code === 'cancelled');
        const message = cancelled
          ? 'Cancelled by the user.'
          : error instanceof Error
            ? error.message
            : String(error);
        storage.steps.fail(step.id, message);
        if (cancelled) storage.tasks.cancel(taskId);
        else storage.tasks.fail(taskId, `Step ${step.seq} (${step.name}) failed: ${message}`);
        return;
      }
    }

    if (controller.signal.aborted) {
      storage.tasks.cancel(taskId);
      return;
    }
    const steps = storage.steps.listByTask(taskId);
    const generated = steps.find((s) => s.kind === 'generate')?.output;
    storage.tasks.complete(taskId, {
      kind: PERSISTENCE_CHECK_KIND,
      verified: true,
      answer:
        generated && typeof generated === 'object' && !Array.isArray(generated)
          ? (generated['answer'] ?? null)
          : null,
      completedSteps: steps.filter((s) => s.status === 'completed').length,
    });
  }

  function launch(taskId: string): void {
    const controller = new AbortController();
    const done = run(taskId, controller)
      .catch((error: unknown) => {
        // Last-resort guard: never leave a task "running" after an unexpected error.
        console.error('Persistence check crashed:', error);
        try {
          const task = storage.tasks.require(taskId);
          if (task.status === 'running') storage.tasks.fail(taskId, String(error));
        } catch {
          // Database unavailable; recovery will mark it interrupted on next start.
        }
      })
      .finally(() => running.delete(taskId));
    running.set(taskId, { controller, done });
  }

  return {
    kind: PERSISTENCE_CHECK_KIND,

    /** Creates the task with its steps (atomically) and starts it in the background. */
    start(): TaskRecord {
      const task = storage.transaction((repos) => {
        const created = repos.tasks.create({
          title: `Persistence check · ${localStamp(now())}`,
          input: { kind: PERSISTENCE_CHECK_KIND, question: PERSISTENCE_CHECK_QUESTION },
        });
        for (const step of STEPS) repos.steps.append(created.id, step);
        return repos.tasks.start(created.id);
      });
      launch(task.id);
      return task;
    },

    /** Continues an interrupted check from its next unfinished step. */
    resume(taskId: string): TaskRecord {
      const task = storage.tasks.require(taskId);
      if (!isPersistenceCheck(task)) throw new Error('Not a persistence check task.');
      const plan = storage.recovery.resume(taskId);
      launch(taskId);
      return plan.task;
    },

    /** Stops a running check (the current step fails as cancelled). */
    cancel(taskId: string): boolean {
      const entry = running.get(taskId);
      if (!entry) return false;
      entry.controller.abort();
      return true;
    },

    isRunning: (taskId: string) => running.has(taskId),

    /** Resolves when all running checks have finished. For tests and shutdown. */
    async whenIdle(): Promise<void> {
      await Promise.all([...running.values()].map((r) => r.done));
    },
  };
}

export type PersistenceCheck = ReturnType<typeof createPersistenceCheck>;
