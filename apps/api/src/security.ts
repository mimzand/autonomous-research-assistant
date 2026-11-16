import { createHash, timingSafeEqual } from 'node:crypto';
import { type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { ApiError } from './errors.js';
import { API_KEY_HEADER } from './openapi.js';

/** Paths anyone may read: liveness, the OpenAPI document and Swagger UI. */
export const isPublicPath = (path: string) =>
  path === '/health' || path === '/openapi.json' || path === '/docs' || path.startsWith('/docs/');

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** `X-API-Key: <key>` or `Authorization: Bearer <key>`, compared in constant time. */
export function apiKeyAuth(apiKey: string): MiddlewareHandler {
  const expected = digest(apiKey);
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || isPublicPath(c.req.path)) return next();
    const header = c.req.header(API_KEY_HEADER);
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const given = header ?? bearer;
    if (!given || !timingSafeEqual(digest(given.trim()), expected)) {
      throw new ApiError(
        401,
        'unauthorized',
        `Missing or wrong API key (${API_KEY_HEADER} header).`,
      );
    }
    return next();
  };
}

/** Browsers may call the API only from these exact origins; none by default. */
export function corsAllowlist(origins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', API_KEY_HEADER, 'Authorization'],
    exposeHeaders: ['Content-Disposition', 'Retry-After'],
    maxAge: 600,
  });
}

export interface RateLimiter {
  /** Counts one request for `key`; returns the seconds to wait when over the limit. */
  hit(key: string): { readonly ok: true } | { readonly ok: false; readonly retryAfterSec: number };
}

/** Fixed one-minute windows per client key, in memory (one API process). */
export function createRateLimiter(options: {
  readonly perMinute: number;
  readonly now?: () => number;
  /** Keys tracked at once; the oldest windows are dropped beyond this. */
  readonly maxKeys?: number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= 60_000) {
        windows.delete(key);
        if (windows.size >= maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count <= options.perMinute) return { ok: true };
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000)) };
    },
  };
}

export function rateLimit(
  limiter: RateLimiter,
  clientKey: (c: Parameters<MiddlewareHandler>[0]) => string,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const result = limiter.hit(clientKey(c));
    if (!result.ok) {
      c.header('Retry-After', String(result.retryAfterSec));
      throw new ApiError(429, 'rate_limited', 'Too many requests; try again later.');
    }
    return next();
  };
}
