import { z } from 'zod';

export const OLLAMA_DEFAULT_PORT = 11434;

/**
 * Default address. Uses 127.0.0.1, not "localhost": on Windows "localhost"
 * can resolve to IPv6 ::1, where Ollama does not listen by default.
 */
export const OLLAMA_DEFAULT_BASE_URL = `http://127.0.0.1:${OLLAMA_DEFAULT_PORT}`;
export const OLLAMA_DEFAULT_MODEL = 'qwen3:8b';
export const OLLAMA_DEFAULT_NUM_CTX = 4096;
export const OLLAMA_DEFAULT_TIMEOUT_MS = 5000;

const WILDCARD_HOSTS = new Set(['0.0.0.0', '[::]', '::']);

/**
 * Turns an OLLAMA_HOST-style value into a base URL.
 * Accepts "host", "host:port" or "scheme://host[:port]". A wildcard bind
 * address (0.0.0.0) is a listen address, so it is probed via 127.0.0.1.
 * Invalid or empty input falls back to the default.
 */
export function resolveOllamaBaseUrl(hostValue: string | undefined): string {
  const raw = hostValue?.trim().replace(/\/+$/, '');
  if (!raw) return OLLAMA_DEFAULT_BASE_URL;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return OLLAMA_DEFAULT_BASE_URL;

  const host = WILDCARD_HOSTS.has(url.hostname) ? '127.0.0.1' : url.hostname;
  // URL drops default ports (80/443), so only an explicit port is kept as-is.
  const explicitPort = /:\d+$/.test(raw);
  const port = explicitPort
    ? url.port || defaultPortFor(url.protocol)
    : String(OLLAMA_DEFAULT_PORT);

  return `${url.protocol}//${host}:${port}`;
}

function defaultPortFor(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

export const OllamaConfigSchema = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().trim().min(1),
  numCtx: z.int().min(512).max(262_144),
  requestTimeoutMs: z.int().min(100).max(600_000),
});
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;

/** Environment variables this package reads. */
export interface OllamaEnv {
  readonly OLLAMA_HOST?: string | undefined;
  readonly OLLAMA_MODEL?: string | undefined;
  readonly OLLAMA_NUM_CTX?: string | undefined;
  readonly OLLAMA_REQUEST_TIMEOUT_MS?: string | undefined;
}

/** Builds and validates the Ollama config from environment variables. Throws on invalid values. */
export function loadOllamaConfig(env: OllamaEnv): OllamaConfig {
  return OllamaConfigSchema.parse({
    baseUrl: resolveOllamaBaseUrl(env.OLLAMA_HOST),
    model: env.OLLAMA_MODEL?.trim() || OLLAMA_DEFAULT_MODEL,
    numCtx: parseIntOr(env.OLLAMA_NUM_CTX, OLLAMA_DEFAULT_NUM_CTX),
    requestTimeoutMs: parseIntOr(env.OLLAMA_REQUEST_TIMEOUT_MS, OLLAMA_DEFAULT_TIMEOUT_MS),
  });
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  return Number(value);
}
