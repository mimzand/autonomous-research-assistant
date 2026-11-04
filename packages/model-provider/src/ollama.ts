import { toErrorMessage, type ModelHealth } from '@rka/shared';
import { z } from 'zod';
import { type OllamaConfig } from './config.js';
import { type ModelProvider } from './provider.js';

/** Response shapes we rely on. Everything from the server is validated. */
const VersionResponseSchema = z.object({ version: z.string() });
const TagsResponseSchema = z.object({
  models: z.array(z.object({ name: z.string() })),
});

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaProviderOptions {
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: FetchLike;
}

export function createOllamaProvider(
  config: OllamaConfig,
  options: OllamaProviderOptions = {},
): ModelProvider {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(config.requestTimeoutMs);
    const response = await doFetch(`${config.baseUrl}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new Error(`GET ${path} failed with HTTP ${response.status}`);
    }
    return schema.parse(await response.json());
  }

  return {
    id: 'ollama',
    model: config.model,

    async checkHealth(signal?: AbortSignal): Promise<ModelHealth> {
      const base = { provider: 'ollama', baseUrl: config.baseUrl, model: config.model } as const;
      try {
        const { version } = await getJson('/api/version', VersionResponseSchema, signal);
        const { models } = await getJson('/api/tags', TagsResponseSchema, signal);
        const installed = models.map((m) => m.name);
        const hasModel = installed.some((name) => matchesModel(name, config.model));
        return hasModel
          ? { ...base, status: 'ready', serverVersion: version }
          : {
              ...base,
              status: 'model-missing',
              serverVersion: version,
              installedModels: installed,
            };
      } catch (cause) {
        return { ...base, status: 'unreachable', error: describeRequestError(cause) };
      }
    },
  };
}

/** Node's fetch reports "fetch failed"; the useful detail (e.g. ECONNREFUSED) is in `cause`. */
export function describeRequestError(error: unknown): string {
  const message = toErrorMessage(error);
  if (error instanceof Error && error.cause !== undefined) {
    const { cause } = error;
    const code =
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : toErrorMessage(cause);
    return `${message} (${code})`;
  }
  return message;
}

/** "qwen3" matches "qwen3:latest"; otherwise names must match exactly. */
export function matchesModel(installedName: string, wanted: string): boolean {
  if (installedName === wanted) return true;
  return !wanted.includes(':') && installedName === `${wanted}:latest`;
}
