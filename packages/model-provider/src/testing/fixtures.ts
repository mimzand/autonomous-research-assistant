/* Test-only helpers. Not exported from the package entry point. */

import { loadOllamaConfig, type OllamaConfig } from '../config.js';
import { type FetchLike } from '../ollama/provider.js';

export const testConfig: OllamaConfig = loadOllamaConfig({});

export const TAGS_QWEN = {
  models: [
    {
      name: 'qwen3:8b',
      details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M', context_length: 40960 },
      capabilities: ['completion', 'tools', 'thinking'],
    },
    { name: 'gemma3:latest', capabilities: ['completion', 'vision'] },
  ],
};

export function chatChunk(content: string, done = false, extra: Record<string, unknown> = {}) {
  return {
    model: 'qwen3:8b',
    created_at: '2026-11-04T12:00:00Z',
    message: { role: 'assistant', content },
    done,
    ...(done && {
      done_reason: 'stop',
      prompt_eval_count: 18,
      eval_count: 8,
      total_duration: 2_000_000_000,
      load_duration: 500_000_000,
    }),
    ...extra,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function ndjsonResponse(lines: readonly unknown[]): Response {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  return new Response(text, { headers: { 'content-type': 'application/x-ndjson' } });
}

export interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/** Fake fetch routing by path. Records every call. */
export function routeFetch(
  routes: Record<string, (body: unknown) => Response | Promise<Response>>,
): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = new URL(input).pathname;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ path, method: init?.method ?? 'GET', body });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const handler = routes[path];
    if (!handler) throw new TypeError(`fetch failed (no route for ${path})`);
    return handler(body);
  };
  return { fetch, calls };
}
