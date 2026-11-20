import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The state file `pnpm agent:dev` writes with its default data folder. */
export const DEFAULT_AGENT_STATE_FILE = fileURLToPath(
  new URL('../../agent/.agent-data/agent-state.json', import.meta.url),
);
export const MIN_API_KEY_LENGTH = 24;

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  /** Clients send it as `X-API-Key` (or `Authorization: Bearer`). */
  readonly apiKey: string;
  /** True when no `API_KEY` was set and a random one was made for this run (loopback only). */
  readonly apiKeyGenerated: boolean;
  readonly agentStateFile: string;
  /** Exact origins allowed to call the API from a browser (CORS). Empty: none. */
  readonly corsOrigins: readonly string[];
  /** Requests per minute per client address. */
  readonly rateLimitPerMinute: number;
}

const isLoopback = (host: string) =>
  host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));

const OriginSchema = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
    } catch {
      return false;
    }
  }, 'must be an origin like https://app.example.com (no path, no trailing slash)');

const EnvSchema = z.object({
  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  API_KEY: z
    .string()
    .trim()
    .min(MIN_API_KEY_LENGTH, `must be at least ${MIN_API_KEY_LENGTH} characters`)
    .optional(),
  AGENT_STATE_FILE: z.string().trim().min(1).optional(),
  API_CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(OriginSchema).max(20)),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),
});

/**
 * Reads the API settings from the environment. Throws with the variable name on bad
 * input. Without `API_KEY`, a random key is made for this run, but only when the
 * API listens on a loopback address: an API reachable from other machines must
 * have a key the operator chose.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid ${String(issue?.path[0] ?? 'environment')}: ${issue?.message ?? ''}`);
  }
  const e = parsed.data;
  if (!e.API_KEY && !isLoopback(e.API_HOST)) {
    throw new Error(
      `API_HOST=${e.API_HOST} is not a loopback address: set API_KEY (at least ${MIN_API_KEY_LENGTH} characters).`,
    );
  }
  return {
    host: e.API_HOST,
    port: e.API_PORT,
    apiKey: e.API_KEY ?? randomBytes(24).toString('base64url'),
    apiKeyGenerated: !e.API_KEY,
    agentStateFile: resolve(e.AGENT_STATE_FILE ?? DEFAULT_AGENT_STATE_FILE),
    corsOrigins: e.API_CORS_ORIGINS,
    rateLimitPerMinute: e.API_RATE_LIMIT_PER_MINUTE,
  };
}
