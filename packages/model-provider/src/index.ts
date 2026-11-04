// Provider-agnostic contract
export { type ModelProvider } from './provider.js';
export {
  ChatMessageSchema,
  GenerateRequestSchema,
  GenerationOptionsSchema,
  ResponseFormatSchema,
  type CallOptions,
  type ChatMessage,
  type FinishReason,
  type GenerateChunk,
  type GenerateRequest,
  type GenerateResult,
  type GenerationOptions,
  type ModelAvailability,
  type ModelInfo,
  type ResponseFormat,
  type Usage,
} from './schemas.js';
export {
  MODEL_ERROR_CODES,
  ModelProviderError,
  describeRequestError,
  isModelProviderError,
  type ModelErrorCode,
} from './errors.js';
export { generateObject, toModelJsonSchema, type StructuredResult } from './structured.js';

// Ollama (the only implementation)
export {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_GENERATE_TIMEOUT_MS,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_NUM_CTX,
  OLLAMA_DEFAULT_PORT,
  OLLAMA_DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  OllamaConfigSchema,
  loadOllamaConfig,
  resolveOllamaBaseUrl,
  type OllamaConfig,
  type OllamaEnv,
} from './config.js';
export {
  OllamaProvider,
  createOllamaProvider,
  matchesModel,
  supportsStructuredOutput,
  type FetchLike,
  type OllamaProviderOptions,
} from './ollama/provider.js';
