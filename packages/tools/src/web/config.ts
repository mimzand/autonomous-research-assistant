import { z } from 'zod';
import { type ToolDefinition } from '../tool.js';
import { createWebFetcher } from './fetcher.js';
import { createSafeHttpClient } from './http-client.js';
import { createSearxngProvider } from './search.js';
import { type SourceStore } from './sources.js';
import { createWebTools } from './tools.js';

export const WebConfigSchema = z.object({
  /** SearXNG base URL. Unset: web search is not available. */
  searxngUrl: z.url({ protocol: /^https?$/ }).nullable(),
  safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  fetchTimeoutMs: z.int().min(1000).max(120_000),
  searchTimeoutMs: z.int().min(1000).max(120_000),
  maxDownloadBytes: z
    .int()
    .min(64 * 1024)
    .max(50 * 1024 * 1024),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

export interface WebEnv {
  readonly SEARXNG_URL?: string | undefined;
  readonly SEARXNG_SAFESEARCH?: string | undefined;
  readonly WEB_FETCH_TIMEOUT_MS?: string | undefined;
  readonly WEB_SEARCH_TIMEOUT_MS?: string | undefined;
  readonly WEB_MAX_DOWNLOAD_BYTES?: string | undefined;
}

const intOr = (value: string | undefined, fallback: number) =>
  value === undefined || value.trim() === '' ? fallback : Number(value);

/** Reads and validates web settings. Throws on invalid values. No API keys are involved. */
export function loadWebConfig(env: WebEnv): WebConfig {
  return WebConfigSchema.parse({
    searxngUrl: env.SEARXNG_URL?.trim() || null,
    safeSearch: intOr(env.SEARXNG_SAFESEARCH, 1),
    fetchTimeoutMs: intOr(env.WEB_FETCH_TIMEOUT_MS, 20_000),
    searchTimeoutMs: intOr(env.WEB_SEARCH_TIMEOUT_MS, 15_000),
    maxDownloadBytes: intOr(env.WEB_MAX_DOWNLOAD_BYTES, 15 * 1024 * 1024),
  });
}

/**
 * Builds the web tools. Search and page fetching use SEPARATE HTTP clients:
 * only the search client may reach the (usually local) SearXNG instance, so
 * fetch_source can never be pointed at it or at any other private address.
 */
export function createWebToolsFromConfig(config: WebConfig, store: SourceStore): ToolDefinition[] {
  const fetchClient = createSafeHttpClient({
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.maxDownloadBytes,
  });
  const searchProvider = config.searxngUrl
    ? createSearxngProvider(
        { baseUrl: config.searxngUrl, safeSearch: config.safeSearch },
        createSafeHttpClient({
          timeoutMs: config.searchTimeoutMs,
          maxBytes: 2 * 1024 * 1024,
          trustedOrigins: [config.searxngUrl],
        }),
      )
    : undefined;
  return createWebTools({
    fetcher: createWebFetcher(fetchClient),
    store,
    ...(searchProvider && { searchProvider }),
  });
}
