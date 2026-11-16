import { AgentClientError } from '@rka/agent-client';
import { describe, expect, it } from 'vitest';
import { createAgentLink } from './agent-link.js';
import { apiRoutes } from './app.js';
import { DEFAULT_AGENT_STATE_FILE, loadApiConfig } from './config.js';
import { ApiError, toApiError } from './errors.js';
import { openApiDocument } from './openapi.js';

describe('loadApiConfig', () => {
  it('defaults to loopback, the agent:dev state file and a generated key', () => {
    const config = loadApiConfig({});
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      apiKeyGenerated: true,
      agentStateFile: DEFAULT_AGENT_STATE_FILE,
      corsOrigins: [],
      rateLimitPerMinute: 300,
    });
    expect(config.apiKey.length).toBeGreaterThanOrEqual(24);
    expect(DEFAULT_AGENT_STATE_FILE.replace(/\\/g, '/')).toMatch(
      /apps\/agent\/\.agent-data\/agent-state\.json$/,
    );
  });

  it('requires a chosen key off loopback, and rejects short keys and bad origins', () => {
    expect(() => loadApiConfig({ API_HOST: '0.0.0.0' })).toThrow(/set API_KEY/);
    expect(loadApiConfig({ API_HOST: '0.0.0.0', API_KEY: 'k'.repeat(24) })).toMatchObject({
      apiKeyGenerated: false,
    });
    expect(() => loadApiConfig({ API_KEY: 'short' })).toThrow(/Invalid API_KEY/);
    expect(() =>
      loadApiConfig({ API_CORS_ORIGINS: 'https://ok.example, https://x.example/path' }),
    ).toThrow(/Invalid API_CORS_ORIGINS/);
    expect(
      loadApiConfig({ API_CORS_ORIGINS: 'https://ok.example, http://127.0.0.1:5173' }).corsOrigins,
    ).toEqual(['https://ok.example', 'http://127.0.0.1:5173']);
  });
});

describe('toApiError', () => {
  const map = (code: ConstructorParameters<typeof AgentClientError>[0]) =>
    toApiError(new AgentClientError(code, `agent says ${code}`));

  it('maps agent and connection errors to HTTP statuses without leaking internals', () => {
    expect(map('bad_request')).toMatchObject({ status: 400, message: 'agent says bad_request' });
    expect(map('not_running')).toMatchObject({ status: 503, code: 'agent_unavailable' });
    expect(map('connect_failed')).toMatchObject({ status: 503, code: 'agent_unavailable' });
    expect(map('timeout')).toMatchObject({ status: 504 });
    expect(map('shell_unavailable')).toMatchObject({ status: 501, code: 'needs_desktop_app' });
    expect(map('internal')).toMatchObject({
      status: 502,
      message: 'The agent service could not complete the request.',
    });
    expect(toApiError(new Error('secret detail'))).toMatchObject({
      status: 500,
      message: 'Internal error.',
    });
    const own = new ApiError(404, 'not_found', 'x');
    expect(toApiError(own)).toBe(own);
  });
});

describe('openApiDocument', () => {
  const link = createAgentLink({ stateFile: '/nonexistent', version: '0' });
  const routes = apiRoutes(link);
  const doc = openApiDocument(routes, { version: '0.1.0' }) as {
    paths: Record<string, Record<string, { security: unknown[]; responses: object }>>;
    components: { schemas: Record<string, unknown> };
  };

  it('documents every route, with the API key on all but /health', () => {
    for (const r of routes) {
      const op = doc.paths[r.path]?.[r.method];
      expect(op, `${r.method} ${r.path}`).toBeDefined();
      expect(op?.security).toEqual(r.path === '/health' ? [] : [{ apiKey: [] }]);
    }
  });

  it('every $ref resolves inside the document (recursive schemas live in components)', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"$defs"');
    const refs = [...text.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    const { schemas } = doc.components;
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\//);
      expect(schemas[ref.split('/').pop() ?? '']).toBeDefined();
    }
    expect(Object.keys(schemas)).toEqual(['JsonValue']);
  });
});
