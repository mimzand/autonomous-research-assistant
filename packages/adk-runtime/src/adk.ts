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
  Event,
  LlmRequest,
  LlmResponse,
  RunConfig,
  Session,
} from '@google/adk';
