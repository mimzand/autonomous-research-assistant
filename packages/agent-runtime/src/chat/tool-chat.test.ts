import {
  ModelProviderError,
  type GenerateChunk,
  type GenerateRequest,
  type ModelProvider,
} from '@rka/model-provider';
import { createToolRegistry, createWebSearchTool, type WebSearchProvider } from '@rka/tools';
import { describe, expect, it } from 'vitest';
import { CHAT_TOOL_LIMITS, createToolGateway, type ToolTurnLimits } from '../tools/gateway.js';
import { streamChatWithTools, type ChatStreamChunk } from './tool-chat.js';

const usage = { promptTokens: 1, completionTokens: 1, totalDurationMs: 1, loadDurationMs: 0 };

/** A provider whose rounds are scripted; `hang` waits for the abort signal. */
function scripted(
  rounds: (
    | { text?: string; calls?: { id: string; name: string; arguments: Record<string, unknown> }[] }
    | 'hang'
  )[],
) {
  const requests: GenerateRequest[] = [];
  const provider = {
    id: 'fake',
    defaultModel: 'm',
    checkHealth: () => Promise.reject(new Error('unused')),
    checkModel: () => Promise.reject(new Error('unused')),
    generate: () => Promise.reject(new Error('unused')),
    async *generateStream(request: GenerateRequest, options: { signal?: AbortSignal } = {}) {
      requests.push(request);
      const round = rounds.shift() ?? { text: 'end' };
      if (round === 'hang') {
        await new Promise((_resolve, reject) =>
          options.signal?.addEventListener(
            'abort',
            () => reject(new ModelProviderError('cancelled', 'The request was cancelled.')),
            { once: true },
          ),
        );
        return;
      }
      if (round.text) yield { type: 'delta', content: round.text } satisfies GenerateChunk;
      yield {
        type: 'done',
        result: {
          model: 'm',
          content: round.text ?? '',
          finishReason: 'stop',
          usage,
          ...(round.calls && { toolCalls: round.calls }),
        },
      } satisfies GenerateChunk;
    },
  } as unknown as ModelProvider;
  return { provider, requests };
}

function gateway(limits: Partial<ToolTurnLimits> = {}, search?: WebSearchProvider['search']) {
  const provider: WebSearchProvider = {
    id: 'searxng',
    checkHealth: () => Promise.reject(new Error('unused')),
    search:
      search ??
      (() =>
        Promise.resolve([
          { title: 't', url: 'https://example.com/', snippet: 's', engines: [], publishedAt: null },
        ])),
  };
  return createToolGateway({
    registry: createToolRegistry([createWebSearchTool(provider)]),
    policy: { surface: 'chat', allow: ['web_search'], limits: { ...CHAT_TOOL_LIMITS, ...limits } },
  });
}

async function collect(iterable: AsyncIterable<ChatStreamChunk>) {
  const chunks: ChatStreamChunk[] = [];
  try {
    for await (const chunk of iterable) chunks.push(chunk);
    return { chunks, error: undefined };
  } catch (error) {
    return { chunks, error: error as ModelProviderError };
  }
}

const turns = [{ role: 'user' as const, content: 'q' }];

describe('streamChatWithTools', () => {
  it('refuses to run without any allowed tool', async () => {
    const empty = createToolGateway({
      registry: createToolRegistry([]),
      policy: { surface: 'chat', allow: ['web_search'], limits: CHAT_TOOL_LIMITS },
    });
    const { provider, requests } = scripted([{ text: 'x' }]);
    const { error } = await collect(
      streamChatWithTools(
        turns,
        { signal: new AbortController().signal },
        { provider, gateway: empty },
      ),
    );
    expect(error).toMatchObject({ code: 'unsupported' });
    expect(requests).toHaveLength(0);
  });

  it('stops the whole turn at the deadline with a timeout error (no done)', async () => {
    const { provider } = scripted([
      { calls: [{ id: 'c1', name: 'web_search', arguments: { query: 'a' } }] },
      'hang',
    ]);
    const { chunks, error } = await collect(
      streamChatWithTools(
        turns,
        { signal: new AbortController().signal },
        { provider, gateway: gateway({ turnTimeoutMs: 50 }) },
      ),
    );
    expect(error).toMatchObject({ code: 'timeout' });
    expect(error?.message).toMatch(/took longer than/);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });

  it('reports cancellation, not the deadline, when the user cancelled first', async () => {
    const controller = new AbortController();
    const { provider } = scripted(['hang']);
    setTimeout(() => controller.abort(), 10);
    const { chunks, error } = await collect(
      streamChatWithTools(
        turns,
        { signal: controller.signal },
        { provider, gateway: gateway({ turnTimeoutMs: 1_000 }) },
      ),
    );
    expect(error).toMatchObject({ code: 'cancelled' });
    expect(chunks).toEqual([]);
  });

  it('never yields done after cancellation during a tool call', async () => {
    const controller = new AbortController();
    const { provider, requests } = scripted([
      { calls: [{ id: 'c1', name: 'web_search', arguments: { query: 'a' } }] },
      { text: 'answer' },
    ]);
    const { chunks, error } = await collect(
      streamChatWithTools(
        turns,
        { signal: controller.signal },
        {
          provider,
          gateway: gateway({}, () => {
            controller.abort();
            return Promise.resolve([]);
          }),
        },
      ),
    );
    expect(error).toMatchObject({ code: 'cancelled' });
    expect(chunks.map((c) => (c.type === 'tool' ? `tool:${c.status}` : c.type))).toEqual([
      'usage',
      'tool:running',
      'tool:cancelled',
    ]);
    expect(requests).toHaveLength(1);
  });

  it('sends the system instruction and declarations only on tool rounds; the last round has none', async () => {
    const { provider, requests } = scripted([
      { calls: [{ id: 'c1', name: 'web_search', arguments: { query: 'a' } }] },
      { calls: [{ id: 'c2', name: 'web_search', arguments: { query: 'b' } }] },
      { text: 'done' },
    ]);
    const { chunks } = await collect(
      streamChatWithTools(
        turns,
        { signal: new AbortController().signal },
        { provider, gateway: gateway() },
      ),
    );
    expect(requests.map((r) => r.tools?.map((t) => t.name) ?? null)).toEqual([
      ['web_search'],
      ['web_search'],
      null,
    ]);
    for (const r of requests) expect(r.messages[0]?.role).toBe('system');
    expect(requests.every((r) => r.think === false)).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', result: { content: 'done' } });
  });
});
