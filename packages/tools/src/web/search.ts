import { z } from 'zod';
import { type SafeHttpClient, WebError } from './http-client.js';
import { canonicalizeUrl, parsePublicUrl } from './url.js';

export interface SearchQuery {
  readonly query: string;
  /** Maximum results to return (provider may return fewer). */
  readonly limit: number;
  /** BCP 47 language, e.g. "en" or "de-DE". */
  readonly language?: string;
  readonly timeRange?: 'day' | 'week' | 'month' | 'year';
}

export interface SearchResult {
  readonly title: string;
  /** Canonical http(s) URL that passed the fetch policy. */
  readonly url: string;
  /** Short excerpt from the search engine. Untrusted text. */
  readonly snippet: string;
  readonly engines: readonly string[];
  readonly publishedAt: string | null;
}

export interface SearchProviderHealth {
  readonly provider: string;
  /** Where the provider is reached (origin only, no credentials or query). */
  readonly endpoint: string;
  readonly latencyMs: number;
}

/** A web search backend. Implementations must return only fetchable public URLs. */
export interface WebSearchProvider {
  readonly id: string;
  search(query: SearchQuery, options?: { signal?: AbortSignal }): Promise<SearchResult[]>;
  /** Checks that the backend answers. Throws a WebError when it does not. */
  checkHealth(options?: { signal?: AbortSignal }): Promise<SearchProviderHealth>;
}

export interface SearxngConfig {
  /** e.g. http://127.0.0.1:8080 - user-configured, may be a private address. */
  readonly baseUrl: string;
  /** "0" off, "1" moderate (default), "2" strict. */
  readonly safeSearch?: 0 | 1 | 2;
}

const SearxngResponseSchema = z.object({
  /** [[engine, reason], ...] - engines that failed for this query. */
  unresponsive_engines: z.array(z.array(z.unknown())).optional().default([]),
  results: z
    .array(
      z.looseObject({
        url: z.string(),
        title: z.string().optional().default(''),
        content: z.string().optional().nullable(),
        engines: z.array(z.string()).optional().default([]),
        engine: z.string().optional(),
        publishedDate: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const clip = (text: string | null | undefined, max: number) =>
  (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * SearXNG (https://docs.searxng.org) - a self-hosted, open-source metasearch
 * engine. No API key. The instance must allow the JSON format
 * (`search.formats: [html, json]` in settings.yml).
 */
export function createSearxngProvider(
  config: SearxngConfig,
  http: SafeHttpClient,
): WebSearchProvider {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('SearXNG URL must use http or https.');
  }
  const endpoint = new URL('search', base.href.endsWith('/') ? base.href : `${base.href}/`);

  const healthz = new URL('healthz', endpoint);
  const configUrl = new URL('config', endpoint);

  return {
    id: 'searxng',
    async checkHealth(options = {}) {
      const started = performance.now();
      const get = (url: URL) =>
        http.get(url.href, {
          maxBytes: 256 * 1024,
          ...(options.signal && { signal: options.signal }),
        });
      try {
        await get(healthz);
      } catch (error) {
        // Older instances have no /healthz; /config answers on every version.
        if (!(error instanceof WebError && error.code === 'http-error' && error.status === 404)) {
          if (error instanceof WebError && error.code === 'network-error') {
            throw new WebError(
              'network-error',
              `SearXNG at ${base.origin} is not reachable: ${error.message}`,
            );
          }
          throw error;
        }
        await get(configUrl);
      }
      return {
        provider: 'searxng',
        endpoint: base.origin,
        latencyMs: Math.round(performance.now() - started),
      };
    },

    async search(query, options = {}) {
      const url = new URL(endpoint);
      url.searchParams.set('q', query.query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', String(config.safeSearch ?? 1));
      if (query.language) url.searchParams.set('language', query.language);
      if (query.timeRange) url.searchParams.set('time_range', query.timeRange);

      let body: Buffer;
      try {
        ({ body } = await http.get(url.href, {
          accept: 'application/json',
          maxBytes: 2 * 1024 * 1024,
          ...(options.signal && { signal: options.signal }),
        }));
      } catch (error) {
        if (error instanceof WebError && error.code === 'http-error' && error.status === 403) {
          throw new WebError(
            'http-error',
            'SearXNG refused JSON output. Enable it in settings.yml: search.formats: [html, json].',
            403,
          );
        }
        if (error instanceof WebError && error.code === 'network-error') {
          throw new WebError(
            'network-error',
            `SearXNG at ${base.origin} is not reachable: ${error.message}`,
          );
        }
        throw error;
      }

      let parsed: z.infer<typeof SearxngResponseSchema>;
      try {
        parsed = SearxngResponseSchema.parse(JSON.parse(body.toString('utf8')));
      } catch {
        throw new WebError('extraction-failed', 'SearXNG returned an unexpected response.');
      }

      if (parsed.results.length === 0 && parsed.unresponsive_engines.length > 0) {
        // SearXNG itself is up, but every engine failed: usually no internet connection.
        const engines = parsed.unresponsive_engines
          .slice(0, 5)
          .map((e) => e.map(String).join(': '))
          .join(', ');
        throw new WebError(
          'engines-unreachable',
          `SearXNG answered, but its search engines could not be reached (${engines}). The internet connection may be down.`,
        );
      }

      const seen = new Set<string>();
      const results: SearchResult[] = [];
      for (const item of parsed.results) {
        // Search results are untrusted: only keep URLs we would be allowed to fetch.
        const checked = parsePublicUrl(item.url);
        if (!checked.ok) continue;
        const canonical = canonicalizeUrl(checked.value);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const published = item.publishedDate ? Date.parse(item.publishedDate) : NaN;
        results.push({
          title: clip(item.title, 300) || checked.value.hostname,
          url: canonical,
          snippet: clip(item.content, 500),
          engines: (item.engines.length ? item.engines : item.engine ? [item.engine] : []).slice(
            0,
            10,
          ),
          publishedAt: Number.isNaN(published) ? null : new Date(published).toISOString(),
        });
        if (results.length >= query.limit) break;
      }
      return results;
    },
  };
}
