import { type GenerateChunk, type ModelProvider } from '@rka/model-provider';
import { type ChatTurn, type ModelHealth } from '@rka/shared';
import { type TaskRepository } from '@rka/storage';
import { type ToolRegistry, type ToolSummary } from '@rka/tools';

export interface AgentRuntimeDeps {
  readonly modelProvider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly tasks: TaskRepository;
}

export interface StreamChatOptions {
  readonly signal?: AbortSignal;
}

/**
 * Public surface of the agent runtime. The planning/tool-calling loop is
 * intentionally not implemented yet - this is the composition root that
 * later features plug into.
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
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  return {
    model: deps.modelProvider.defaultModel,
    getModelHealth: (signal) => deps.modelProvider.checkHealth({ signal }),
    listTools: () => deps.tools.list(),
    streamChat: (turns, options = {}) =>
      deps.modelProvider.generateStream(
        { messages: turns.map(({ role, content }) => ({ role, content })), think: false },
        { signal: options.signal },
      ),
  };
}
