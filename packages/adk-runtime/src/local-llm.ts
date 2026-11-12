import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from './adk.js';

/**
 * Base class for every model this app lets ADK talk to. Only subclasses of
 * LocalLlm pass the agent guard, so Gemini, Apigee or any other cloud model
 * (and model names resolved through ADK's registry) are rejected.
 *
 * `supportedModels` is empty on purpose: local models are never registered in
 * ADK's LLMRegistry and are always passed to agents as instances.
 */
export abstract class LocalLlm extends BaseLlm {
  static override readonly supportedModels: (string | RegExp)[] = [];

  abstract override generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void>;

  /** Live (bidirectional audio/video) sessions are not supported by local models. */
  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(new Error(`${this.model} does not support live connections.`));
  }
}

export const isLocalLlm = (value: unknown): value is LocalLlm => value instanceof LocalLlm;
