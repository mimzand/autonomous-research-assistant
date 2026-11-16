import { type Context } from 'hono';
import { z } from 'zod';
import { ApiError, ErrorBodySchema } from './errors.js';

/*
 * One table drives both the HTTP handlers and the OpenAPI document: each route's
 * Zod schemas validate the request here and become its OpenAPI description in
 * `openapi.ts`, so the docs cannot drift from what the server accepts.
 */

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

export interface ResponseSpec {
  readonly description: string;
  readonly schema?: z.ZodType;
  /** Default `application/json` when `schema` is set. */
  readonly contentType?: string;
}

interface RouteMeta {
  readonly method: 'get' | 'post';
  /** OpenAPI style: `/tasks/{id}`. */
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  /** Default true: needs the API key. */
  readonly auth?: boolean;
  readonly bodyType?: 'json' | 'multipart';
  readonly responses: Readonly<Record<number, ResponseSpec>>;
}

export interface RouteSpec<
  P extends z.ZodObject | undefined,
  Q extends z.ZodObject | undefined,
  B extends z.ZodType | undefined,
> extends RouteMeta {
  readonly params?: P;
  readonly query?: Q;
  readonly body?: B;
  handle(input: {
    readonly c: Context;
    readonly params: Out<P>;
    readonly query: Out<Q>;
    readonly body: Out<B>;
  }): Promise<Response> | Response;
}

/** A route with its schemas erased: what the server and the OpenAPI builder use. */
export interface ApiRoute extends RouteMeta {
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  run(c: Context): Promise<Response>;
}

const invalid = (where: string, error: z.ZodError) => {
  const issue = error.issues[0];
  const path = [where, ...(issue?.path ?? [])].map(String).join('.');
  // Names the path and the rule, never the submitted value.
  return new ApiError(400, 'invalid_request', `Invalid ${path}: ${issue?.message ?? 'invalid'}`);
};

/** `?a=1&a=2&b=3` as `{ a: ['1','2'], b: '3' }`. */
function queryObject(c: Context): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    out[key] = values.length === 1 ? (values[0] ?? '') : values;
  }
  return out;
}

async function readBody(c: Context, type: 'json' | 'multipart'): Promise<unknown> {
  if (type === 'multipart') {
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
      throw new ApiError(415, 'unsupported_media_type', 'Send multipart/form-data.');
    }
    return c.req.parseBody();
  }
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', 'The request body must be JSON.');
  }
}

export function route<
  P extends z.ZodObject | undefined = undefined,
  Q extends z.ZodObject | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(spec: RouteSpec<P, Q, B>): ApiRoute {
  const { handle, ...meta } = spec;
  return {
    ...meta,
    async run(c) {
      const parse = (schema: z.ZodType | undefined, value: unknown, where: string) => {
        if (!schema) return undefined;
        const result = schema.safeParse(value);
        if (!result.success) throw invalid(where, result.error);
        return result.data;
      };
      const params = parse(spec.params, c.req.param(), 'path');
      const query = parse(spec.query, queryObject(c), 'query');
      const body = spec.body
        ? parse(spec.body, await readBody(c, spec.bodyType ?? 'json'), 'body')
        : undefined;
      return handle({ c, params, query, body } as Parameters<typeof handle>[0]);
    },
  };
}

/** Standard error responses every authenticated route can return. */
export const COMMON_ERRORS: Readonly<Record<number, ResponseSpec>> = {
  400: { description: 'Invalid request', schema: ErrorBodySchema },
  401: { description: 'Missing or wrong API key', schema: ErrorBodySchema },
  429: { description: 'Too many requests', schema: ErrorBodySchema },
  503: { description: 'The agent service is not reachable', schema: ErrorBodySchema },
};

/** An id in a path: the agent validates its exact format. */
export const IdParams = z.object({ id: z.string().min(1).max(100) });
