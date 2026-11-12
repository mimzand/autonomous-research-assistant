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
  BaseTool,
  StreamingMode,
  // Phase 5: needed by SqliteSessionService to restore events and read the
  // state prefixes. StaleSessionError is deliberately NOT imported: ADK exports
  // it through database_session_service.js, and importing it makes the bundler
  // keep that module and, with it, the code executors, LocalEnvironment and
  // MikroORM. SqliteSessionService defines a compatible error instead.
  createEvent,
  State,
} from '@google/adk';

export type {
  BaseAgent,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  AppendEventRequest,
  BaseLlmConnection,
  Event,
  LlmRequest,
  LlmResponse,
  RunConfig,
  Session,
} from '@google/adk';

import type { BaseTool as AdkBaseTool, LlmRequest, LlmResponse } from '@google/adk';

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
export type FunctionDeclaration = NonNullable<ReturnType<AdkBaseTool['_getDeclaration']>>;
export type ToolRunRequest = Parameters<AdkBaseTool['runAsync']>[0];
