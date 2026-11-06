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
  OllamaShowSchema,
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
  /**
   * Bearer token for an authenticating reverse proxy. Read per request, never
   * stored on the provider, and only sent over HTTPS or to this computer.
   */
  readonly getAuthToken?: () => string | undefined;
  /** False while the user has disconnected from Ollama in Settings. */
  readonly isConnected?: () => boolean;
}

/** One installed model as listed by /api/tags. */
export interface OllamaModelSummary {
  readonly name: string;
  readonly family: string | null;
  readonly families: readonly string[];
  readonly parameterSize: string | null;
  readonly quantization: string | null;
  readonly format: string | null;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
  readonly digest: string | null;
}

/** Details of one model from /api/show. */
export interface OllamaModelDetails {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly family: string | null;
  readonly parameterSize: string | null;
  readonly quantization: string | null;
  readonly format: string | null;
  readonly contextLength: number | null;
  readonly architecture: string | null;
  readonly parameters: string | null;
  readonly license: string | null;
  readonly modifiedAt: string | null;
}

export interface OllamaConnectionInfo {
  readonly version: string;
  readonly latencyMs: number;
}

/** First Ollama version with JSON-schema constrained output (`format: {schema}`). */
const STRUCTURED_OUTPUT_MIN_VERSION: readonly [number, number, number] = [0, 5, 0];

const DISCONNECTED_MESSAGE =
  'Disconnected from Ollama. Connect again in Settings → Ollama Connection.';

