import { type ModelHealth } from '@rka/shared';
import {
  type CallOptions,
  type GenerateChunk,
  type GenerateRequest,
  type GenerateResult,
  type ModelAvailability,
} from './schemas.js';

/**
 * Provider-agnostic boundary between the agent runtime and a local model
 * server. Every method throws only `ModelProviderError`, except
 * `checkHealth`, which reports problems as data and throws only when
 * the caller cancels.
 *
 * Ollama is the only implementation in the MVP (no cloud providers).
 */
export interface ModelProvider {
  readonly id: string;
  readonly defaultModel: string;

  /** Server reachability + configured model availability, as a UI-friendly status. */
  checkHealth(options?: CallOptions): Promise<ModelHealth>;

  /** Whether a model is installed, with its capabilities. Defaults to `defaultModel`. */
  checkModel(model?: string, options?: CallOptions): Promise<ModelAvailability>;

  /** Single-shot generation. */
  generate(request: GenerateRequest, options?: CallOptions): Promise<GenerateResult>;

  /**
   * Streaming generation. Yields `delta` chunks, then exactly one `done`
   * chunk. Stopping iteration early (e.g. `break`) aborts the request.
   */
  generateStream(request: GenerateRequest, options?: CallOptions): AsyncIterable<GenerateChunk>;
}
