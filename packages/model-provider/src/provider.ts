import { type ModelHealth } from '@rka/shared';

/**
 * Boundary between the agent runtime and a local model server.
 * Chat/tool-calling methods are added when agent functionality is built.
 */
export interface ModelProvider {
  readonly id: 'ollama';
  readonly model: string;
  checkHealth(signal?: AbortSignal): Promise<ModelHealth>;
}
