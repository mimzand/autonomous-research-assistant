/*
 * Proves that loading ADK and running an agent turn opens no network
 * connection and starts no telemetry, even when telemetry and Google Cloud
 * variables are present in the environment.
 *
 * Every network transport Node offers is intercepted before ADK is loaded:
 * fetch (undici), http/https/http2, raw TCP/TLS sockets (which also cover
 * clients that bypass the higher-level APIs), UDP, DNS and WebSocket. An
 * intercepted call is recorded and fails immediately, so nothing leaves the
 * process even if a check is wrong.
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const attempts: string[] = [];
const restore: (() => void)[] = [];

function intercept<T extends object>(target: T, key: keyof T & string, label: string): void {
  const original = target[key];
  (target as Record<string, unknown>)[key] = function (...args: unknown[]) {
    attempts.push(`${label}(${describe_(args[0])})`);
    throw new Error(`Network access blocked in test: ${label}`);
  };
  restore.push(() => {
    (target as Record<string, unknown>)[key] = original;
  });
}

function describe_(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return value.href;
  try {
    return JSON.stringify(value)?.slice(0, 80) ?? String(value);
  } catch {
    return String(value);
  }
}

beforeAll(() => {
  intercept(globalThis, 'fetch', 'fetch');
  if ('WebSocket' in globalThis)
    intercept(globalThis, 'WebSocket' as keyof typeof globalThis & string, 'WebSocket');
  for (const [mod, name] of [
    [http, 'http'],
    [https, 'https'],
  ] as const) {
    intercept(mod, 'request', `${name}.request`);
    intercept(mod, 'get', `${name}.get`);
  }
  intercept(http2, 'connect', 'http2.connect');
  intercept(net, 'connect', 'net.connect');
  intercept(net, 'createConnection', 'net.createConnection');
  intercept(net.Socket.prototype, 'connect', 'net.Socket.connect');
  intercept(tls, 'connect', 'tls.connect');
  intercept(dgram, 'createSocket', 'dgram.createSocket');
  intercept(dns, 'lookup', 'dns.lookup');
  intercept(dns, 'resolve', 'dns.resolve');
  intercept(dns.promises, 'lookup', 'dns.promises.lookup');
  intercept(dns.promises, 'resolve', 'dns.promises.resolve');
  // Make `import { request } from 'node:http'`-style named imports see the patches too.
  syncBuiltinESMExports();
});

afterAll(() => {
  for (const undo of restore.reverse()) undo();
  syncBuiltinESMExports();
});

describe('network and telemetry isolation', () => {
  it('the interceptors catch every transport (control)', () => {
    const before = attempts.length;
    expect(() => fetch('https://example.invalid/')).toThrow(/blocked/);
    expect(() => net.connect(443, 'example.invalid')).toThrow(/blocked/);
    expect(() => new net.Socket().connect(443, 'example.invalid')).toThrow(/blocked/);
    expect(() => tls.connect(443, 'example.invalid')).toThrow(/blocked/);
    expect(() => https.request('https://example.invalid/')).toThrow(/blocked/);
    expect(() => dns.lookup('example.invalid', () => undefined)).toThrow(/blocked/);
    expect(attempts.length - before).toBe(6);
    attempts.length = before;
  });

  it('loads ADK and runs an agent turn without any network access or telemetry', async () => {
    // Set on the real process environment, which is what ADK reads.
    const env = process.env;
    Object.assign(env, {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces',
      GOOGLE_API_KEY: 'test-key',
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_CLOUD_PROJECT: 'test-project',
      ADK_ENABLE_PROGRESSIVE_SSE_STREAMING: '1',
    });
    const { loadAdkRuntime } = await import('./runtime.js');
    const runtime = await loadAdkRuntime();

    expect(runtime.version).toBe('2.4.0');
    expect(runtime.environment.removed).toHaveLength(6);
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBeUndefined();
    expect(env['GOOGLE_API_KEY']).toBeUndefined();

    const check = await runtime.engine.runAdkSelfCheck();
    expect(check).toMatchObject({ ok: true });

    expect(attempts).toEqual([]);
    // The first import of @google/adk in a test file is a cold load of a large
    // package (~6 s on Windows while all test files run in parallel).
  }, 30_000);

  it('registers no OpenTelemetry tracer, meter or logger provider', () => {
    // @opentelemetry/api keeps registered providers on this global symbol.
    const globals = Object.getOwnPropertySymbols(globalThis)
      .filter((s) => s.description?.startsWith('opentelemetry.js.api'))
      .map((s) => (globalThis as Record<symbol, Record<string, unknown> | undefined>)[s]);
    for (const registry of globals) {
      expect(registry?.['trace']).toBeUndefined();
      expect(registry?.['metrics']).toBeUndefined();
      expect(registry?.['logs']).toBeUndefined();
    }
  });

  it('would detect a cloud call made through ADK (control: a Gemini model, which the app never uses)', async () => {
    const { Gemini } = await import('@google/adk');
    const gemini = new Gemini({ model: 'gemini-2.5-flash', apiKey: 'test-key' });
    const stream = gemini.generateContentAsync({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      liveConnectConfig: {},
      toolsDict: {},
    });
    await expect(stream.next()).rejects.toThrow();
    expect(attempts.some((a) => a.includes('generativelanguage.googleapis.com'))).toBe(true);
    attempts.length = 0;
  });
});
