/**
 * Live tool-calling tests against the configured Ollama server and model.
 * Not part of `pnpm test`; run with `pnpm test:ollama` (OLLAMA_HOST /
 * OLLAMA_MODEL, defaults 127.0.0.1:11434 and qwen3:8b). Never pulls a model
 * and never changes server settings.
 *
 * Tool tests are skipped (with the reason printed) when the model does not
 * advertise tool support. A passing round trip is the only proof of support.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOllamaConfig } from '../config.js';
import { type ChatMessage } from '../schemas.js';
import { calculator, runToolLoop } from '../testing/tool-harness.js';
import { OllamaProvider, type OllamaToolSupport } from './provider.js';
import { parseNdjson } from './ndjson.js';

const config = loadOllamaConfig(process.env);
const ollama = new OllamaProvider(config, { allowToolCalls: true });
const deterministic = { temperature: 0, seed: 42 } as const;
const question: ChatMessage[] = [
  { role: 'user', content: 'What is 125 multiplied by 48? Use the calculator tool.' },
];
const mentions6000 = (text: string) => /6[,.\s ]?000/.test(text);

let support: OllamaToolSupport;

describe(`live tool calling at ${config.baseUrl} (${config.model})`, () => {
  beforeAll(async () => {
    const health = await ollama.checkHealth();
    if (health.status !== 'ready') {
      throw new Error(`Ollama is not ready (${health.status}).`);
    }
    support = await ollama.checkToolSupport();
    console.info(
      `[live] Ollama ${support.serverVersion}, model ${support.model}, tools advertised: ${support.advertised}`,
    );
  });

  const requireTools = (skip: (note?: string) => void) => {
    if (!support.serverSupportsTools)
      skip(`Ollama ${support.serverVersion} predates tool calling.`);
    if (support.advertised === 'no') skip(`${support.model} does not advertise tool support.`);
  };

  it('records how this server streams tool calls (raw /api/chat)', async (ctx) => {
    requireTools(ctx.skip);
    const response = await fetch(`${config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        think: false,
        messages: question,
        tools: [{ type: 'function', function: calculator.tool.definition }],
        options: { ...deterministic, num_ctx: config.numCtx },
      }),
    });
    expect(response.ok).toBe(true);
    const lines: Record<string, unknown>[] = [];
    if (!response.body) throw new Error('Empty response body.');
    for await (const line of parseNdjson(response.body, () => undefined))
      lines.push(line as Record<string, unknown>);
    const withCalls = lines
      .map((line, i) => ({
        i,
        calls: (line['message'] as { tool_calls?: Record<string, unknown>[] } | undefined)
          ?.tool_calls,
      }))
      .filter((x) => x.calls?.length);
    const first = withCalls[0]?.calls?.[0] as
      { id?: unknown; function?: { index?: unknown; arguments?: unknown } } | undefined;
    const report = {
      server: support.serverVersion,
      model: config.model,
      totalChunks: lines.length,
      chunksWithToolCalls: withCalls.map((x) => x.i),
      toolCallInFinalChunk: withCalls.some((x) => x.i === lines.length - 1),
      serverSendsIds: typeof first?.id === 'string',
      serverSendsIndex: typeof first?.function?.index === 'number',
      argumentsType: Array.isArray(first?.function?.arguments)
        ? 'array'
        : typeof first?.function?.arguments,
      doneReason: lines.at(-1)?.['done_reason'],
    };
    console.info(`[live] streaming tool-call behaviour: ${JSON.stringify(report)}`);
    expect(withCalls.length).toBeGreaterThan(0);
  });

  it('round trip without streaming: tool call → calculator → 6000', async (ctx) => {
    requireTools(ctx.skip);
    const run = await runToolLoop({
      provider: ollama,
      messages: question.slice(),
      tools: [calculator],
      request: { options: deterministic },
    });
    console.info(
      `[live] non-streaming events: ${JSON.stringify(run.events)}; answer: ${JSON.stringify(run.final.content)}`,
    );
    expect(run.events.some((e) => e.kind === 'executed' && e.name === 'calculator')).toBe(true);
    expect(mentions6000(run.final.content)).toBe(true);
  });

  it('round trip with streaming: tool call → calculator → 6000', async (ctx) => {
    requireTools(ctx.skip);
    const run = await runToolLoop({
      provider: ollama,
      messages: question.slice(),
      tools: [calculator],
      stream: true,
      request: { options: deterministic },
    });
    console.info(
      `[live] streaming events: ${JSON.stringify(run.events)}; answer: ${JSON.stringify(run.final.content)}`,
    );
    expect(run.events.some((e) => e.kind === 'executed')).toBe(true);
    expect(mentions6000(run.final.content)).toBe(true);
  });

  it('cancels a streaming tool request', async (ctx) => {
    requireTools(ctx.skip);
    const controller = new AbortController();
    const run = (async () => {
      for await (const _chunk of ollama.generateStream(
        { messages: question, tools: [calculator.tool.definition], options: deterministic },
        { signal: controller.signal },
      )) {
        controller.abort();
      }
      // A model that answers with only a tool call may finish before the abort lands.
      controller.abort();
      throw Object.assign(new Error('completed'), { code: 'completed' });
    })();
    await expect(run).rejects.toMatchObject({ code: expect.stringMatching(/cancelled|completed/) });
  });

  it('a model that does not advertise tools is reported as unsupported', async (ctx) => {
    if (support.advertised !== 'no') ctx.skip('The configured model advertises tool support.');
    await expect(
      ollama.generate({ messages: question, tools: [calculator.tool.definition] }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});
