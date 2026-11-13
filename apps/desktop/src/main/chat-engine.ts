import { loadAdkRuntime, type AdkRuntime } from '@rka/adk-runtime';
import { type AgentRuntime } from '@rka/agent-runtime';
import { type GenerateChunk, type OllamaProvider } from '@rka/model-provider';
import { type ChatTurn } from '@rka/shared';
import { z } from 'zod';

/*
 * Chat engine selection (ADK migration, phase 6).
 *
 * `agent.engine` chooses how Chat talks to Ollama:
 * - "legacy" (default): AgentRuntime.streamChat → OllamaProvider.
 * - "adk": Google ADK Runner + OllamaLlm → the same OllamaProvider.
 *
 * Both engines take the renderer-supplied turns and produce the same
 * GenerateChunk stream, so ChatController, IPC and the renderer do not change.
 *
 * The flag is a main-process setting only (not in the Settings page or the
 * IPC settings view): the `AGENT_ENGINE` variable in settings.env (installed
 * app), .env (development) or the process environment. It is read when each
 * Chat request starts; a request keeps the engine it started with.
 */

export const AgentEngineSchema = z.enum(['legacy', 'adk']);
export type AgentEngine = z.infer<typeof AgentEngineSchema>;

/** Environment variable that carries the `agent.engine` flag. */
export const AGENT_ENGINE_ENV = 'AGENT_ENGINE';
export const DEFAULT_AGENT_ENGINE: AgentEngine = 'legacy';

export interface ChatEngine {
  readonly name: AgentEngine;
  /** Throws `ModelProviderError` (or an Error with a safe message) on failure. */
  streamChat(
    turns: readonly ChatTurn[],
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<GenerateChunk>;
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

/** The existing Chat path, unchanged. */
export function legacyChatEngine(runtime: Pick<AgentRuntime, 'streamChat'>): ChatEngine {
  return { name: 'legacy', streamChat: (turns, options) => runtime.streamChat(turns, options) };
}

/**
 * Chat through ADK. ADK is loaded on first use (after its environment
 * sanitisation). If it cannot be loaded, the request fails with a controlled
 * error: Chat never switches engines by itself.
 */
export function adkChatEngine(
  provider: OllamaProvider,
  load: () => Promise<AdkRuntime> = loadAdkRuntime,
): ChatEngine {
  return {
    name: 'adk',
    async *streamChat(turns, options) {
      let runtime: AdkRuntime;
      try {
        runtime = await load();
      } catch (error) {
        console.error(
          `ADK chat engine unavailable: ${error instanceof Error ? error.name : 'error'}`,
        );
        throw new Error(
          `The ADK chat engine could not be started. Set ${AGENT_ENGINE_ENV}=legacy to use the legacy engine.`,
          { cause: error },
        );
      }
      yield* runtime.engine.createAdkChatEngine({ provider }).streamChat(turns, options);
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
  readonly loadAdk?: () => Promise<AdkRuntime>;
  readonly log?: (message: string) => void;
}): () => ChatEngine {
  const env = deps.env ?? process.env;
  return createChatEngineSelector({
    legacy: legacyChatEngine(deps.runtime),
    adk: adkChatEngine(deps.provider, deps.loadAdk),
    readFlag: () => env[AGENT_ENGINE_ENV],
    ...(deps.log && { log: deps.log }),
  });
}
