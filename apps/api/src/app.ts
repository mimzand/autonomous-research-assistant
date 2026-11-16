import { getConnInfo } from '@hono/node-server/conninfo';
import { MAX_UPLOAD_BYTES } from '@rka/shared';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type AgentLink } from './agent-link.js';
import { type ApiConfig } from './config.js';
import { mountDocs } from './docs.js';
import { ApiError, errorBody, toApiError } from './errors.js';
import { openApiDocument } from './openapi.js';
import { type ApiRoute } from './route.js';
import { coreRoutes } from './routes/core.js';
import { fileRoutes } from './routes/files.js';
import { streamRoutes } from './routes/streams.js';
import {
  apiKeyAuth,
  corsAllowlist,
  createRateLimiter,
  rateLimit,
  type RateLimiter,
} from './security.js';

export const JSON_BODY_LIMIT_BYTES = 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface ApiDeps {
  readonly config: Pick<ApiConfig, 'apiKey' | 'corsOrigins' | 'rateLimitPerMinute'>;
  readonly agent: AgentLink;
  readonly version: string;
  /** Tests: a limiter with a fake clock. */
  readonly rateLimiter?: RateLimiter;
  readonly log?: (message: string) => void;
}

export function apiRoutes(agent: AgentLink): ApiRoute[] {
  return [...coreRoutes(agent), ...streamRoutes(agent), ...fileRoutes(agent)];
}

const toHonoPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1');

/** The Web API: auth, CORS, rate limit, routes, OpenAPI and Swagger UI. Opens no database. */
export function createApiApp(deps: ApiDeps): Hono {
  const app = new Hono();
  const routes = apiRoutes(deps.agent);
  const log = deps.log ?? ((message: string) => console.warn(message));

  app.onError((error, c) => {
    const apiError = toApiError(error);
    if (apiError.status >= 500 && !(error instanceof ApiError)) {
      log(
        `[api] ${c.req.method} ${c.req.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return c.json(errorBody(apiError), apiError.status);
  });
  app.notFound((c) => c.json(errorBody(new ApiError(404, 'not_found', 'No such route.')), 404));

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });
  app.use('*', corsAllowlist(deps.config.corsOrigins));
  const limiter =
    deps.rateLimiter ?? createRateLimiter({ perMinute: deps.config.rateLimitPerMinute });
  app.use(
    '*',
    rateLimit(limiter, (c) => {
      try {
        return getConnInfo(c).remote.address ?? 'unknown';
      } catch {
        return 'unknown'; // not served by @hono/node-server (tests)
      }
    }),
  );
  app.use('*', apiKeyAuth(deps.config.apiKey));
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES,
      onError: () => {
        throw new ApiError(413, 'too_large', 'The request body is too large.');
      },
    }),
  );
  app.use('*', async (c, next) => {
    const type = c.req.header('content-type') ?? '';
    const length = Number(c.req.header('content-length') ?? 0);
    if (!type.startsWith('multipart/form-data') && length > JSON_BODY_LIMIT_BYTES) {
      throw new ApiError(413, 'too_large', 'The request body is too large.');
    }
    return next();
  });

  for (const r of routes) app.on(r.method.toUpperCase(), toHonoPath(r.path), (c) => r.run(c));

  const document = openApiDocument(routes, { version: deps.version });
  mountDocs(app, () => document);
  return app;
}
