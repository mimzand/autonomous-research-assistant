import { type ResearchLimits, type TaskModelConfig } from '@rka/agent-runtime';
import {
  isModelProviderError,
  matchesModel,
  OllamaConfigSchema,
  type OllamaConfig,
  type OllamaProvider,
} from '@rka/model-provider';
import {
  canSendCredentials,
  connectionAdvice,
  ConnectionTestResultSchema,
  EffectiveModelConfigSchema,
  ModelTestResultSchema,
  normalizeServerUrl,
  OllamaConnectionStateSchema,
  OllamaModelDetailsSchema,
  OllamaModelListSchema,
  redactText,
  serverUrlProblem,
  violatesHttpsPolicy,
  type ConnectionTestResult,
  type EffectiveModelConfig,
  type ModelTestResult,
  type OllamaConnectionState,
  type OllamaModelDetails,
  type OllamaModelList,
  type SettingKey,
  type SettingsValues,
} from '@rka/shared';
import { createSearxngClient, isWebError, type WebConfig } from '@rka/tools';
import { type ConfigApplier, type RuntimeConfig } from './runtime-config.js';

// --- Mapping settings to the existing service configurations -----------------------

export const OLLAMA_KEYS: readonly SettingKey[] = [
  'ollama.baseUrl',
  'ollama.requestTimeoutMs',
  'ollama.streamIdleTimeoutMs',
  'model.name',
  'model.temperature',
  'model.topP',
  'model.topK',
  'model.numCtx',
  'model.numPredict',
  'model.repeatPenalty',
  'model.generateTimeoutMs',
];

export const WEB_KEYS: readonly SettingKey[] = [
  'searxng.url',
  'searxng.safeSearch',
  'web.searchTimeoutMs',
  'web.fetchTimeoutMs',
  'web.maxDownloadBytes',
  'web.maxTextChars',
  'web.maxPdfPages',
];

export function toOllamaConfig(v: SettingsValues): OllamaConfig {
  const optional = <T>(value: T | null) => (value === null ? undefined : value);
  return OllamaConfigSchema.parse({
    baseUrl: v['ollama.baseUrl'],
    model: v['model.name'],
    numCtx: v['model.numCtx'],
    requestTimeoutMs: v['ollama.requestTimeoutMs'],
    generateTimeoutMs: v['model.generateTimeoutMs'],
    streamIdleTimeoutMs: v['ollama.streamIdleTimeoutMs'],
    generation: Object.fromEntries(
      Object.entries({
        temperature: optional(v['model.temperature']),
        topP: optional(v['model.topP']),
        topK: optional(v['model.topK']),
        numPredict: optional(v['model.numPredict']),
        repeatPenalty: optional(v['model.repeatPenalty']),
      }).filter(([, value]) => value !== undefined),
    ),
  });
}

export function toWebConfig(v: SettingsValues): WebConfig {
  return {
    searxngUrl: v['searxng.url'],
    safeSearch: v['searxng.safeSearch'],
    fetchTimeoutMs: v['web.fetchTimeoutMs'],
    searchTimeoutMs: v['web.searchTimeoutMs'],
    maxDownloadBytes: v['web.maxDownloadBytes'],
    maxTextChars: v['web.maxTextChars'],
    maxPdfPages: v['web.maxPdfPages'],
  };
}

export function toResearchDefaults(v: SettingsValues): Partial<ResearchLimits> {
  return {
    maxQuestions: v['research.maxQuestions'],
    maxSources: v['research.maxSources'],
    resultsPerQuery: v['research.resultsPerQuery'],
    modelRetries: v['research.modelRetries'],
    toolRetries: v['research.toolRetries'],
    retryBackoffMs: v['research.retryBackoffMs'],
    modelTimeoutMs: v['research.modelTimeoutMs'],
  };
}

export function ollamaApplier(provider: OllamaProvider): ConfigApplier {
  return {
    name: 'Ollama provider',
    keys: OLLAMA_KEYS,
    apply: (next) => provider.reconfigure(toOllamaConfig(next)),
  };
}

