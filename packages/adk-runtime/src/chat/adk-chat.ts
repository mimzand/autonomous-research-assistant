/**
 * Stateless Chat through Google ADK (Phase 6).
 *
 * Same input and output as the legacy Chat path (`AgentRuntime.streamChat`):
 * the renderer-supplied turns in, provider `GenerateChunk`s out (text deltas,
 * then one `done` with the result and usage), and `ModelProviderError`s for
 * failures, so the Electron ChatController and the IPC contract are unchanged.
 *
 * Per request:
 * - an OllamaLlm snapshot of the app's provider (same server, model,
 *   credentials, generation defaults, context size and timeouts as legacy);
 * - a fresh InMemorySessionService and session, never shared or persisted;
 * - the earlier turns are appended to that session as ordinary ADK events
 *   through the public `appendEvent` API; the last user turn is the Runner's
 *   `newMessage`, so it appears exactly once;
 * - an LlmAgent with no instruction, no tools and transfers disabled, so ADK
 *   adds no system prompt and the model receives the same messages as legacy.
 */
import {
  isModelProviderError,
  ModelProviderError,
  type GenerateChunk,
  type GenerateResult,
  type ModelErrorCode,
  type OllamaProvider,
} from '@rka/model-provider';
import { type ChatTurn } from '@rka/shared';
import {
  createEvent,
  type Event,
  InMemorySessionService,
  LlmAgent,
  StreamingMode,
} from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { ADAPTER_ERROR_CODES, PROVIDER_ERROR_CODES } from '../ollama/errors.js';
import { OllamaLlm } from '../ollama/ollama-llm.js';
import {
  streamChatWithWebSearch,
  type AdkChatChunk,
  type AdkChatWebSearch,
} from './adk-chat-tools.js';

export const APP_NAME = 'rka-chat';
export const USER_ID = 'local';
/** The agent's name is also the author of earlier assistant turns. */
export const CHAT_AGENT_NAME = 'chat';
const HISTORY_INVOCATION_ID = 'chat-history';

export interface AdkChatOptions {
  /** The app's Ollama provider (tool calling disabled, as in production). */
  readonly provider: OllamaProvider;
  /**
   * Web search (Phase 8, opt-in `chat.webSearch`): when set, this request runs
   * with the app's ToolGateway (see adk-chat-tools.ts). Without it, Chat is the
   * plain, tool-free path below.
   */
  readonly webSearch?: AdkChatWebSearch;
}

export interface AdkChatEngine {
  readonly name: 'adk';
  streamChat(
    turns: readonly ChatTurn[],
    options?: { readonly signal?: AbortSignal },
  ): AsyncGenerator<AdkChatChunk, void>;
}

/** A Chat failure with a message that is safe to show (no internal details). */
export class AdkChatError extends Error {
  override readonly name = 'AdkChatError';
}

export const cancelled = () => new ModelProviderError('cancelled', 'The request was cancelled.');

export function createAdkChatEngine(options: AdkChatOptions): AdkChatEngine {
  return {
    name: 'adk',
    streamChat: (turns, { signal } = {}) =>
      options.webSearch
        ? streamChatWithWebSearch(turns, signal, options.webSearch)
        : streamChat(options.provider, turns, signal),
  };
}

/** Checks the turns: the last one must be a non-empty user message; no empty history turns. */
export function splitTurns(turns: readonly ChatTurn[]): { last: ChatTurn; earlier: ChatTurn[] } {
  const last = turns.at(-1);
  if (last?.role !== 'user' || !last.content.trim()) {
    throw new ModelProviderError(
      'invalid-request',
      'The last message must be a non-empty user message.',
    );
  }
  const earlier = turns.slice(0, -1);
  // ADK leaves events whose text is "" out of the model's context, so such a
  // turn could not be sent faithfully. The app's renderer never sends one.
  if (earlier.some((t) => t.content === '')) {
    throw new ModelProviderError(
      'unsupported',
      'The ADK chat engine cannot send empty messages in the conversation history.',
    );
  }
  return { last, earlier };
}

/** A fresh in-memory session holding the earlier turns as ordinary ADK events. */
export async function openChatSession(
  sessionService: InMemorySessionService,
  earlier: readonly ChatTurn[],
) {
  let session;
  try {
    session = await sessionService.createSession({ appName: APP_NAME, userId: USER_ID });
    for (const turn of earlier) {
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: HISTORY_INVOCATION_ID,
          author: turn.role === 'user' ? 'user' : CHAT_AGENT_NAME,
          content: {
            role: turn.role === 'user' ? 'user' : 'model',
            parts: [{ text: turn.content }],
          },
        }),
      });
    }
  } catch (error) {
    throw new AdkChatError(`The ADK chat session could not be prepared (${errorName(error)}).`, {
      cause: error,
    });
  }

  return session;
}

