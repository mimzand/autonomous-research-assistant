import {
  type CallOptions,
  extractJson,
  type GenerateResult,
  isModelProviderError,
  type OllamaProvider,
} from '@rka/model-provider';
import {
  type GenaiFinishReason,
  type LlmRequest,
  type LlmResponse,
  type UsageMetadata,
} from '../adk.js';
import { LocalLlm } from '../local-llm.js';
import { ADAPTER_ERROR_CODES, AdkConversionError, PROVIDER_ERROR_CODES } from './errors.js';
import { toModelParts } from './messages.js';
import { toGenerateRequest } from './request.js';

export interface OllamaLlmOptions {
  /**
   * The app's configured Ollama provider. The adapter takes a snapshot, so
   * every call it makes uses the same server, model, credentials and limits,
   * even if Settings change while an agent runs.
   */
  readonly provider: OllamaProvider;
  /** Context window (num_ctx) for this agent; defaults to the provider's configuration. */
  readonly contextLength?: number;
  /** Overall deadline per model call; defaults to the provider's configuration. */
  readonly timeoutMs?: number;
  /** Streams only: maximum silence between chunks; defaults to the provider's configuration. */
  readonly idleTimeoutMs?: number;
}

/**
 * Google ADK model backed by the app's Ollama provider. ADK never talks to
 * Ollama itself: every request goes through OllamaProvider, so its host,
 * TLS, token, redirect, timeout and tool-calling policies apply unchanged.
 *
 * - Non-streaming: one final response.
 * - Streaming (RunConfig streamingMode SSE): partial text responses, then one
 *   final response with the complete text, tool calls, finish reason and usage.
 *   ADK persists only the final response, so text is not duplicated in the
 *   session; a UI must render partials and treat the final one as the result.
 * - Tool calls are only ever emitted in the final response, after the whole
 *   reply arrived and every call was parsed. If any call is invalid (unknown
 *   tool, malformed arguments) no call is emitted at all: the response becomes
 *   an OLLAMA_INVALID_TOOL_CALL error, so nothing half-valid can be executed.
 * - Structured output (responseSchema / responseJsonSchema / JSON mime type):
 *   the final text must parse as JSON (think tags and code fences are
 *   tolerated and stripped) or the response becomes an
 *   OLLAMA_INVALID_STRUCTURED_OUTPUT error. Shape validation against the Zod
 *   schema happens at the application boundary (see structured.ts).
 * - Errors are returned as `errorCode` / `errorMessage` responses; a cancelled
 *   request returns nothing (ADK reports the abort itself).
 */
export class OllamaLlm extends LocalLlm {
  private readonly provider: OllamaProvider;
  private readonly options: Omit<OllamaLlmOptions, 'provider'>;

  constructor(options: OllamaLlmOptions) {
    const snapshot = options.provider.snapshot();
    super({ model: snapshot.defaultModel });
    this.provider = snapshot;
    this.options = {
      ...(options.contextLength !== undefined && { contextLength: options.contextLength }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      ...(options.idleTimeoutMs !== undefined && { idleTimeoutMs: options.idleTimeoutMs }),
    };
  }

  /** The Ollama server this model talks to (for logs and UI). */
  get baseUrl(): string {
    return this.provider.currentConfig.baseUrl;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    let converted;
    try {
      converted = toGenerateRequest(llmRequest, {
        model: this.model,
        ...(this.options.contextLength !== undefined && {
          contextLength: this.options.contextLength,
        }),
      });
    } catch (error) {
      yield errorResponse(error);
      return;
    }

    const callOptions: CallOptions = {
      ...(abortSignal && { signal: abortSignal }),
      ...((converted.timeoutMs ?? this.options.timeoutMs) !== undefined && {
        timeoutMs: converted.timeoutMs ?? this.options.timeoutMs,
      }),
      ...(stream &&
        this.options.idleTimeoutMs !== undefined && { idleTimeoutMs: this.options.idleTimeoutMs }),
    };

    try {
      let result: GenerateResult | undefined;
      if (stream) {
        for await (const chunk of this.provider.generateStream(converted.request, callOptions)) {
          if (chunk.type === 'delta') {
            const parts = [
              ...(chunk.thinking ? [{ text: chunk.thinking, thought: true }] : []),
              ...(chunk.content ? [{ text: chunk.content }] : []),
            ];
            if (parts.length > 0) yield { content: { role: 'model', parts }, partial: true };
          } else {
            result = chunk.result;
          }
        }
      } else {
        result = await this.provider.generate(converted.request, callOptions);
      }
      if (!result) return;
      if (abortSignal?.aborted) return; // never hand a result (or tool calls) to an aborted run
      yield finalResponse(result, converted.structured);
    } catch (error) {
      if (abortSignal?.aborted || (isModelProviderError(error) && error.code === 'cancelled'))
        return;
      yield errorResponse(error);
    }
  }
}

function finalResponse(result: GenerateResult, structured: boolean): LlmResponse {
  if (result.invalidToolCalls?.length) {
    return {
      errorCode: ADAPTER_ERROR_CODES.invalidToolCall,
      errorMessage: result.invalidToolCalls.map((c) => c.message).join(' '),
      turnComplete: true,
      ...usage(result),
    };
  }

  let content: string | undefined;
  if (structured && !result.toolCalls?.length) {
    const json = extractJson(result.content);
    if (json === undefined) {
      return {
        errorCode: ADAPTER_ERROR_CODES.invalidStructuredOutput,
        errorMessage: `The model did not return valid JSON: ${JSON.stringify(result.content.slice(0, 200))}`,
        turnComplete: true,
        ...usage(result),
      };
    }
    content = JSON.stringify(json);
  }

  return {
    content: { role: 'model', parts: toModelParts(result, content) },
    partial: false,
    turnComplete: true,
    finishReason: finishReason(result.finishReason),
    ...usage(result),
    customMetadata: {
      ollama: {
        model: result.model,
        totalDurationMs: result.usage.totalDurationMs,
        loadDurationMs: result.usage.loadDurationMs,
      },
    },
  };
}

function usage(result: GenerateResult): { usageMetadata?: UsageMetadata } {
  const { promptTokens, completionTokens } = result.usage;
  if (promptTokens === null && completionTokens === null) return {};
  return {
    usageMetadata: {
      ...(promptTokens !== null && { promptTokenCount: promptTokens }),
      ...(completionTokens !== null && { candidatesTokenCount: completionTokens }),
      ...(promptTokens !== null &&
        completionTokens !== null && { totalTokenCount: promptTokens + completionTokens }),
    },
  };
}

function finishReason(reason: GenerateResult['finishReason']): GenaiFinishReason {
  const map = { stop: 'STOP', length: 'MAX_TOKENS', other: 'OTHER' } as const;
  return map[reason] as GenaiFinishReason;
}

function errorResponse(error: unknown): LlmResponse {
  if (error instanceof AdkConversionError) {
    return { errorCode: error.code, errorMessage: error.message, turnComplete: true };
  }
  if (isModelProviderError(error)) {
    return {
      errorCode: PROVIDER_ERROR_CODES[error.code],
      errorMessage: error.message,
      turnComplete: true,
    };
  }
  return {
    errorCode: 'OLLAMA_ADAPTER_ERROR',
    errorMessage: error instanceof Error ? error.message : String(error),
    turnComplete: true,
  };
}
