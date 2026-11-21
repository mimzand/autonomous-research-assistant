import { loadAdkRuntime, type AdkRuntime } from '@rka/adk-runtime';
import {
  CHAT_TOOL_LIMITS,
  createToolGateway,
  NO_ANSWER_TEXT,
  streamChatWithTools,
  toolSystemPrompt,
  type AgentRuntime,
  type ChatStreamChunk,
  type ToolAuditEntry,
  type ToolGateway,
} from '@rka/agent-runtime';
import { type OllamaProvider } from '@rka/model-provider';
import { type ChatTurn } from '@rka/shared';
import { type ToolRegistry } from '@rka/tools';
import { z } from 'zod';

/*
 * Chat engine selection (ADK migration, phase 6).
 *
 * `agent.engine` chooses how Chat talks to Ollama:
 * - "legacy" (default): AgentRuntime.streamChat → OllamaProvider.
 * - "adk": Google ADK Runner + OllamaLlm → the same OllamaProvider.
 *
 * Both engines take the same turns (the window of the stored transcript, built by
 * ChatController) and produce the same
 * GenerateChunk stream, so ChatController, IPC and the renderer do not change.
 *
 * Source: the effective `engine.chat` setting — `AGENT_ENGINE` when set and
 * valid (an override), else the value saved in Settings → Agent Engines, else
 * "legacy" (apps/desktop/src/main/config/env-overrides.ts). It is read when each Chat request
 * starts; a request keeps the engine it started with.
 *
 * Web search (Phase 8.2): when `chat.webSearch` is on and SearXNG is
 * configured, the LEGACY engine answers through `streamChatWithTools`: a
 * bounded loop over a dedicated, tool-enabled snapshot of the provider, with
 * every tool call going through the ToolGateway. The ADK engine uses the same
 * gateway through RegistryTool in gateway mode. When it is off, both engines
 * are exactly the paths they always were.
 */

export const AgentEngineSchema = z.enum(['legacy', 'adk']);
export type AgentEngine = z.infer<typeof AgentEngineSchema>;

/** Environment variable that carries the `agent.engine` flag. */
export const AGENT_ENGINE_ENV = 'AGENT_ENGINE';
export const DEFAULT_AGENT_ENGINE: AgentEngine = 'legacy';

export interface ChatEngineOptions {
  readonly signal: AbortSignal;
  /**
   * Chat context note when earlier stored turns were left out (chat-context.ts).
   * Legacy sends it as one system message before the turns; ADK uses it as this
   * request's instruction. Absent, both engines are unchanged.
   */
  readonly preface?: string;
}

export interface ChatEngine {
  readonly name: AgentEngine;
  /** Throws `ModelProviderError` (or an Error with a safe message) on failure. */
  streamChat(
    turns: readonly ChatTurn[],
    options: ChatEngineOptions,
  ): AsyncIterable<ChatStreamChunk>;
}

/** Model-driven web search for Legacy Chat (Phase 8.2). */
export interface ChatWebSearch {
  /** Setting on and SearXNG configured. Read once when a request starts. */
  readonly enabled: () => boolean;
  /** The only executor of model-produced tool calls. */
  readonly gateway: ToolGateway;
  /** The registry the gateway wraps (tool metadata for the ADK bridge). */
  readonly registry: ToolRegistry;
  /** A new tool-enabled snapshot of the app's provider, per request. */
  readonly provider: () => OllamaProvider;
}

/** Production web search for Chat: the gateway allows `web_search` only, with the Phase 8.2 limits. */
export function createChatWebSearch(deps: {
  readonly registry: ToolRegistry;
  readonly provider: OllamaProvider;
  /** `chat.webSearch` (default false). */
  readonly settingEnabled: () => boolean;
  readonly searchConfigured: () => boolean;
  readonly audit?: (entry: ToolAuditEntry) => void;
}): ChatWebSearch {
  const gateway = createToolGateway({
    registry: deps.registry,
    policy: { surface: 'chat', allow: ['web_search'], limits: CHAT_TOOL_LIMITS },
    ...(deps.audit && { audit: deps.audit }),
  });
  return {
    enabled: () =>
      deps.settingEnabled() && deps.searchConfigured() && gateway.declarations().length > 0,
    gateway,
    registry: deps.registry,
    // Only this path gets a provider that accepts tool calls; the shared one stays closed.
    provider: () => deps.provider.withToolCalling(),
  };
}

/**
 * Validates a flag value. Unset → legacy. An unknown value also selects
 * legacy (the safe engine) and returns a warning to log.
 */