export function webApplier(services: { update(config: WebConfig): void }): ConfigApplier {
  return {
    name: 'web services',
    keys: WEB_KEYS,
    apply: (next) => services.update(toWebConfig(next)),
  };
}

/** Task isolation: research tasks capture the Ollama configuration when they start. */
export function taskModelsFor(provider: OllamaProvider) {
  return {
    capture: (): TaskModelConfig => {
      const config = provider.currentConfig;
      return {
        provider: 'ollama',
        name: config.model,
        url: config.baseUrl,
        config: JSON.parse(JSON.stringify(config)) as TaskModelConfig['config'],
      };
    },
    providerFor: (captured: TaskModelConfig) => {
      const parsed = OllamaConfigSchema.safeParse(captured.config);
      // A stored configuration that is no longer valid falls back to the current one.
      return provider.snapshot(parsed.success ? parsed.data : provider.currentConfig);
    },
  };
}

// --- Errors ---------------------------------------------------------------------------

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function errorCode(error: unknown): string {
  if (isModelProviderError(error)) {
    if (error.status && error.status >= 300 && error.status < 400) return 'redirect';
    if (error.status === 401 || error.status === 403) return 'unauthorized';
    return error.code;
  }
  if (isWebError(error)) return error.code;
  return 'failed';
}

/** A short, actionable hint for a failed Ollama connection. */
export function ollamaHint(code: string, url: string): string | null {
  const remote = (() => {
    try {
      return connectionAdvice(url).location !== 'loopback';
    } catch {
      return false;
    }
  })();
  switch (code) {
    case 'unavailable':
      return remote
        ? 'Check that the server is on and reachable. Ollama listens only on 127.0.0.1 by default: on the server set OLLAMA_HOST=0.0.0.0 (or its LAN address), restart Ollama, and allow port 11434 in its firewall. Prefer a VPN or an HTTPS reverse proxy.'
        : 'Start Ollama (it runs in the system tray) and check the port (default 11434).';
    case 'timeout':
      return 'The server did not answer in time. Check the address and the network, or raise the connection timeout.';
    case 'invalid-response':
      return 'Something answered, but it is not an Ollama server. Check the address and port.';
    case 'redirect':
      return 'Enter the final address (for example with https://) instead of one that redirects.';
    case 'unauthorized':
      return 'The server or its reverse proxy requires an access token. Set it under "Access token" (HTTPS only).';
    case 'invalid-url':
      return 'Use a full URL such as http://127.0.0.1:11434 or https://ollama.example.com.';
    case 'policy':
      return 'Use https://, or turn off "Require HTTPS for remote servers" in Settings → Security.';
    default:
      return null;
  }
}

// --- Ollama settings service ------------------------------------------------------------

export interface OllamaSettingsDeps {
  readonly config: RuntimeConfig;
  readonly provider: OllamaProvider;
  /** Session-only connection switch shared with the provider (`isConnected`). */
  readonly connection: { get(): boolean; set(connected: boolean): void };
  readonly now?: () => Date;
  /** Records model usage of test prompts. */
  readonly recordUsage?: (usage: {
    model: string;
    promptTokens: number | null;
    completionTokens: number | null;
    totalDurationMs: number | null;
    loadDurationMs: number | null;
  }) => void;
}

/** Research steps set these for reliable JSON, overriding the defaults (shown in Settings). */
export const RESEARCH_OVERRIDES = {
  temperature: 0,
  num_predict: '900–2000 depending on the step',
} as const;

