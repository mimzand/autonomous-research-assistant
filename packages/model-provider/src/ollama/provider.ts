import { type ModelHealth, type ModelUnavailableReason } from '@rka/shared';
import { type z } from 'zod';
import { type OllamaConfig } from '../config.js';
import { ModelProviderError, isModelProviderError } from '../errors.js';
import { type ModelProvider } from '../provider.js';
import {
  GenerateRequestSchema,
  type CallOptions,
  type FinishReason,
  type GenerateChunk,
  type GenerateRequest,
  type GenerateResult,
  type ModelAvailability,
  type ModelInfo,
} from '../schemas.js';
import { parseNdjson, truncate } from './ndjson.js';
import { RequestScope } from './scope.js';
import {
  OllamaChatChunkSchema,
  OllamaErrorBodySchema,
  OllamaTagsSchema,
  OllamaVersionSchema,
  type OllamaChatBody,
  type OllamaChatChunk,
  type OllamaTags,
} from './wire.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaProviderOptions {
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: FetchLike;
  /** Injected for tests. */
  readonly now?: () => Date;
}

/** First Ollama version with JSON-schema constrained output (`format: {schema}`). */
const STRUCTURED_OUTPUT_MIN_VERSION: readonly [number, number, number] = [0, 5, 0];

/** Local Ollama server via its HTTP API. The only ModelProvider in the MVP. */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly defaultModel: string;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(
    private readonly config: OllamaConfig,
    options: OllamaProviderOptions = {},
  ) {
    this.defaultModel = config.model;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Health & models
  // ---------------------------------------------------------------------------

  async checkHealth(options: CallOptions = {}): Promise<ModelHealth> {
    const base = {
      provider: 'ollama',
      baseUrl: this.config.baseUrl,
      model: this.defaultModel,
      checkedAt: this.now().toISOString(),
    } as const;

    try {
      const serverVersion = await this.getVersion(options);
      const tags = await this.getTags(options);
      const found = findModel(tags, this.defaultModel);
      if (!found) {
        return {
          ...base,
          status: 'model-missing',
          serverVersion,
          installedModels: tags.models.map((m) => m.name),
        };
      }
      return {
        ...base,
        status: 'ready',
        serverVersion,
        capabilities: found.capabilities.slice(),
        contextLength: found.contextLength,
        structuredOutput: supportsStructuredOutput(serverVersion),
      };
    } catch (error) {
      const failure = asProviderError(error);
      if (failure.code === 'cancelled') throw failure;
      return { ...base, status: 'unreachable', reason: toReason(failure), error: failure.message };
    }
  }

  async checkModel(
    model = this.defaultModel,
    options: CallOptions = {},
  ): Promise<ModelAvailability> {
    const tags = await this.getTags(options);
    const found = findModel(tags, model);
    return found
      ? { available: true, model: found }
      : { available: false, requested: model, installedModels: tags.models.map((m) => m.name) };
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  async generate(request: GenerateRequest, options: CallOptions = {}): Promise<GenerateResult> {
    const body = await this.buildChatBody(request, false, options);
    const scope = new RequestScope({
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.config.generateTimeoutMs,
    });
    try {
      const response = await this.send('/api/chat', body, scope);
      const json = await readJson(response, scope);
      const chunk = parseChunk(json);
      if (!chunk.done) {
        throw new ModelProviderError(
          'invalid-response',
          'Model server returned an incomplete response.',
        );
      }
      return toResult(chunk, chunk.message.content, chunk.message.thinking ?? '', body.think);
    } catch (error) {
      throw scope.toError(error);
    } finally {
      scope.release();
    }
  }

  async *generateStream(
    request: GenerateRequest,
    options: CallOptions = {},
  ): AsyncGenerator<GenerateChunk, void, undefined> {
    const body = await this.buildChatBody(request, true, options);
    const scope = new RequestScope({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? this.config.streamIdleTimeoutMs,
    });

    let content = '';
    let thinking = '';
    try {
      const response = await this.send('/api/chat', body, scope);
      if (!response.body) {
        throw new ModelProviderError('invalid-response', 'Model server returned an empty stream.');
      }
      for await (const line of parseNdjson(response.body, () => scope.touch())) {
        const chunk = parseChunk(line);
        content += chunk.message.content;
        thinking += chunk.message.thinking ?? '';

        if (chunk.message.content || chunk.message.thinking) {
          yield chunk.message.thinking
            ? { type: 'delta', content: chunk.message.content, thinking: chunk.message.thinking }
            : { type: 'delta', content: chunk.message.content };
        }
        if (chunk.done) {
          yield { type: 'done', result: toResult(chunk, content, thinking, body.think) };
          return;
        }
      }
      scope.throwIfAborted();
      throw new ModelProviderError('invalid-response', 'Model stream ended before completion.');
    } catch (error) {
      throw scope.toError(error);
    } finally {
      // Also runs when the consumer breaks early: aborts the HTTP request.
      scope.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async buildChatBody(
    request: GenerateRequest,
    stream: boolean,
    options: CallOptions,
  ): Promise<OllamaChatBody> {
    const parsed = GenerateRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new ModelProviderError(
        'invalid-request',
        `Invalid generate request: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const req = parsed.data;
    const opts = req.options ?? {};

    const body: OllamaChatBody = {
      model: req.model ?? this.defaultModel,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      // Always explicit: qwen3 thinks by default, and `false` is accepted by every model.
      think: req.think ?? false,
      options: {
        num_ctx: opts.contextLength ?? this.config.numCtx,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.topP !== undefined && { top_p: opts.topP }),
        ...(opts.seed !== undefined && { seed: opts.seed }),
        ...(opts.maxTokens !== undefined && { num_predict: opts.maxTokens }),
        ...(opts.stop !== undefined && { stop: opts.stop }),
      },
    };

    const format = req.responseFormat;
    if (format?.type === 'json') body.format = 'json';
    if (format?.type === 'json_schema') {
      const version = await this.getVersion({ signal: options.signal });
      if (!supportsStructuredOutput(version)) {
        throw new ModelProviderError(
          'unsupported',
          `Structured output needs Ollama ${STRUCTURED_OUTPUT_MIN_VERSION.join('.')} or newer (found ${version}).`,
        );
      }
      body.format = format.schema;
    }
    return body;
  }

  private async getVersion(options: CallOptions): Promise<string> {
    const { version } = await this.getJson('/api/version', OllamaVersionSchema, options);
    return version;
  }

  private getTags(options: CallOptions): Promise<OllamaTags> {
    return this.getJson('/api/tags', OllamaTagsSchema, options);
  }

  private async getJson<T>(path: string, schema: z.ZodType<T>, options: CallOptions): Promise<T> {
    const scope = new RequestScope({
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.config.requestTimeoutMs,
    });
    try {
      const response = await this.request(path, { method: 'GET' }, scope);
      const json = await readJson(response, scope);
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ModelProviderError('invalid-response', `Unexpected response from ${path}.`, {
          cause: parsed.error,
        });
      }
      return parsed.data;
    } catch (error) {
      throw scope.toError(error);
    } finally {
      scope.release();
    }
  }

  private send(path: string, body: OllamaChatBody, scope: RequestScope): Promise<Response> {
    return this.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      scope,
    );
  }

  private async request(path: string, init: RequestInit, scope: RequestScope): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...init.headers },
        signal: scope.signal,
      });
    } catch (error) {
      throw scope.toError(error, `Cannot reach Ollama at ${this.config.baseUrl}`);
    }
    if (!response.ok) throw await toHttpError(response);
    return response;
  }
}

/** Factory kept for symmetry with other packages. */
export function createOllamaProvider(
  config: OllamaConfig,
  options: OllamaProviderOptions = {},
): OllamaProvider {
  return new OllamaProvider(config, options);
}

// -----------------------------------------------------------------------------
// Helpers (exported for tests)
// -----------------------------------------------------------------------------

/** "qwen3" matches "qwen3:latest"; otherwise names must match exactly. */
export function matchesModel(installedName: string, wanted: string): boolean {
  if (installedName === wanted) return true;
  return !wanted.includes(':') && installedName === `${wanted}:latest`;
}

export function supportsStructuredOutput(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return true; // Unknown/dev build: assume a current server.
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (parts.every((p) => p === 0)) return true; // Dev builds report 0.0.0.
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const need = STRUCTURED_OUTPUT_MIN_VERSION[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

function findModel(tags: OllamaTags, wanted: string): ModelInfo | undefined {
  const entry = tags.models.find((m) => matchesModel(m.name, wanted));
  if (!entry) return undefined;
  return {
    name: entry.name,
    capabilities: entry.capabilities ?? [],
    contextLength: entry.details?.context_length ?? null,
    parameterSize: entry.details?.parameter_size ?? null,
    quantization: entry.details?.quantization_level ?? null,
  };
}

function parseChunk(value: unknown): OllamaChatChunk {
  const inStreamError = OllamaErrorBodySchema.safeParse(value);
  if (inStreamError.success) {
    throw new ModelProviderError('http-error', `Model server error: ${inStreamError.data.error}`);
  }
  const parsed = OllamaChatChunkSchema.safeParse(value);
  if (!parsed.success) {
    throw new ModelProviderError(
      'invalid-response',
      `Unexpected chat response: ${truncate(JSON.stringify(value))}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function readJson(response: Response, scope: RequestScope): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw scope.toError(error, 'Connection to the model server was lost');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ModelProviderError(
      'invalid-response',
      `Model server returned non-JSON: ${truncate(text)}`,
      {
        cause,
      },
    );
  }
}

async function toHttpError(response: Response): Promise<ModelProviderError> {
  const text = await response.text().catch(() => '');
  let message = text;
  try {
    const parsed = OllamaErrorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) message = parsed.data.error;
  } catch {
    // Non-JSON error body: keep raw text.
  }
  message = truncate(message || response.statusText || 'no details');
  const status = response.status;

  if (status === 404 && /not found/i.test(message)) {
    return new ModelProviderError('model-not-found', `Model not installed: ${message}`, { status });
  }
  if (status === 400 && /does not support/i.test(message)) {
    return new ModelProviderError('unsupported', message, { status });
  }
  if (status === 400) {
    return new ModelProviderError(
      'invalid-request',
      `Model server rejected the request: ${message}`,
      {
        status,
      },
    );
  }
  return new ModelProviderError('http-error', `Model server error (HTTP ${status}): ${message}`, {
    status,
  });
}

function toResult(
  chunk: OllamaChatChunk,
  content: string,
  thinking: string,
  think: boolean,
): GenerateResult {
  const nsToMs = (ns: number | undefined): number | null =>
    ns === undefined ? null : Math.round(ns / 1e6);
  return {
    model: chunk.model,
    content,
    ...(think && thinking ? { thinking } : {}),
    finishReason: toFinishReason(chunk.done_reason),
    usage: {
      promptTokens: chunk.prompt_eval_count ?? null,
      completionTokens: chunk.eval_count ?? null,
      totalDurationMs: nsToMs(chunk.total_duration),
      loadDurationMs: nsToMs(chunk.load_duration),
    },
  };
}

function toFinishReason(reason: string | undefined): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  return 'other';
}

function asProviderError(error: unknown): ModelProviderError {
  return isModelProviderError(error)
    ? error
    : new ModelProviderError(
        'invalid-response',
        error instanceof Error ? error.message : String(error),
        {
          cause: error,
        },
      );
}

function toReason(error: ModelProviderError): ModelUnavailableReason {
  switch (error.code) {
    case 'unavailable':
    case 'timeout':
    case 'invalid-response':
      return error.code;
    default:
      return 'http-error';
  }
}
