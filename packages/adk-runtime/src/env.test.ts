import { describe, expect, it } from 'vitest';
import { CLOUD_ENV_VARS, FORCED_ENV, sanitizeAdkEnvironment, TELEMETRY_ENV_VARS } from './env.js';

describe('sanitizeAdkEnvironment', () => {
  it('removes telemetry endpoints, Google Cloud credentials and ADK feature flags', () => {
    const env: NodeJS.ProcessEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector:4318/v1/metrics',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://collector:4318/v1/logs',
      GOOGLE_API_KEY: 'secret-1',
      GEMINI_API_KEY: 'secret-2',
      GOOGLE_GENAI_API_KEY: 'secret-3',
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_GENAI_USE_ENTERPRISE: '1',
      GOOGLE_CLOUD_PROJECT: 'p',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
      GOOGLE_CLOUD_AGENT_ENGINE_ID: 'e',
      GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
      ADK_ENABLE_PROGRESSIVE_SSE_STREAMING: '1',
      ADK_DISABLE_GEMINI_MODEL_ID_CHECK: 'true',
    };
    const report = sanitizeAdkEnvironment(env);

    for (const name of [...TELEMETRY_ENV_VARS, ...CLOUD_ENV_VARS]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env['ADK_ENABLE_PROGRESSIVE_SSE_STREAMING']).toBeUndefined();
    expect(env['ADK_DISABLE_GEMINI_MODEL_ID_CHECK']).toBeUndefined();
    expect(report.removed).toHaveLength(15);
    expect(env).toEqual(FORCED_ENV);
  });

  it('forces content capture in spans off and the OpenTelemetry SDK disabled', () => {
    const env: NodeJS.ProcessEnv = {
      ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'true',
      OTEL_SDK_DISABLED: 'false',
    };
    const report = sanitizeAdkEnvironment(env);
    expect(env['ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS']).toBe('false');
    expect(env['OTEL_SDK_DISABLED']).toBe('true');
    expect(report.forced).toEqual(['OTEL_SDK_DISABLED', 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS']);
  });

  it('leaves unrelated variables untouched, including similar-looking ones', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      OLLAMA_HOST: '127.0.0.1:11434',
      SEARXNG_URL: 'http://127.0.0.1:8080',
      OTEL_SERVICE_NAME: 'x',
      GOOGLE_CHROME_BIN: '/chrome',
      ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
      ADK_SOMETHING_ELSE: 'kept',
    };
    const before = { ...env };
    const report = sanitizeAdkEnvironment(env);
    expect(report.removed).toEqual([]);
    expect(env).toEqual({ ...before, ...FORCED_ENV });
  });

  it('reports names only and is idempotent', () => {
    const env: NodeJS.ProcessEnv = { GOOGLE_API_KEY: 'do-not-leak' };
    const first = sanitizeAdkEnvironment(env);
    expect(JSON.stringify(first)).not.toContain('do-not-leak');
    expect(first.removed).toEqual(['GOOGLE_API_KEY']);
    expect(sanitizeAdkEnvironment(env).removed).toEqual([]);
  });
});