/**
 * Ollama server via its HTTP API. The only ModelProvider in the MVP.
 *
 * The configuration can be replaced at run time (`reconfigure`). Every request
 * reads the configuration once when it starts, so a running request or
 * stream finishes with the settings it started with. `snapshot()` returns an
 * independent provider frozen to the current configuration, used by research
 * tasks so that they never switch server or model mid-task.
 */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';

  private config: OllamaConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(
    config: OllamaConfig,
    private readonly options: OllamaProviderOptions = {},
  ) {
    this.config = freeze(config);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  get defaultModel(): string {
    return this.config.model;
  }

  /** The configuration new requests use. */
  get currentConfig(): OllamaConfig {
    return this.config;
  }

  /** Applies a new configuration to subsequent requests (running ones are unaffected). */
  reconfigure(config: OllamaConfig): void {
    this.config = freeze(config);
  }

  /** An independent provider fixed to the current configuration. */
  snapshot(config: OllamaConfig = this.config): OllamaProvider {
    return new OllamaProvider(config, this.options);
  }

  // ---------------------------------------------------------------------------
  // Health & models
  // ---------------------------------------------------------------------------

  async checkHealth(options: CallOptions = {}): Promise<ModelHealth> {
    const config = this.config;
    const base = {
      provider: 'ollama',
      baseUrl: config.baseUrl,
      model: config.model,
      checkedAt: this.now().toISOString(),
    } as const;
    if (!this.connected()) {
      return {
        ...base,
        status: 'unreachable',
        reason: 'disconnected',
        error: DISCONNECTED_MESSAGE,
      };
    }

    try {
      const serverVersion = await this.getVersion(config, options);
      const tags = await this.getTags(config, options);
      const found = findModel(tags, config.model);
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
    const tags = await this.getTags(this.config, options);
    const found = findModel(tags, model);
    return found
      ? { available: true, model: found }
      : { available: false, requested: model, installedModels: tags.models.map((m) => m.name) };
  }

  /** GET /api/version with the measured round-trip time. Ignores the Disconnect state. */
  async testConnection(options: CallOptions = {}): Promise<OllamaConnectionInfo> {
    const started = performance.now();
    const version = await this.getVersion(this.config, options, { ignoreDisconnect: true });
    return { version, latencyMs: Math.round(performance.now() - started) };
  }

  /** Installed models (GET /api/tags), sorted by name. */
  async listModels(options: CallOptions = {}): Promise<OllamaModelSummary[]> {
    const tags = await this.getTags(this.config, options);
    return tags.models
      .map((m) => ({
        name: m.name,
        family: m.details?.family ?? null,
        families: m.details?.families ?? [],
        parameterSize: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
        format: m.details?.format ?? null,
        sizeBytes: m.size ?? null,
        modifiedAt: m.modified_at ?? null,
        digest: m.digest ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Model details and capabilities (POST /api/show). */
  async showModel(name: string, options: CallOptions = {}): Promise<OllamaModelDetails> {
    const config = this.config;
    const scope = new RequestScope({
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? Math.max(config.requestTimeoutMs, 15_000),
    });
    try {
      const response = await this.request(
        config,
        '/api/show',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name }),
        },
        scope,
      );
      const parsed = OllamaShowSchema.safeParse(await readJson(response, scope));
      if (!parsed.success) {
        throw new ModelProviderError('invalid-response', 'Unexpected response from /api/show.', {
          cause: parsed.error,
        });
      }
      const show = parsed.data;
      const info = show.model_info ?? {};
      const architecture =
        typeof info['general.architecture'] === 'string' ? info['general.architecture'] : null;
      const ctx = architecture ? info[`${architecture}.context_length`] : undefined;
      return {
        name,
        capabilities: show.capabilities ?? [],
        family: show.details?.family ?? null,
        parameterSize: show.details?.parameter_size ?? null,
        quantization: show.details?.quantization_level ?? null,
        format: show.details?.format ?? null,
        contextLength:
          typeof ctx === 'number' && Number.isInteger(ctx) && ctx > 0
            ? ctx
            : (show.details?.context_length ?? null),
        architecture,
        parameters: show.parameters ? truncate(show.parameters.trim(), 2000) : null,
        license: show.license ? truncate(show.license.trim().split('\n')[0] ?? '', 200) : null,
        modifiedAt: show.modified_at ?? null,
      };
    } catch (error) {
      throw scope.toError(error);
    } finally {
      scope.release();
    }
  }

  /** The `options` object sent to Ollama for a request without its own options. */
  effectiveOptions(config: OllamaConfig = this.config): OllamaChatBody['options'] {
    return toWireOptions(config, {});
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  async generate(request: GenerateRequest, options: CallOptions = {}): Promise<GenerateResult> {
    const config = this.config;
    const body = await this.buildChatBody(config, request, false, options);
    const scope = new RequestScope({
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? config.generateTimeoutMs,
    });
    try {
      const response = await this.send(config, '/api/chat', body, scope);
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
    // Captured once: a settings change during the stream does not affect it.
    const config = this.config;
    const body = await this.buildChatBody(config, request, true, options);
    const scope = new RequestScope({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? config.streamIdleTimeoutMs,
    });

    let content = '';
    let thinking = '';
    try {
      const response = await this.send(config, '/api/chat', body, scope);
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

  private connected(): boolean {
    return this.options.isConnected?.() ?? true;
  }

  private async buildChatBody(
    config: OllamaConfig,
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

    const body: OllamaChatBody = {
      model: req.model ?? config.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      // Always explicit: qwen3 thinks by default, and `false` is accepted by every model.
      think: req.think ?? false,
      options: toWireOptions(config, req.options ?? {}),
    };

    const format = req.responseFormat;
    if (format?.type === 'json') body.format = 'json';
    if (format?.type === 'json_schema') {
      const version = await this.getVersion(config, { signal: options.signal });
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

  private async getVersion(
    config: OllamaConfig,
    options: CallOptions,
    flags: { ignoreDisconnect?: boolean } = {},
  ): Promise<string> {
    const { version } = await this.getJson(
      config,
      '/api/version',
      OllamaVersionSchema,
      options,
      flags,
    );
    return version;
  }

  private getTags(config: OllamaConfig, options: CallOptions): Promise<OllamaTags> {
    return this.getJson(config, '/api/tags', OllamaTagsSchema, options);
  }

  private async getJson<T>(
    config: OllamaConfig,
    path: string,
    schema: z.ZodType<T>,
    options: CallOptions,
    flags: { ignoreDisconnect?: boolean } = {},
  ): Promise<T> {
    const scope = new RequestScope({
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? config.requestTimeoutMs,
    });
    try {
      const response = await this.request(config, path, { method: 'GET' }, scope, flags);
      const json = await readJson(response, scope);
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new ModelProviderError(
          'invalid-response',
          `Unexpected response from ${path}. Is ${config.baseUrl} an Ollama server?`,
          { cause: parsed.error },
        );
      }
      return parsed.data;
    } catch (error) {
      throw scope.toError(error);
    } finally {
      scope.release();
    }
  }

  private send(
    config: OllamaConfig,
    path: string,
    body: OllamaChatBody,
    scope: RequestScope,
  ): Promise<Response> {
    return this.request(
      config,
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      scope,
    );
  }

  private async request(
    config: OllamaConfig,
    path: string,
    init: RequestInit,
    scope: RequestScope,
    flags: { ignoreDisconnect?: boolean } = {},
  ): Promise<Response> {
    if (!flags.ignoreDisconnect && !this.connected()) {
      throw new ModelProviderError('unavailable', DISCONNECTED_MESSAGE);
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    const token = this.options.getAuthToken?.();
    // The token never travels over plain HTTP to another machine.
    if (token && canSendToken(config.baseUrl)) headers['authorization'] = `Bearer ${token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        headers,
        // Redirects are refused: a redirect could send prompts (and the token) elsewhere.
        redirect: 'manual',
        signal: scope.signal,
      });
    } catch (error) {
      throw scope.toError(error, `Cannot reach Ollama at ${config.baseUrl}`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelProviderError(
        'http-error',
        `The server at ${config.baseUrl} answered with a redirect (HTTP ${response.status}). Redirects are not followed; enter the final URL instead.`,
        { status: response.status },
      );
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelProviderError(
        'http-error',
        `The server at ${config.baseUrl} refused access (HTTP ${response.status}). Check the access token in Settings.`,
        { status: response.status },
      );
    }
    if (!response.ok) throw await toHttpError(response);
    return response;
  }
}

/** Ollama `options` for a request: request values win over the configured defaults. */
function toWireOptions(
  config: OllamaConfig,
  opts: NonNullable<GenerateRequest['options']>,
): OllamaChatBody['options'] {
  const defaults = config.generation;
  const pick = <T>(own: T | undefined, fallback: T | undefined) => own ?? fallback;
  const temperature = pick(opts.temperature, defaults.temperature);
  const topP = pick(opts.topP, defaults.topP);
  const topK = pick(opts.topK, defaults.topK);
  const maxTokens = pick(opts.maxTokens, defaults.numPredict);
  const repeatPenalty = pick(opts.repeatPenalty, defaults.repeatPenalty);
  return {
    num_ctx: opts.contextLength ?? config.numCtx,
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { top_p: topP }),
    ...(topK !== undefined && { top_k: topK }),
    ...(repeatPenalty !== undefined && { repeat_penalty: repeatPenalty }),
    ...(opts.seed !== undefined && { seed: opts.seed }),
    ...(maxTokens !== undefined && { num_predict: maxTokens }),
    ...(opts.stop !== undefined && { stop: opts.stop }),
  };
}

/** Same rule as the Settings page: HTTPS, or a loopback address. */
function canSendToken(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === 'https:') return true;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

function freeze(config: OllamaConfig): OllamaConfig {
  return Object.freeze({ ...config, generation: Object.freeze({ ...config.generation }) });
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