export function createOllamaSettingsService(deps: OllamaSettingsDeps) {
  const now = deps.now ?? (() => new Date());
  let modelDefaults: { model: string; parameters: string | null } | null = null;

  /** Normalises and checks a candidate URL; returns an error result instead of throwing. */
  function candidate(raw: string | undefined): { url: string } | { error: ConnectionTestResult } {
    const settings = deps.config.getSettings();
    const url =
      raw === undefined || raw.trim() === '' ? settings['ollama.baseUrl'] : normalizeServerUrl(raw);
    const fail = (code: string, error: string): { error: ConnectionTestResult } => ({
      error: ConnectionTestResultSchema.parse({
        ok: false,
        url,
        code,
        error,
        hint: ollamaHint(code, url),
        latencyMs: null,
        warnings: [],
        checkedAt: now().toISOString(),
      }),
    });
    const problem = serverUrlProblem(url);
    if (problem) return fail('invalid-url', `Invalid URL: ${problem}`);
    if (violatesHttpsPolicy(url, settings['security.requireHttpsForRemote'])) {
      return fail(
        'policy',
        'Plain HTTP to another computer is not allowed by your security settings.',
      );
    }
    return { url };
  }

  function warningsFor(url: string): string[] {
    const warnings = [...connectionAdvice(url).warnings];
    if (deps.config.getSecret('ollama.authToken') && !canSendCredentials(url)) {
      warnings.push(
        'The access token is not sent over plain HTTP to another computer. Use https:// to use it.',
      );
    }
    return warnings;
  }

  function state(): OllamaConnectionState {
    const url = deps.config.getSetting('ollama.baseUrl');
    const tokenConfigured = Boolean(deps.config.getSecret('ollama.authToken'));
    return OllamaConnectionStateSchema.parse({
      connected: deps.connection.get(),
      url,
      tokenConfigured,
      tokenSent: tokenConfigured && canSendCredentials(url),
      warnings: warningsFor(url),
    });
  }

  return {
    /** Tests a server without saving anything. Never throws. */
    async testConnection(rawUrl?: string): Promise<ConnectionTestResult> {
      const target = candidate(rawUrl);
      if ('error' in target) return target.error;
      const probe = deps.provider.snapshot({ ...deps.provider.currentConfig, baseUrl: target.url });
      const started = performance.now();
      try {
        const info = await probe.testConnection();
        return ConnectionTestResultSchema.parse({
          ok: true,
          url: target.url,
          version: info.version,
          latencyMs: info.latencyMs,
          warnings: warningsFor(target.url),
          checkedAt: now().toISOString(),
        });
      } catch (error) {
        const code = errorCode(error);
        return ConnectionTestResultSchema.parse({
          ok: false,
          url: target.url,
          code,
          error: redactText(message(error)).slice(0, 1000),
          hint: ollamaHint(code, target.url),
          latencyMs: Math.round(performance.now() - started),
          warnings: warningsFor(target.url),
          checkedAt: now().toISOString(),
        });
      }
    },

    connectionState: state,

    connect(): OllamaConnectionState {
      deps.connection.set(true);
      return state();
    },

    /** Stops new requests to Ollama until Connect. Running tasks wait as "Waiting for Ollama". */
    disconnect(): OllamaConnectionState {
      deps.connection.set(false);
      return state();
    },

    async listModels(): Promise<OllamaModelList> {
      const { url, activeModel } = {
        url: deps.config.getSetting('ollama.baseUrl'),
        activeModel: deps.config.getSetting('model.name'),
      };
      try {
        const models = await deps.provider.listModels();
        return OllamaModelListSchema.parse({
          status: 'ok',
          url,
          models,
          activeModel,
          activeModelAvailable: models.some((m) => matchesModel(m.name, activeModel)),
          fetchedAt: now().toISOString(),
        });
      } catch (error) {
        return OllamaModelListSchema.parse({
          status: 'error',
          url,
          code: errorCode(error),
          error: redactText(message(error)).slice(0, 1000),
          activeModel,
        });
      }
    },

    async showModel(name: string): Promise<OllamaModelDetails> {
      try {
        const details = await deps.provider.showModel(name);
        modelDefaults = { model: name, parameters: details.parameters };
        return OllamaModelDetailsSchema.parse({ status: 'ok', ...details });
      } catch (error) {
        return OllamaModelDetailsSchema.parse({
          status: 'error',
          name,
          code: errorCode(error),
          error: redactText(message(error)).slice(0, 1000),
        });
      }
    },

    /** Sends one short prompt to a model with the current generation settings. */
    async testModel(name: string, prompt: string): Promise<ModelTestResult> {
      const config = deps.provider.currentConfig;
      const maxTokens = Math.min(config.generation.numPredict ?? 256, 256);
      const options = { ...deps.provider.effectiveOptions(), num_predict: maxTokens };
      const started = performance.now();
      try {
        const result = await deps.provider.generate(
          {
            model: name,
            messages: [{ role: 'user', content: prompt }],
            think: false,
            options: { maxTokens },
          },
          { timeoutMs: config.generateTimeoutMs },
        );
        deps.recordUsage?.({ model: result.model, ...result.usage });
        const reply = result.content.trim();
        return ModelTestResultSchema.parse({
          status: 'ok',
          model: result.model,
          reply: reply.slice(0, 2000),
          truncated: reply.length > 2000 || result.finishReason === 'length',
          durationMs: Math.round(performance.now() - started),
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          options,
        });
      } catch (error) {
        return ModelTestResultSchema.parse({
          status: 'error',
          model: name,
          code: errorCode(error),
          error: redactText(message(error)).slice(0, 1000),
        });
      }
    },

    effectiveConfig(): EffectiveModelConfig {
      const config = deps.provider.currentConfig;
      return EffectiveModelConfigSchema.parse({
        url: config.baseUrl,
        model: config.model,
        options: deps.provider.effectiveOptions(config),
        generateTimeoutMs: config.generateTimeoutMs,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
        researchOverrides: RESEARCH_OVERRIDES,
        modelDefaults:
          modelDefaults && matchesModel(modelDefaults.model, config.model)
            ? modelDefaults.parameters
            : null,
      });
    },
  };
}