async function* streamChat(
  provider: OllamaProvider,
  turns: readonly ChatTurn[],
  signal: AbortSignal | undefined,
): AsyncGenerator<GenerateChunk, void> {
  if (signal?.aborted) throw cancelled();
  const { last, earlier } = splitTurns(turns);

  const llm = new OllamaLlm({ provider }); // snapshot: settings are fixed for this request
  const agent = new LlmAgent({
    name: CHAT_AGENT_NAME,
    model: llm,
    // No transfer targets: ADK then adds no identity system prompt.
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
  });
  const sessionService = new InMemorySessionService();
  const runner = createGuardedRunner({ appName: APP_NAME, agent, sessionService });

  const session = await openChatSession(sessionService, earlier);

  let emitted = '';
  let final: Event | undefined;
  try {
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text: last.content }] },
      runConfig: { streamingMode: StreamingMode.SSE },
      ...(signal && { abortSignal: signal }),
    })) {
      if (event.errorCode) {
        if (event.errorCode === 'INVOCATION_ABORTED' || signal?.aborted) throw cancelled();
        throw toProviderError(event.errorCode, event.errorMessage);
      }
      if (event.author !== CHAT_AGENT_NAME) continue;
      if (event.partial) {
        const text = visibleText(event);
        if (text) {
          emitted += text;
          yield { type: 'delta', content: text };
        }
        continue;
      }
      final = event;
    }
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (isModelProviderError(error) || error instanceof AdkChatError) throw error;
    throw new AdkChatError(`The ADK chat engine failed (${errorName(error)}).`, { cause: error });
  }

  if (signal?.aborted) throw cancelled();
  if (!final && emitted) {
    throw new ModelProviderError('invalid-response', 'The model returned no final response.');
  }
  // ADK drops a final response with neither text nor usage: that is an empty reply.
  final ??= createEvent({ author: CHAT_AGENT_NAME, invocationId: '' });
  if (final.content?.parts?.some((p) => p.functionCall || p.functionResponse)) {
    // Chat has no tools; a tool call here would be a fault, never something to run.
    throw new ModelProviderError('invalid-response', 'The model returned a tool call in Chat.');
  }

  const content = visibleText(final);
  if (!content.startsWith(emitted)) {
    // The streamed text and the final text disagree: never append or duplicate.
    throw new ModelProviderError(
      'invalid-response',
      'The streamed reply did not match the final reply.',
    );
  }
  const rest = content.slice(emitted.length);
  if (rest) yield { type: 'delta', content: rest }; // final-only responses
  yield { type: 'done', result: toResult(final, llm.model, content) };
}

/** Visible answer text: text parts that are not the model's thoughts. */
export function visibleText(event: Event): string {
  return (event.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text ?? '')
    .join('');
}

export function toResult(event: Event, model: string, content: string): GenerateResult {
  const meta = (event.customMetadata?.['ollama'] ?? {}) as {
    model?: unknown;
    totalDurationMs?: unknown;
    loadDurationMs?: unknown;
  };
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    model: typeof meta.model === 'string' ? meta.model : model,
    content,
    finishReason:
      event.finishReason === 'STOP'
        ? 'stop'
        : event.finishReason === 'MAX_TOKENS'
          ? 'length'
          : 'other',
    usage: {
      promptTokens: event.usageMetadata?.promptTokenCount ?? null,
      completionTokens: event.usageMetadata?.candidatesTokenCount ?? null,
      totalDurationMs: num(meta.totalDurationMs),
      loadDurationMs: num(meta.loadDurationMs),
    },
  };
}

const ADK_TO_PROVIDER: Readonly<Record<string, ModelErrorCode>> = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_ERROR_CODES).map(([code, adk]) => [adk, code as ModelErrorCode]),
  ),
  [ADAPTER_ERROR_CODES.unsupportedConfig]: 'unsupported',
  [ADAPTER_ERROR_CODES.unsupportedContent]: 'unsupported',
  [ADAPTER_ERROR_CODES.schemaConversion]: 'unsupported',
  [ADAPTER_ERROR_CODES.invalidToolCall]: 'invalid-response',
  [ADAPTER_ERROR_CODES.invalidStructuredOutput]: 'invalid-response',
};

/** ADK error event → the provider error the legacy path would have thrown. */
export function toProviderError(code: string, message: string | undefined): Error {
  const mapped = ADK_TO_PROVIDER[code];
  if (mapped) return new ModelProviderError(mapped, message ?? 'The model request failed.');
  // An ADK-internal error: report the code, not its (possibly internal) message.
  return new AdkChatError(`The ADK chat engine failed (${code}).`);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
