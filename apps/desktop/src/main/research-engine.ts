import { loadAdkRuntime, type AdkRuntime } from '@rka/adk-runtime';
import { type TaskModelConfig } from '@rka/agent-runtime';
import {
  ModelProviderError,
  type CallOptions,
  type GenerateChunk,
  type GenerateRequest,
  type GenerateResult,
  type ModelProvider,
  type OllamaProvider,
} from '@rka/model-provider';
import { z } from 'zod';
import { taskModelsFor } from './config/services.js';

/*
 * Research engine selection (ADK migration, phase 7).
 *
 * `research.engine` chooses how Research model calls reach Ollama:
 * - "legacy" (default): the task's OllamaProvider snapshot, unchanged.
 * - "adk": the same snapshot behind Google ADK (Runner + OllamaLlm).
 * Everything else - the step machine, prompts, Zod validation, retries,
 * checkpoints, tools and usage records - is the same Research code.
 *
 * Source: the `RESEARCH_ENGINE` variable (settings.env, .env or the process
 * environment), independent of Chat's `AGENT_ENGINE`.
 *
 * Pinning: the engine is read once, when a task starts, and stored with the
 * task's captured model configuration (`task.input.model.config`, already an
 * opaque JSON snapshot owned by this module). Resume, Retry and restart
 * recovery use the stored engine, never the current flag. Legacy tasks store
 * nothing new (their input is byte-identical to before), so every task created
 * before Phase 7 is a legacy task.
 */

export const ResearchEngineSchema = z.enum(['legacy', 'adk']);
export type ResearchEngine = z.infer<typeof ResearchEngineSchema>;
export const RESEARCH_ENGINE_ENV = 'RESEARCH_ENGINE';
export const DEFAULT_RESEARCH_ENGINE: ResearchEngine = 'legacy';
/** Key inside the captured model configuration that pins a task to ADK. */
export const PINNED_ENGINE_KEY = 'researchEngine';

/** Validates the flag. Unset → legacy; an unknown value → legacy with a warning. */
export function parseResearchEngine(raw: string | undefined): {
  engine: ResearchEngine;
  warning?: string;
} {
  const value = raw?.trim().toLowerCase();
  if (!value) return { engine: DEFAULT_RESEARCH_ENGINE };
  const parsed = ResearchEngineSchema.safeParse(value);
  if (parsed.success) return { engine: parsed.data };
  return {
    engine: DEFAULT_RESEARCH_ENGINE,
    warning: `Ignoring ${RESEARCH_ENGINE_ENV}=${JSON.stringify(value.slice(0, 40))}: use "legacy" or "adk". New research tasks use the legacy engine.`,
  };
}

/** The engine a task was started with. Tasks without a pin are legacy tasks. */
export function pinnedEngine(captured: TaskModelConfig): ResearchEngine | { unknown: string } {
  const config = captured.config;
  const value =
    typeof config === 'object' && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>)[PINNED_ENGINE_KEY]
      : undefined;
  if (value === undefined) return 'legacy';
  const parsed = ResearchEngineSchema.safeParse(value);
  return parsed.success ? parsed.data : { unknown: String(value).slice(0, 40) };
}

export interface ResearchTaskModelsOptions {
  /** Current raw flag value; read when a task starts. */
  readonly readFlag?: () => string | undefined;
  readonly loadAdk?: () => Promise<AdkRuntime>;
  readonly log?: (message: string) => void;
}

/**
 * Task isolation for Research (replaces `taskModelsFor` in main): the existing
 * Ollama configuration capture, plus the pinned engine.
 */
export function researchTaskModelsFor(
  provider: OllamaProvider,
  options: ResearchTaskModelsOptions = {},
) {
  const base = taskModelsFor(provider);
  const readFlag = options.readFlag ?? (() => process.env[RESEARCH_ENGINE_ENV]);
  const log = options.log ?? ((message: string) => console.info(message));
  return {
    capture: (): TaskModelConfig => {
      const captured = base.capture();
      const { engine, warning } = parseResearchEngine(readFlag());
      log(warning ?? `Research engine for the new task: ${engine}`);
      if (engine === 'legacy') return captured;
      return {
        ...captured,
        config: {
          ...(captured.config as Record<string, TaskModelConfig['config']>),
          [PINNED_ENGINE_KEY]: engine,
        },
      };
    },
    providerFor: (captured: TaskModelConfig): ModelProvider => {
      const snapshot = base.providerFor(captured);
      const engine = pinnedEngine(captured);
      if (engine === 'legacy') return snapshot;
      if (engine === 'adk') return new LazyAdkResearchModel(snapshot, options.loadAdk);
      return new UnknownEngineModel(snapshot, engine.unknown);
    },
  };
}

/** ADK-backed provider that loads ADK on the first model call. */
class LazyAdkResearchModel implements ModelProvider {
  readonly id: string;
  private model: ModelProvider | undefined;

  constructor(
    private readonly snapshot: OllamaProvider,
    private readonly load: () => Promise<AdkRuntime> = loadAdkRuntime,
  ) {
    this.id = snapshot.id;
  }

  get defaultModel(): string {
    return this.snapshot.defaultModel;
  }

  checkHealth(options?: CallOptions) {
    return this.snapshot.checkHealth(options);
  }

  checkModel(model?: string, options?: CallOptions) {
    return this.snapshot.checkModel(model, options);
  }

  async generate(request: GenerateRequest, options?: CallOptions): Promise<GenerateResult> {
    if (!this.model) {
      let runtime: AdkRuntime;
      try {
        runtime = await this.load();
      } catch (error) {
        console.error(
          `ADK research engine unavailable: ${error instanceof Error ? error.name : 'error'}`,
        );
        // Not retried and never replaced by the legacy engine: the task's step fails visibly.
        throw new Error(
          'The ADK research engine could not be started. This task was started with the ADK engine; fix the installation or start a new task with RESEARCH_ENGINE=legacy.',
          { cause: error },
        );
      }
      this.model = new runtime.engine.AdkResearchModel(this.snapshot);
    }
    return this.model.generate(request, options);
  }

  // eslint-disable-next-line require-yield -- Research never streams.
  async *generateStream(): AsyncGenerator<GenerateChunk> {
    throw new ModelProviderError('unsupported', 'The ADK research engine does not stream.');
  }
}

/** A task pinned to an engine this version does not know: never run it on another one. */
class UnknownEngineModel implements ModelProvider {
  readonly id: string;
  constructor(
    private readonly snapshot: OllamaProvider,
    private readonly engine: string,
  ) {
    this.id = snapshot.id;
  }
  get defaultModel(): string {
    return this.snapshot.defaultModel;
  }
  checkHealth(options?: CallOptions) {
    return this.snapshot.checkHealth(options);
  }
  checkModel(model?: string, options?: CallOptions) {
    return this.snapshot.checkModel(model, options);
  }
  generate(): Promise<GenerateResult> {
    return Promise.reject(
      new Error(
        `This task was started with the research engine ${JSON.stringify(this.engine)}, which this version does not support. It is not run with a different engine.`,
      ),
    );
  }
  // eslint-disable-next-line require-yield -- Never streams.
  async *generateStream(): AsyncGenerator<GenerateChunk> {
    throw new ModelProviderError('unsupported', 'Unknown research engine.');
  }
}