export type OllamaSettingsService = ReturnType<typeof createOllamaSettingsService>;

// --- SearXNG ------------------------------------------------------------------------------

/** Tests a SearXNG URL (the saved one when omitted) without saving it. Never throws. */
export async function testSearxng(
  config: RuntimeConfig,
  rawUrl: string | undefined,
  now: () => Date = () => new Date(),
): Promise<ConnectionTestResult> {
  const settings = config.getSettings();
  const url =
    rawUrl === undefined || rawUrl.trim() === ''
      ? settings['searxng.url']
      : normalizeServerUrl(rawUrl, 8080);
  const base = { url: url ?? '', checkedAt: now().toISOString() };
  const fail = (
    code: string,
    error: string,
    hint: string | null,
    latencyMs: number | null = null,
  ) =>
    ConnectionTestResultSchema.parse({
      ok: false,
      ...base,
      code,
      error,
      hint,
      latencyMs,
      warnings: [],
    });
  if (!url) {
    return fail(
      'not-configured',
      'No SearXNG URL is set.',
      'Enter the URL of your SearXNG instance, e.g. http://127.0.0.1:8080.',
    );
  }
  const problem = serverUrlProblem(url);
  if (problem) return fail('invalid-url', `Invalid URL: ${problem}`, null);
  if (violatesHttpsPolicy(url, settings['security.requireHttpsForRemote'])) {
    return fail(
      'policy',
      'Plain HTTP to another computer is not allowed by your security settings.',
      null,
    );
  }
  try {
    const health = await createSearxngClient(url, {
      safeSearch: settings['searxng.safeSearch'],
      searchTimeoutMs: settings['web.searchTimeoutMs'],
    }).checkHealth({ signal: AbortSignal.timeout(settings['web.searchTimeoutMs']) });
    return ConnectionTestResultSchema.parse({
      ok: true,
      ...base,
      version: null,
      latencyMs: health.latencyMs,
      warnings: connectionAdvice(url).warnings,
    });
  } catch (error) {
    const code = errorCode(error);
    const hint =
      code === 'http-error' && /403/.test(message(error))
        ? 'Enable JSON output in SearXNG settings.yml: search: formats: [html, json].'
        : code === 'network-error'
          ? 'Start SearXNG (e.g. docker start searxng) and check the address and port.'
          : null;
    return fail(code, redactText(message(error)).slice(0, 1000), hint);
  }
}
