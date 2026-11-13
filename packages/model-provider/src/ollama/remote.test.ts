/*
 * Phase 7.3: remote (HTTPS, ngrok) Ollama endpoints through the existing
 * OllamaProvider. Deterministic: a scripted fetch stands in for the network,
 * so no request ever leaves this process.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  loadOllamaConfig,
  ollamaTransportOptionsFromEnv,
  parseNgrokBypassHosts,
  resolveOllamaBaseUrl,
  type OllamaConfig,
} from '../config.js';
import { isModelProviderError } from '../errors.js';
import { generateObject } from '../structured.js';
import { createOllamaProvider, sendsNgrokBypass, type FetchLike } from './provider.js';

const TUNNEL = 'example-tunnel.ngrok-free.dev';
const OTHER = 'other-tunnel.ngrok-free.dev';
const MODEL = 'qwen3.5:9b-mlx';

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
  readonly redirect: string | undefined;
}

const chunk = (content: string, done: boolean, extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  created_at: '2026-11-13T10:00:00Z',
  message: { role: 'assistant', content, ...(extra['message'] as object | undefined) },
  done,
  ...(done && {
    done_reason: (extra['done_reason'] as string | undefined) ?? 'stop',
    prompt_eval_count: 10,
    eval_count: 1,
    total_duration: 1_000_000,
    load_duration: 0,
  }),
});

type Reply = (
  path: string,
  body: Record<string, unknown> | null,
  signal: AbortSignal | null,
) => Promise<Response> | Response;

/** A scripted fetch: records every request (URL, headers, body), answers like Ollama. */
function scripted(reply?: Reply) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen.push({
      url: input,
      headers: { ...(init.headers as Record<string, string>) },
      body,
      redirect: init.redirect,
    });
    const path = new URL(input).pathname.replace(/^\/ollama/, '');
    if (reply) {
      const r = await reply(path, body, init.signal ?? null);
      return r;
    }
    return defaultReply(path, body);
  };
  return { seen, fetch };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const ndjson = (lines: unknown[]) =>
  new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(''), {
    headers: { 'content-type': 'application/x-ndjson' },
  });

function defaultReply(path: string, body: Record<string, unknown> | null): Response {
  if (path === '/api/version') return json({ version: '0.40.14' });
  if (path === '/api/tags')
    return json({ models: [{ name: MODEL, capabilities: ['completion'] }] });
  if (path === '/api/show') return json({ capabilities: ['completion'] });
  if (path === '/api/chat') {
    return body?.['stream']
      ? ndjson([chunk('O', false), chunk('K', false), chunk('', true)])
      : json(chunk('OK', true));
  }
  return json({ error: 'not found' }, 404);
}

const remote = (host = TUNNEL, extra: Partial<OllamaConfig> = {}): OllamaConfig => ({
  ...loadOllamaConfig({ OLLAMA_HOST: `https://${host}`, OLLAMA_MODEL: MODEL }),
  ...extra,
});
const hi = { messages: [{ role: 'user' as const, content: 'Reply with OK.' }] };