export function parseAgentEngine(raw: string | undefined): {
  engine: AgentEngine;
  warning?: string;
} {
  const value = raw?.trim().toLowerCase();
  if (!value) return { engine: DEFAULT_AGENT_ENGINE };
  const parsed = AgentEngineSchema.safeParse(value);
  if (parsed.success) return { engine: parsed.data };
  return {
    engine: DEFAULT_AGENT_ENGINE,
    warning: `Ignoring ${AGENT_ENGINE_ENV}=${JSON.stringify(value.slice(0, 40))}: use "legacy" or "adk". Chat uses the legacy engine.`,
  };
}

/**
 * The Legacy Chat engine. Without web search (or with it turned off) this is
 * the existing path, unchanged.
 */
export function legacyChatEngine(
  runtime: Pick<AgentRuntime, 'streamChat'>,
  webSearch?: ChatWebSearch,
): ChatEngine {
  return {
    name: 'legacy',
    streamChat: (turns, options) =>
      webSearch?.enabled()
        ? streamChatWithTools(turns, options, {
            provider: webSearch.provider(),
            gateway: webSearch.gateway,
          })
        : runtime.streamChat(turns, options),
  };
}

/**
 * Chat through ADK. ADK is loaded on first use (after its environment
 * sanitisation). If it cannot be loaded, the request fails with a controlled
 * error: Chat never switches engines by itself.
 */
export function adkChatEngine(
  provider: OllamaProvider,
  load: () => Promise<AdkRuntime> = loadAdkRuntime,
  webSearch?: ChatWebSearch,
): ChatEngine {
  return {
    name: 'adk',
    async *streamChat(turns, options) {
      // Read once when the request starts, like Legacy Chat.
      const search = webSearch?.enabled() ? webSearch : undefined;
      let runtime: AdkRuntime;
      try {
        runtime = await load();
      } catch (error) {
        console.error(
          `ADK chat engine unavailable: ${error instanceof Error ? error.name : 'error'}`,
        );
        throw new Error(
          `The ADK chat engine could not be started. Choose Legacy for Chat in Settings → Agent Engines to use the legacy engine.`,
          { cause: error },
        );
      }
      yield* runtime.engine
        .createAdkChatEngine({
          provider,
          ...(search && {
            // The same ToolGateway as Legacy Chat decides and executes every call.
            webSearch: {
              gateway: search.gateway,
              registry: search.registry,
              provider: search.provider(),
              systemPrompt: toolSystemPrompt(
                search.gateway.declarations().map((d) => d.name),
                search.gateway.limits.maxCalls,
              ),
              noAnswerText: NO_ANSWER_TEXT,
            },
          }),
        })
        .streamChat(turns, options);
    },
  };
}

export interface ChatEngineSelectorOptions {
  readonly legacy: ChatEngine;
  readonly adk: ChatEngine;
  /** Current raw flag value, read at the start of each request. */
  readonly readFlag: () => string | undefined;
  readonly log?: (message: string) => void;
}

/** Returns the engine for a new request and logs whenever the selection changes. */
export function createChatEngineSelector(options: ChatEngineSelectorOptions): () => ChatEngine {
  const log = options.log ?? ((message: string) => console.info(message));
  let lastLogged: string | undefined;
  return () => {
    const { engine, warning } = parseAgentEngine(options.readFlag());
    const note = warning ?? `Chat engine: ${engine}`;
    if (note !== lastLogged) {
      log(note);
      lastLogged = note;
    }
    return engine === 'adk' ? options.adk : options.legacy;
  };
}

/** Production wiring: the engines over the app's runtime and provider, flag from the environment. */
export function createAppChatEngines(deps: {
  readonly runtime: Pick<AgentRuntime, 'streamChat'>;
  readonly provider: OllamaProvider;
  readonly env?: NodeJS.ProcessEnv;
  /** Current engine choice (the app passes the effective setting); default: `AGENT_ENGINE` from `env`. */
  readonly readFlag?: () => string | undefined;
  readonly loadAdk?: () => Promise<AdkRuntime>;
  readonly log?: (message: string) => void;
  /** Web search for Chat, Legacy and ADK (off unless its setting is on). */
  readonly webSearch?: ChatWebSearch;
}): () => ChatEngine {
  const env = deps.env ?? process.env;
  return createChatEngineSelector({
    legacy: legacyChatEngine(deps.runtime, deps.webSearch),
    adk: adkChatEngine(deps.provider, deps.loadAdk, deps.webSearch),
    readFlag: deps.readFlag ?? (() => env[AGENT_ENGINE_ENV]),
    ...(deps.log && { log: deps.log }),
  });
}
