/**
 * The only module in the repository that imports `@google/adk`.
 *
 * Everything the app may use from ADK is re-exported here, by name. Anything
 * not listed - Gemini and other Google models, the model registry, code
 * executors (UnsafeLocalCodeExecutor, ContainerCodeExecutor, ...),
 * LocalEnvironment, Google search / Vertex / MCP / OpenAPI tools, file, GCS or
 * database artifact and session services - is unreachable from app code. A
 * guard test fails if another file imports `@google/adk` or if this list grows
 * without the test being updated.
 */
export {
  version as ADK_VERSION,
  BaseLlm,
  isBaseLlm,
  LlmAgent,
  isLlmAgent,
  Runner,
  InMemorySessionService,
  BaseSessionService,
  StreamingMode,
} from '@google/adk';

export type {
  BaseAgent,
  BaseLlmConnection,
  BaseTool,
  Event,
  LlmRequest,
  LlmResponse,
  RunConfig,
  Session,
} from '@google/adk';

import type { LlmRequest, LlmResponse } from '@google/adk';

/*
 * Google GenAI types, derived from ADK's own request/response types so that
 * no app module imports @google/genai (a security test enforces that).
 */
export type Content = LlmRequest['contents'][number];
export type Part = NonNullable<Content['parts']>[number];
export type GenerateContentConfig = NonNullable<LlmRequest['config']>;
export type GenaiSchema = Extract<
  NonNullable<GenerateContentConfig['responseSchema']>,
  { type?: unknown }
>;
export type GenaiFinishReason = NonNullable<LlmResponse['finishReason']>;
export type UsageMetadata = NonNullable<LlmResponse['usageMetadata']>;