describe('remote endpoint configuration', () => {
  it('local stays the default; https:// endpoints keep their host and path, without the local port', () => {
    expect(loadOllamaConfig({}).baseUrl).toBe('http://127.0.0.1:11434');
    expect(remote().baseUrl).toBe(`https://${TUNNEL}`);
    expect(resolveOllamaBaseUrl('https://proxy.example.com/ollama/')).toBe(
      'https://proxy.example.com/ollama',
    );
  });

  it('OLLAMA_NGROK_BYPASS_HOSTS accepts exact host names only', () => {
    expect(parseNgrokBypassHosts(` ${TUNNEL.toUpperCase()}, ${OTHER} ,,${TUNNEL}`)).toEqual({
      hosts: [TUNNEL, OTHER],
      invalid: [],
    });
    expect(
      parseNgrokBypassHosts(
        `https://${TUNNEL},${TUNNEL}:443,*.ngrok-free.dev,${TUNNEL}/x,10.0.0.1,::1,localhost,-bad.example`,
      ).hosts,
    ).toEqual([]);
    expect(parseNgrokBypassHosts(undefined)).toEqual({ hosts: [], invalid: [] });
    expect(
      ollamaTransportOptionsFromEnv({ OLLAMA_NGROK_BYPASS_HOSTS: TUNNEL }).ngrokBypassHosts,
    ).toEqual([TUNNEL]);
  });

  it('the bypass rule: listed host, HTTPS only', () => {
    expect(sendsNgrokBypass(`https://${TUNNEL}`, [TUNNEL])).toBe(true);
    expect(sendsNgrokBypass(`https://${TUNNEL.toUpperCase()}/ollama`, [TUNNEL])).toBe(true);
    expect(sendsNgrokBypass(`http://${TUNNEL}`, [TUNNEL])).toBe(false);
    expect(sendsNgrokBypass(`https://${OTHER}`, [TUNNEL])).toBe(false);
    expect(sendsNgrokBypass(`https://${TUNNEL}.evil.example`, [TUNNEL])).toBe(false);
    expect(sendsNgrokBypass('http://127.0.0.1:11434', [TUNNEL])).toBe(false);
    expect(sendsNgrokBypass(`https://${TUNNEL}`, [])).toBe(false);
  });
});

describe('ngrok header: trusted hosts only', () => {
  const header = (s: Seen) => s.headers['ngrok-skip-browser-warning'];

  it('is sent to a trusted HTTPS tunnel on every call: health, models, chat (streaming and not), structured output', async () => {
    const { seen, fetch } = scripted();
    const provider = createOllamaProvider(remote(), { fetch, ngrokBypassHosts: [TUNNEL] });
    await provider.checkHealth();
    await provider.listModels?.();
    await provider.generate(hi);
    for await (const _ of provider.generateStream(hi)) void _;
    await generateObject(provider, hi, z.object({}).loose()).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.every((s) => header(s) === 'true')).toBe(true);
    expect(seen.every((s) => s.url.startsWith(`https://${TUNNEL}/api/`))).toBe(true);
    expect(seen.every((s) => s.redirect === 'manual')).toBe(true);
  });

  it('is never sent to local Ollama, an untrusted tunnel, or a trusted host over plain HTTP', async () => {
    for (const config of [
      loadOllamaConfig({}),
      remote(OTHER),
      { ...remote(), baseUrl: `http://${TUNNEL}:80` },
    ]) {
      const { seen, fetch } = scripted();
      const provider = createOllamaProvider(config, { fetch, ngrokBypassHosts: [TUNNEL] });
      await provider.generate(hi).catch(() => undefined);
      expect(seen.map(header), config.baseUrl).toEqual(seen.map(() => undefined));
    }
  });

  it('follows the configuration: switching away from the trusted host stops the header; snapshots keep the rule', async () => {
    const { seen, fetch } = scripted();
    const provider = createOllamaProvider(remote(), { fetch, ngrokBypassHosts: [TUNNEL] });
    const snapshot = provider.snapshot();
    provider.reconfigure(remote(OTHER));
    await provider.generate(hi);
    await snapshot.generate(hi);
    expect(seen.map((s) => [new URL(s.url).hostname, header(s) ?? null])).toEqual([
      [OTHER, null],
      [TUNNEL, 'true'],
    ]);
  });

  it('redirects are refused and never followed: the header and prompt never reach another host', async () => {
    const { seen, fetch } = scripted(
      () => new Response(null, { status: 307, headers: { location: `https://${OTHER}/api/chat` } }),
    );
    const provider = createOllamaProvider(remote(), {
      fetch,
      ngrokBypassHosts: [TUNNEL],
      getAuthToken: () => 'secret',
    });
    const error = await provider.generate(hi).catch((e: unknown) => e);
    expect(isModelProviderError(error) && error.code).toBe('http-error');
    expect((error as Error).message).toMatch(/redirect \(HTTP 307\)\. Redirects are not followed/);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? '').hostname).toBe(TUNNEL);
    expect(JSON.stringify(seen)).not.toContain(OTHER);
  });

  it('the access token still goes only over HTTPS or to this computer', async () => {
    const run = async (config: OllamaConfig) => {
      const { seen, fetch } = scripted();
      await createOllamaProvider(config, { fetch, getAuthToken: () => 'tok' }).generate(hi);
      return seen.map((s) => s.headers['authorization'] ?? null);
    };
    expect(await run(remote())).toEqual(['Bearer tok']);
    expect(await run({ ...remote(), baseUrl: 'http://gpu-box.example:11434' })).toEqual([null]);
  });
});

