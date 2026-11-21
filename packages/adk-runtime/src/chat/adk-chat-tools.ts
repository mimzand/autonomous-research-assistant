/**
 * ADK Chat with web search (Phase 8, opt-in `chat.webSearch`).
 *
 * Same policy as Legacy Chat, from the same place: the app's ToolGateway (in
 * agent-runtime, passed in structurally) is the only thing that decides and
 * executes a tool call. ADK only proposes calls:
 * - the agent carries RegistryTool instances in gateway mode (the only tool
 *   type the guards admit), one per gateway declaration (only web_search);
 * - a beforeModelCallback adds the tool instruction and removes the tools once
 *   the gateway's round budget is used, so the last model call must answer;
 * - RunConfig.maxLlmCalls (rounds + 1) is a hard backstop;
 * - the gateway turn's signal (user Stop + 60 s deadline) aborts the run.
 * Tool steps are streamed as they happen through a small queue.
 */
import {
  isModelProviderError,
  ModelProviderError,
  type GenerateChunk,
  type GenerateResult,
  type OllamaProvider,
  type ToolDefinition,
} from '@rka/model-provider';
import { type ChatTurn } from '@rka/shared';
import { type ToolRegistry } from '@rka/tools';
import {
  type Event,
  InMemorySessionService,
  type LlmRequest,
  LlmAgent,
  StreamingMode,
} from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { ADAPTER_ERROR_CODES } from '../ollama/errors.js';
import { OllamaLlm } from '../ollama/ollama-llm.js';
import {
  createRegistryTools,
  type GatewayActivity,
  type GatewayTurnLike,
} from '../tools/registry-tool.js';
import {
  AdkChatError,
  APP_NAME,
  cancelled,
  CHAT_AGENT_NAME,
  errorName,
  openChatSession,
  splitTurns,
  toProviderError,
  toResult,
  USER_ID,
  visibleText,
} from './adk-chat.js';

/** One gateway turn, as ADK Chat uses it (agent-runtime GatewayTurn). */
export interface AdkGatewayTurn extends GatewayTurnLike {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  beginRound(): boolean;
}

/** The app's ToolGateway (agent-runtime), typed structurally. */
export interface AdkChatGateway {
  readonly limits: {
    readonly maxRounds: number;
    readonly maxCalls: number;
    readonly turnTimeoutMs: number;
  };
  declarations(): ToolDefinition[];
  beginTurn(signal: AbortSignal): AdkGatewayTurn;
}

export interface AdkChatWebSearch {
  readonly gateway: AdkChatGateway;
  /** The registry the gateway wraps (tool metadata for the bridge). */
  readonly registry: ToolRegistry;
  /** A tool-enabled snapshot of the app's provider (never the shared provider). */
  readonly provider: OllamaProvider;
  /** System instruction for tool use (the same text Legacy Chat sends). */
  readonly systemPrompt: string;
  /** Shown when the model gave no text after using tools. */
  readonly noAnswerText: string;
}

/** Usage of a model round that ended in tool calls. */
export interface AdkUsageChunk {
  readonly type: 'usage';
  readonly result: GenerateResult;
}
export type AdkChatChunk = GenerateChunk | GatewayActivity | AdkUsageChunk;

const hasFunctionParts = (event: Event) =>
  (event.content?.parts ?? []).some((p) => p.functionCall || p.functionResponse);

