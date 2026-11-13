/**
 * Research model calls through Google ADK (Phase 7).
 *
 * The Research step machine stays the only orchestrator. It makes every model
 * call through `ModelProvider.generate` (via `generateObject`, which parses
 * the JSON and validates it with the step's Zod schema). This class is a
 * `ModelProvider` whose `generate` runs the same request through ADK's Runner
 * and `OllamaLlm` instead of calling Ollama directly. Everything around the
 * call - prompts, JSON extraction, Zod validation, retries with feedback,
 * timeouts, usage records, checkpoints and error classification - is the
 * existing Research code, unchanged.
 *
 * Per call: a fresh in-memory ADK session (never persisted), an LlmAgent with
 * no tools, no instruction of its own and transfers disabled (so ADK adds no
 * identity prompt). The request's system message is set as the system
 * instruction in a beforeModelCallback (no ADK template processing); earlier
 * messages are appended as ordinary events; the last user message is the
 * Runner's newMessage. The request Ollama receives is the legacy request.
 */
import {
  isModelProviderError,
  ModelProviderError,
  type CallOptions,
  type ChatMessage,
  type GenerateChunk,
  type GenerateRequest,
  type GenerateResult,
  type ModelErrorCode,
  type ModelProvider,
  type OllamaProvider,
} from '@rka/model-provider';
import {
  createEvent,
  type Event,
  type GenerateContentConfig,
  InMemorySessionService,
  LlmAgent,
  type LlmRequest,
} from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { ADAPTER_ERROR_CODES, PROVIDER_ERROR_CODES } from '../ollama/errors.js';
import { OllamaLlm } from '../ollama/ollama-llm.js';

const APP_NAME = 'rka-research';
const USER_ID = 'local';
export const RESEARCH_AGENT_NAME = 'research';
const HISTORY_INVOCATION_ID = 'research-prompt';

/** A failure with a message that is safe to log and show (no internal details). */
export class AdkResearchError extends Error {
  override readonly name = 'AdkResearchError';
}

const unsupported = (message: string) => new ModelProviderError('unsupported', message);

/**
 * A ModelProvider for Research whose `generate` goes through ADK. Health and
 * model checks are delegated unchanged to the task's provider snapshot.
 */
export class AdkResearchModel implements ModelProvider {
  readonly id: string;
  readonly engine = 'adk' as const;

  constructor(private readonly provider: OllamaProvider) {
    this.id = provider.id;
  }

  get defaultModel(): string {
    return this.provider.defaultModel;
  }

  checkHealth(options?: CallOptions) {
    return this.provider.checkHealth(options);
  }

  checkModel(model?: string, options?: CallOptions) {
    return this.provider.checkModel(model, options);
  }

  // eslint-disable-next-line require-yield -- Research never streams; refuse instead of bypassing ADK.
  async *generateStream(): AsyncGenerator<GenerateChunk> {
    throw unsupported('The ADK research engine does not stream.');
  }

  async generate(request: GenerateRequest, options: CallOptions = {}): Promise<GenerateResult> {
    if (options.signal?.aborted)
      throw new ModelProviderError('cancelled', 'The request was cancelled.');
    const plan = prepare(request, this.provider.defaultModel);

    const llm = new OllamaLlm({
      provider: this.provider,
      ...(request.options?.contextLength !== undefined && {
        contextLength: request.options.contextLength,
      }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    });
    const agent = new LlmAgent({
      name: RESEARCH_AGENT_NAME,
      model: llm,
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
      ...(plan.config && { generateContentConfig: plan.config }),
      beforeModelCallback: ({ request: llmRequest }: { request: LlmRequest }) => {
        llmRequest.config ??= {};
        if (plan.system !== undefined) llmRequest.config.systemInstruction = plan.system;
        if (plan.format?.type === 'json_schema') {
          llmRequest.config.responseJsonSchema = plan.format.schema;
          llmRequest.config.responseMimeType = 'application/json';
        } else if (plan.format?.type === 'json') {
          llmRequest.config.responseMimeType = 'application/json';
        }
        delete llmRequest.config.responseSchema;
        return undefined;
      },
    });
    const sessionService = new InMemorySessionService();
    const runner = createGuardedRunner({ appName: APP_NAME, agent, sessionService });

    let session;
    try {
      session = await sessionService.createSession({ appName: APP_NAME, userId: USER_ID });
      for (const message of plan.earlier) {
        await sessionService.appendEvent({
          session,
          event: createEvent({
            invocationId: HISTORY_INVOCATION_ID,
            author: message.role === 'user' ? 'user' : RESEARCH_AGENT_NAME,
            content: {
              role: message.role === 'user' ? 'user' : 'model',
              parts: [{ text: message.content }],
            },
          }),
        });
      }
    } catch (error) {
      throw new AdkResearchError(
        `The ADK research session could not be prepared (${errorName(error)}).`,
        { cause: error },
      );
    }

    let final: Event | undefined;
    try {
      for await (const event of runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: { role: 'user', parts: [{ text: plan.last }] },
        ...(options.signal && { abortSignal: options.signal }),
      })) {
        if (event.errorCode) {
          if (event.errorCode === 'INVOCATION_ABORTED' || options.signal?.aborted) {
            throw new ModelProviderError('cancelled', 'The request was cancelled.');
          }
          throw toProviderError(event.errorCode, event.errorMessage);
        }
        if (event.author === RESEARCH_AGENT_NAME && !event.partial) final = event;
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ModelProviderError('cancelled', 'The request was cancelled.', { cause: error });
      }
      if (isModelProviderError(error) || error instanceof AdkResearchError) throw error;
      throw new AdkResearchError(`The ADK research engine failed (${errorName(error)}).`, {
        cause: error,
      });
    }
    if (options.signal?.aborted)
      throw new ModelProviderError('cancelled', 'The request was cancelled.');
    if (final?.content?.parts?.some((p) => p.functionCall || p.functionResponse)) {
      // Research gives the model no tools; a tool call is a fault, never something to run.
      throw new ModelProviderError('invalid-response', 'The model returned a tool call.');
    }
    // ADK drops a final response with neither text nor usage: an empty reply.
    return toResult(final, llm.model, request.think === true);
  }
}