describe('remote responses', () => {
  it('model not found', async () => {
    const { fetch } = scripted((path) =>
      path === '/api/chat'
        ? json({ error: `model '${MODEL}' not found` }, 404)
        : defaultReply(path, null),
    );
    const error = await createOllamaProvider(remote(), { fetch })
      .generate(hi)
      .catch((e: unknown) => e);
    expect(isModelProviderError(error) && error.code).toBe('model-not-found');
  });

  it('thinking-only replies (think off, empty content): empty content, thinking dropped; JSON parsing then fails cleanly', async () => {
    const thinkingOnly = { message: { thinking: 'Let me think about it…' } };
    const { seen, fetch } = scripted((path, body) =>
      path === '/api/chat'
        ? body?.['stream']
          ? ndjson([chunk('', false, thinkingOnly), chunk('', true)])
          : json(chunk('', true, thinkingOnly))
        : defaultReply(path, body),
    );
    const provider = createOllamaProvider(remote(), { fetch });
    const result = await provider.generate(hi);
    expect(result).toMatchObject({ content: '', finishReason: 'stop' });
    expect(result).not.toHaveProperty('thinking');
    const chunks = [];
    for await (const c of provider.generateStream(hi)) chunks.push(c);
    // Thinking stays separate from content (Chat and the ADK adapter show content only).
    expect(chunks.filter((c) => c.type === 'delta')).toEqual([
      { type: 'delta', content: '', thinking: 'Let me think about it…' },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', result: { content: '' } });
    expect(chunks.at(-1)).not.toHaveProperty('result.thinking');
    await expect(generateObject(provider, hi, z.object({ a: z.string() }))).rejects.toMatchObject({
      code: 'invalid-response',
      message: 'Model did not return valid JSON (got: "").',
    });
    expect(
      seen.filter((s) => s.url.endsWith('/api/chat')).every((s) => s.body?.['think'] === false),
    ).toBe(true);
  });

  it('done_reason=length is reported as finishReason "length" (streaming and not)', async () => {
    const { fetch } = scripted((path, body) =>
      path === '/api/chat'
        ? body?.['stream']
          ? ndjson([chunk('partial', false), chunk('', true, { done_reason: 'length' })])
          : json(chunk('partial', true, { done_reason: 'length' }))
        : defaultReply(path, body),
    );
    const provider = createOllamaProvider(remote(), { fetch });
    expect(await provider.generate(hi)).toMatchObject({
      content: 'partial',
      finishReason: 'length',
    });
    const chunks = [];
    for await (const c of provider.generateStream(hi)) chunks.push(c);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', result: { finishReason: 'length' } });
  });

  it('cancellation and timeouts abort the remote request', async () => {
    const hang: Reply = (path, _b, signal) =>
      path === '/api/chat'
        ? new Promise<Response>((_resolve, reject) =>
            signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          )
        : defaultReply(path, null);
    const { fetch } = scripted(hang);
    const provider = createOllamaProvider(remote(), { fetch });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(provider.generate(hi, { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    await expect(provider.generate(hi, { timeoutMs: 30 })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('a non-Ollama answer (e.g. an HTML interstitial) is an invalid response, not a model answer', async () => {
    const { fetch } = scripted(
      () =>
        new Response('<!DOCTYPE html><html>ngrok</html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    const error = await createOllamaProvider(remote(), { fetch })
      .generate(hi)
      .catch((e: unknown) => e);
    expect(isModelProviderError(error) && error.code).toBe('invalid-response');
  });
});
