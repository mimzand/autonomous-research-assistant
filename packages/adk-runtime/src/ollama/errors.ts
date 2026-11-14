import { type ModelErrorCode } from '@rka/model-provider';

/** A request ADK built that the Ollama adapter cannot represent faithfully. */
export class AdkConversionError extends Error {
  override readonly name = 'AdkConversionError';
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Error codes the adapter puts on ADK `LlmResponse.errorCode`. */
export const ADAPTER_ERROR_CODES = {
  unsupportedContent: 'OLLAMA_UNSUPPORTED_CONTENT',
  unsupportedConfig: 'OLLAMA_UNSUPPORTED_CONFIG',
  schemaConversion: 'OLLAMA_SCHEMA_CONVERSION',
  invalidToolCall: 'OLLAMA_INVALID_TOOL_CALL',
  invalidStructuredOutput: 'OLLAMA_INVALID_STRUCTURED_OUTPUT',
} as const;
export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[keyof typeof ADAPTER_ERROR_CODES];

/** Provider error codes (ModelProviderError.code) as ADK error codes. */
export const PROVIDER_ERROR_CODES: Readonly<Record<ModelErrorCode, string>> = {
  unavailable: 'OLLAMA_UNAVAILABLE',
  'model-not-found': 'OLLAMA_MODEL_NOT_FOUND',
  'invalid-request': 'OLLAMA_INVALID_REQUEST',
  'invalid-response': 'OLLAMA_INVALID_RESPONSE',
  timeout: 'OLLAMA_TIMEOUT',
  cancelled: 'OLLAMA_CANCELLED',
  'http-error': 'OLLAMA_HTTP_ERROR',
  unsupported: 'OLLAMA_UNSUPPORTED',
};