export async function* streamChatWithWebSearch(
  turns: readonly ChatTurn[],
  callerSignal: AbortSignal | undefined,
  options: AdkChatWebSearch,
  /** Chat context preface (see adk-chat.ts), added after the tool instruction. */
  preface?: string,
): AsyncGenerator<AdkChatChunk, void> {
  if (callerSignal?.aborted) throw cancelled();
  const { last, earlier } = splitTurns(turns);
  const { gateway } = options;
  const declarations = gateway.declarations();
  if (declarations.length === 0) {
    throw new ModelProviderError('unsupported', 'Web search is not available for Chat.');
  }
  const turn = gateway.beginTurn(callerSignal ?? new AbortController().signal);
  const fail = (error: unknown): Error => {
    if (turn.cancelled) return cancelled();
    if (turn.timedOut) {
      return new ModelProviderError(
        'timeout',
        `The reply with web search took longer than ${Math.round(gateway.limits.turnTimeoutMs / 1000)} s and was stopped.`,
      );
    }
    if (isModelProviderError(error) || error instanceof AdkChatError) return error;
    return new AdkChatError(`The ADK chat engine failed (${errorName(error)}).`, { cause: error });
  };

  // Everything the generator yields, in order: runner events and tool steps.
  type Item = { kind: 'event'; event: Event } | { kind: 'tool'; activity: GatewayActivity };
  const queue: Item[] = [];
  let wake: (() => void) | undefined;
  const push = (item: Item) => {
    queue.push(item);
    wake?.();
  };

  const tools = createRegistryTools(options.registry, {
    allow: declarations.map((d) => d.name),
    // Not used in gateway mode (the gateway enforces its own limits); required by the bridge.
    limits: {
      maxCallsPerInvocation: 1,
      maxCallDurationMs: 1,
      maxResultBytes: 1,
      maxIdenticalCalls: 1,
    },
    gateway: { turn, declarations, onActivity: (activity) => push({ kind: 'tool', activity }) },
  });
  let toolsWithdrawn = false;
  const llm = new OllamaLlm({ provider: options.provider });
  const agent = new LlmAgent({
    name: CHAT_AGENT_NAME,
    model: llm,
    tools,
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
    beforeModelCallback: ({ request }: { request: LlmRequest }) => {
      request.config ??= {};
      request.config.systemInstruction = preface
        ? `${options.systemPrompt}\n\n${preface}`
        : options.systemPrompt;
      if (!turn.beginRound()) {
        // Round budget used (or no calls/bytes left): this model call must answer.
        delete request.config.tools;
        request.toolsDict = {};
        toolsWithdrawn = true;
      }
      return undefined;
    },
  });
  const sessionService = new InMemorySessionService();
  const runner = createGuardedRunner({
    appName: APP_NAME,
    agent,
    sessionService,
    registryTools: tools,
  });
  const session = await openChatSession(sessionService, earlier);

  let finished = false;
  let failure: unknown;
  const done = (async () => {
    try {
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: { role: 'user', parts: [{ text: last.content }] },
        runConfig: {
          streamingMode: StreamingMode.SSE,
          maxLlmCalls: gateway.limits.maxRounds + 1,
        },
        abortSignal: turn.signal,
      })) {
        push({ kind: 'event', event });
      }
    } catch (error) {
      failure = error;
    } finally {
      finished = true;
      wake?.();
    }
  })();

  let emitted = ''; // text of the current model response
  let usedTools = false;
  let final: Event | undefined;
  try {
    for (;;) {
      const item = queue.shift();
      if (!item) {
        if (finished) break;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        continue;
      }
      if (item.kind === 'tool') {
        // Tool steps are always shown, including a step stopped by cancellation.
        usedTools = true;
        yield item.activity;
        continue;
      }
      if (turn.signal.aborted) throw fail(turn.signal.reason);
      const event = item.event;
      if (event.errorCode) {
        if (event.errorCode === 'INVOCATION_ABORTED' || turn.signal.aborted) {
          throw fail(turn.signal.reason);
        }
        if (event.errorCode === ADAPTER_ERROR_CODES.invalidToolCall && toolsWithdrawn) {
          // The last call offered no tools but the model still tried one: nothing is
          // run; the reply ends with the fixed "no answer" text (as in Legacy Chat).
          final = undefined;
          emitted = '';
          break;
        }
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
      if (hasFunctionParts(event)) {
        // A tool round (the call, or the tools' responses): not the answer.
        if (event.content?.parts?.some((p) => p.functionCall)) {
          yield { type: 'usage', result: toResult(event, llm.model, visibleText(event)) };
        }
        emitted = '';
        continue;
      }
      final = event;
    }
    await done;
    if (failure !== undefined) throw failure;
  } catch (error) {
    throw fail(error);
  }

  if (turn.signal.aborted) throw fail(turn.signal.reason);
  const content = final ? visibleText(final) : '';
  if (usedTools && !content.trim()) {
    yield { type: 'delta', content: options.noAnswerText };
    const base = final ?? ({ author: CHAT_AGENT_NAME } as Event);
    yield {
      type: 'done',
      result: { ...toResult(base, llm.model, ''), content: options.noAnswerText },
    };
    return;
  }
  if (!final && emitted) {
    throw new ModelProviderError('invalid-response', 'The model returned no final response.');
  }
  if (final && !content.startsWith(emitted)) {
    throw new ModelProviderError(
      'invalid-response',
      'The streamed reply did not match the final reply.',
    );
  }
  const rest = content.slice(emitted.length);
  if (rest) yield { type: 'delta', content: rest };
  yield {
    type: 'done',
    result: toResult(final ?? ({ author: CHAT_AGENT_NAME } as Event), llm.model, content),
  };
}
