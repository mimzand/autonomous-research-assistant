import { z } from 'zod';
import { type ToolDefinition } from '../tool.js';
import { createWebFetcher, type WebFetcher } from './fetcher.js';
import { createSafeHttpClient, WebError } from './http-client.js';
import { createSearxngProvider, type WebSearchProvider } from './search.js';
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
  /** Characters of extracted text kept per document. */
  maxTextChars: z.int().min(10_000).max(5_000_000).default(1_000_000),
  /** PDF pages read per document. */
  maxPdfPages: z.int().min(1).max(2000).default(300),
});
export type WebConfig = z.output<typeof WebConfigSchema>;

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

export interface WebServices {
  readonly fetcher: WebFetcher;
  /** Undefined when SEARXNG_URL is not set. */
  readonly searchProvider?: WebSearchProvider;
}

/**
 * Builds the fetcher and search provider. They use SEPARATE HTTP clients:
 * only the search client may reach the (usually local) SearXNG instance, so
 * the fetcher can never be pointed at it or at any other private address.
 */
export function createWebServices(config: WebConfig): WebServices {
  const fetchClient = createSafeHttpClient({
    timeoutMs: config.fetchTimeoutMs,
    maxBytes: config.maxDownloadBytes,
  });
  const searchProvider = config.searxngUrl
    ? createSearxngClient(config.searxngUrl, config)
    : undefined;
  const fetcher = createWebFetcher(fetchClient, {
    maxTextChars: config.maxTextChars,
    maxPdfPages: config.maxPdfPages,
  });
  return { fetcher, ...(searchProvider && { searchProvider }) };
}

/**
 * A SearXNG provider for `baseUrl`. Its HTTP client trusts only that origin,
 * so it is also safe for testing a candidate URL before it is saved.
 */
export function createSearxngClient(
  baseUrl: string,
  config: Pick<WebConfig, 'safeSearch' | 'searchTimeoutMs'>,
): WebSearchProvider {
  return createSearxngProvider(
    { baseUrl, safeSearch: config.safeSearch },
    createSafeHttpClient({
      timeoutMs: config.searchTimeoutMs,
      maxBytes: 2 * 1024 * 1024,
      trustedOrigins: [baseUrl],
    }),
  );
}

/** Web services whose configuration can be replaced while the app runs. */
export interface ReconfigurableWebServices extends WebServices {
  /** Delegates to the current fetcher. */
  readonly fetcher: WebFetcher;
  /**
   * Delegates to the current search provider. Always present (so the
   * web_search tool is always registered); throws `not-configured` while no
   * SearXNG URL is set.
   */
  readonly searchProvider: WebSearchProvider;
  /** The configuration new calls use. */
  config(): WebConfig;
  isSearchConfigured(): boolean;
  /** Validates and applies a new configuration to subsequent calls. Throws when invalid. */
  update(config: WebConfig): void;
}

/**
 * Builds web services that read their configuration per call. A call that is
 * already running finishes with the settings it started with. The fetcher and
 * the search provider still use separate HTTP clients (see createWebServices).
 */
export function createReconfigurableWebServices(initial: WebConfig): ReconfigurableWebServices {
  let config = WebConfigSchema.parse(initial);
  let current = createWebServices(config);

  const notConfigured = () =>
    new WebError(
      'not-configured',
      'Web search is not configured. Set the SearXNG URL in Settings → Research & Web Search.',
    );

  const searchProvider: WebSearchProvider = {
    id: 'searxng',
    search(query, options) {
      const provider = current.searchProvider;
      return provider ? provider.search(query, options) : Promise.reject(notConfigured());
    },
    checkHealth(options) {
      const provider = current.searchProvider;
      return provider ? provider.checkHealth(options) : Promise.reject(notConfigured());
    },
  };

  return {
    fetcher: { fetch: (url, options) => current.fetcher.fetch(url, options) },
    searchProvider,
    config: () => config,
    isSearchConfigured: () => Boolean(current.searchProvider),
    update(next) {
      const parsed = WebConfigSchema.parse(next);
      const services = createWebServices(parsed);
      config = parsed;
      current = services;
    },
  };
}

/** Builds the web tools from configuration (see createWebServices). */
export function createWebToolsFromConfig(
  config: WebConfig,
  store: SourceStore,
  services: WebServices = createWebServices(config),
): ToolDefinition[] {
  return createWebTools({ ...services, store });
}
