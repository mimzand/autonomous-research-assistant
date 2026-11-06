import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Writable } from 'node:stream';
import { checkAddress } from './ip-policy.js';
import { parsePublicUrl } from './url.js';

export type WebErrorCode =
  | 'blocked-url'
  | 'blocked-address'
  | 'dns-failed'
  | 'too-many-redirects'
  | 'invalid-redirect'
  | 'redirect-downgrade'
  | 'timeout'
  | 'cancelled'
  | 'too-large'
  | 'http-error'
  | 'network-error'
  | 'unsupported-content'
  | 'extraction-failed'
  /** The search service answered but none of its engines could reach the internet. */
  | 'engines-unreachable'
  /** The service is not configured (e.g. no SearXNG URL in Settings). */
  | 'not-configured';

export class WebError extends Error {
  override readonly name = 'WebError';
  constructor(
    readonly code: WebErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const isWebError = (error: unknown): error is WebError => error instanceof WebError;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

export interface SafeHttpClientOptions {
  readonly userAgent?: string;
  /** Default 5. */
  readonly maxRedirects?: number;
  /** Deadline for the whole request including redirects and body (default 20 s). */
  readonly timeoutMs?: number;
  /** Maximum response body size, compressed and decompressed (default 10 MB). */
  readonly maxBytes?: number;
  readonly resolve?: Resolver;
  /**
   * Origins the user configured explicitly (e.g. a self-hosted SearXNG on
   * http://127.0.0.1:8080). Only these may be private. Redirects away from
   * them are checked like any other URL.
   */
  readonly trustedOrigins?: readonly string[];
  /**
   * TEST ONLY. Where to open the TCP connection after the address passed
   * validation. Lets tests run a local server behind a "public" address.
   */
  readonly connectOverride?: (target: { address: string; port: number }) => {
    host: string;
    port: number;
  };
  /** TEST ONLY. Extra trusted CA certificates (PEM). */
  readonly ca?: string;
}

export interface GetOptions {
  readonly signal?: AbortSignal;
  readonly accept?: string;
  /** Overrides the client's limit for this request (never above it). */
  readonly maxBytes?: number;
}

export interface HttpResponse {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  /** Every URL that redirected, in order (excludes finalUrl). */
  readonly redirects: readonly string[];
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  readonly body: Buffer;
  /** IP address the final response came from (after validation). */
  readonly remoteAddress: string;
}

export interface SafeHttpClient {
  get(url: string, options?: GetOptions): Promise<HttpResponse>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; AutonomousResearchAssistant/0.1; local research tool)';

/**
 * HTTP(S) GET with SSRF protection:
 * - only http/https to public hosts (see parsePublicUrl)
 * - every DNS answer is validated and the connection is pinned to a validated
 *   IP, so DNS rebinding between check and connect is not possible
 * - redirects are followed manually and each hop is validated again;
 *   https -> http downgrades are refused
 * - deadline, size limits (also after decompression), no cookies, no pooling
 */
export function createSafeHttpClient(options: SafeHttpClientOptions = {}): SafeHttpClient {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const clientMaxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const resolve = options.resolve ?? systemResolver;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const trusted = new Set((options.trustedOrigins ?? []).map((o) => new URL(o).origin));

  function validateUrl(raw: string, base?: string): URL {
    let candidate: URL | undefined;
    try {
      candidate = new URL(raw, base);
    } catch {
      // Reported below.
    }
    if (candidate && trusted.has(candidate.origin) && !candidate.username && !candidate.password) {
      return candidate;
    }
    const parsed = parsePublicUrl(raw, base);
    if (!parsed.ok) throw new WebError('blocked-url', parsed.error.message);
    return parsed.value;
  }

  async function resolveTarget(url: URL): Promise<string> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly ResolvedAddress[];
    if (isIP(hostname)) {
      addresses = [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await resolve(hostname);
      } catch (error) {
        throw new WebError('dns-failed', `Could not resolve ${hostname}: ${message(error)}`);
      }
    }
    if (addresses.length === 0) throw new WebError('dns-failed', `${hostname} has no addresses.`);
    if (!trusted.has(url.origin)) {
      // Refuse if ANY answer is internal: an attacker controls which one is used.
      for (const { address } of addresses) {
        const verdict = checkAddress(address);
        if (!verdict.allowed) {
          throw new WebError(
            'blocked-address',
            `${hostname} resolves to a blocked address (${verdict.reason}).`,
          );
        }
      }
    }
    const first = addresses[0];
    if (!first) throw new WebError('dns-failed', `${hostname} has no addresses.`);
    return first.address;
  }

  function send(
    url: URL,
    address: string,
    accept: string,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    const https = url.protocol === 'https:';
    const port = Number(url.port || (https ? 443 : 80));
    const target = options.connectOverride?.({ address, port }) ?? { host: address, port };
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return new Promise((resolvePromise, reject) => {
      const req = (https ? httpsRequest : httpRequest)(
        {
          host: target.host,
          port: target.port,
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          headers: {
            host: url.host,
            'user-agent': userAgent,
            accept,
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en;q=0.9, *;q=0.5',
          },
          agent: false, // No pooled connections: each request connects to its validated IP.
          signal,
          // TLS: SNI and certificate verification use the original host name.
          ...(https && {
            servername: isIP(hostname) ? undefined : hostname,
            rejectUnauthorized: true,
            ...(options.ca !== undefined && { ca: options.ca }),
          }),
        },
        resolvePromise,
      );
      req.on('error', reject);
      req.end();
    });
  }

  async function readBody(res: IncomingMessage, limit: number): Promise<Buffer> {
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      res.destroy();
      throw new WebError('too-large', `Response is ${declared} bytes (limit ${limit}).`);
    }
    const encoding = (res.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
    const decoder =
      encoding === 'gzip' || encoding === 'x-gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : encoding === 'identity' || encoding === ''
              ? undefined
              : null;
    if (decoder === null) {
      res.destroy();
      throw new WebError('unsupported-content', `Unsupported content encoding "${encoding}".`);
    }

    let raw = 0;
    res.on('data', (chunk: Buffer) => {
      raw += chunk.length;
      if (raw > limit) res.destroy(new WebError('too-large', `Response exceeds ${limit} bytes.`));
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > limit) {
          // Also stops decompression bombs: inflation is aborted at the limit.
          done(new WebError('too-large', `Decoded response exceeds ${limit} bytes.`));
          return;
        }
        chunks.push(chunk);
        done();
      },
    });
    await (decoder ? pipeline(res, decoder, sink) : pipeline(res, sink));
    return Buffer.concat(chunks, size);
  }

  return {
    async get(rawUrl, getOptions = {}) {
      const limit = Math.min(getOptions.maxBytes ?? clientMaxBytes, clientMaxBytes);
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = getOptions.signal ? AbortSignal.any([getOptions.signal, deadline]) : deadline;
      const accept = getOptions.accept ?? '*/*';
      const redirects: string[] = [];

      const fail = (error: unknown): never => {
        if (getOptions.signal?.aborted) throw new WebError('cancelled', 'Request was cancelled.');
        if (deadline.aborted) {
          throw new WebError('timeout', `Request timed out after ${timeoutMs} ms.`);
        }
        if (isWebError(error)) throw error;
        if (isWebError((error as { cause?: unknown } | null)?.cause)) {
          throw (error as { cause: WebError }).cause;
        }
        throw new WebError('network-error', message(error));
      };

      try {
        let url = validateUrl(rawUrl);
        const requestedUrl = url.href;
        for (;;) {
          signal.throwIfAborted();
          const address = await resolveTarget(url);
          signal.throwIfAborted();
          const res = await send(url, address, accept, signal);
          const status = res.statusCode ?? 0;

          if (REDIRECT_STATUSES.has(status)) {
            res.resume(); // Discard the redirect body.
            const location = res.headers.location;
            if (!location) {
              throw new WebError('invalid-redirect', `HTTP ${status} without a Location header.`);
            }
            if (redirects.length >= maxRedirects) {
              throw new WebError('too-many-redirects', `More than ${maxRedirects} redirects.`);
            }
            let next: URL;
            try {
              next = validateUrl(location, url.href);
            } catch (error) {
              throw new WebError(
                isWebError(error) ? error.code : 'invalid-redirect',
                `Redirect refused: ${message(error)}`,
              );
            }
            if (url.protocol === 'https:' && next.protocol === 'http:') {
              throw new WebError(
                'redirect-downgrade',
                'Refused a redirect from https to http (insecure downgrade).',
              );
            }
            redirects.push(url.href);
            url = next;
            continue;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            throw new WebError('http-error', `HTTP ${status} from ${url.host}.`, status);
          }
          const body = await readBody(res, limit);
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
          }
          return {
            requestedUrl,
            finalUrl: url.href,
            redirects,
            status,
            headers,
            contentType: headers['content-type'] ?? null,
            body,
            remoteAddress: address,
          };
        }
      } catch (error) {
        return fail(error);
      }
    },
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