interface Plan {
  readonly system: string | undefined;
  readonly earlier: readonly ChatMessage[];
  readonly last: string;
  readonly config: GenerateContentConfig | undefined;
  readonly format: GenerateRequest['responseFormat'];
}

/** Checks that the request can be sent through ADK unchanged, and splits it. */
function prepare(request: GenerateRequest, model: string): Plan {
  if (request.tools?.length) throw unsupported('Research model calls through ADK take no tools.');
  if (request.model !== undefined && request.model !== model) {
    throw unsupported('The ADK research engine uses the task’s configured model only.');
  }
  const messages = [...request.messages];
  let system: string | undefined;
  if (messages[0]?.role === 'system') system = messages.shift()?.content;
  const last = messages.pop();
  if (last?.role !== 'user') throw unsupported('The last message must be a user message.');
  for (const m of messages) {
    if (m.role === 'system') throw unsupported('Only one leading system message is supported.');
    if (m.role === 'tool' || ('toolCalls' in m && m.toolCalls?.length)) {
      throw unsupported('Tool messages are not supported in Research.');
    }
    // ADK leaves events with empty text out of the model context.
    if (m.content === '') throw unsupported('Empty messages cannot be sent through ADK.');
  }

  const o = request.options ?? {};
  if (o.repeatPenalty !== undefined) {
    throw unsupported('repeatPenalty cannot be set per request through ADK.');
  }
  const config: GenerateContentConfig = {
    ...(o.temperature !== undefined && { temperature: o.temperature }),
    ...(o.topP !== undefined && { topP: o.topP }),
    ...(o.topK !== undefined && { topK: o.topK }),
    ...(o.maxTokens !== undefined && { maxOutputTokens: o.maxTokens }),
    ...(o.stop !== undefined && { stopSequences: o.stop }),
    ...(o.seed !== undefined && { seed: o.seed }),
    ...(request.think === true && { thinkingConfig: { includeThoughts: true } }),
  };
  return {
    system,
    earlier: messages,
    last: last.content,
    config: Object.keys(config).length > 0 ? config : undefined,
    format: request.responseFormat,
  };
}

function toResult(event: Event | undefined, model: string, think: boolean): GenerateResult {
  const parts = event?.content?.parts ?? [];
  const text = (thought: boolean) =>
    parts
      .filter((p) => typeof p.text === 'string' && Boolean(p.thought) === thought)
      .map((p) => p.text ?? '')
      .join('');
  const meta = (event?.customMetadata?.['ollama'] ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const thinking = think ? text(true) : '';
  return {
    model: typeof meta['model'] === 'string' ? meta['model'] : model,
    content: text(false),
    ...(thinking && { thinking }),
    finishReason:
      event?.finishReason === 'STOP'
        ? 'stop'
        : event?.finishReason === 'MAX_TOKENS'
          ? 'length'
          : 'other',
    usage: {
      promptTokens: event?.usageMetadata?.promptTokenCount ?? null,
      completionTokens: event?.usageMetadata?.candidatesTokenCount ?? null,
      totalDurationMs: num(meta['totalDurationMs']),
      loadDurationMs: num(meta['loadDurationMs']),
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
};

const ADAPTER_INVALID_JSON = 'The model did not return valid JSON: ';

/** ADK error event → the error the legacy path would have produced. */
function toProviderError(code: string, message: string | undefined): Error {
  if (code === ADAPTER_ERROR_CODES.invalidStructuredOutput) {
    // Same text as generateObject's legacy error, so the retry feedback the
    // workflow sends back to the model is identical.
    const snippet = message?.startsWith(ADAPTER_INVALID_JSON)
      ? message.slice(ADAPTER_INVALID_JSON.length)
      : '""';
    return new ModelProviderError(
      'invalid-response',
      `Model did not return valid JSON (got: ${snippet}).`,
    );
  }
  const mapped = ADK_TO_PROVIDER[code];
  if (mapped) return new ModelProviderError(mapped, message ?? 'The model request failed.');
  // An ADK-internal error: report the code, not its (possibly internal) message.
  return new AdkResearchError(`The ADK research engine failed (${code}).`);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
