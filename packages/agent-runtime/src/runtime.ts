import { type ModelProvider } from '@rka/model-provider';
import { type ModelHealth } from '@rka/shared';
import { type TaskRepository } from '@rka/storage';
import { type ToolRegistry, type ToolSummary } from '@rka/tools';

export interface AgentRuntimeDeps {
  readonly modelProvider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly tasks: TaskRepository;
}

/**
 * Public surface of the agent runtime. The planning/tool-calling loop is
 * intentionally not implemented yet - this is the composition root that
 * later features plug into.
 */
export interface AgentRuntime {
  getModelHealth(signal?: AbortSignal): Promise<ModelHealth>;
  listTools(): readonly ToolSummary[];
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  return {
    getModelHealth: (signal) => deps.modelProvider.checkHealth({ signal }),
    listTools: () => deps.tools.list(),
  };
}
