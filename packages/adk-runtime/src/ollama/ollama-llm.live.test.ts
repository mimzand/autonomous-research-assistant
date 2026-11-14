/**
 * Live tests: the real Google ADK Runner and OllamaLlm against the configured
 * Ollama server and installed model. Not part of `pnpm test`; run with
 * `pnpm test:adk:ollama` (OLLAMA_HOST / OLLAMA_MODEL, defaults
 * 127.0.0.1:11434 and qwen3:8b). Never pulls a model or changes the server.
 *
 * Tool tests are skipped (with the reason printed) when the model does not
 * advertise tool support.
 */
import { FunctionTool } from '@google/adk';
import {
  createOllamaProvider,
  loadOllamaConfig,
  type OllamaToolSupport,
  ollamaTransportOptionsFromEnv,
} from '@rka/model-provider';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type BaseTool,
  type Event,
  InMemorySessionService,
  LlmAgent,
  StreamingMode,
} from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { finalResponseText, structuredOutput } from '../structured.js';
import { OllamaLlm } from './ollama-llm.js';
/** Trusted ngrok tunnels from OLLAMA_NGROK_BYPASS_HOSTS (same rule as the app). */
const liveTransport = {
  ngrokBypassHosts: ollamaTransportOptionsFromEnv(process.env).ngrokBypassHosts,
};

const config = loadOllamaConfig(process.env);
const plainProvider = createOllamaProvider(config, liveTransport);
const toolProvider = createOllamaProvider(config, { ...liveTransport, allowToolCalls: true });
const deterministic = { temperature: 0, seed: 42 };
const log = (label: string, value: unknown) =>
  console.info(`[adk-live] ${label}: ${JSON.stringify(value)}`);

let support: OllamaToolSupport;

function harness(
  options: {
    llm?: OllamaLlm;
    tools?: BaseTool[];
    beforeModelCallback?: ConstructorParameters<typeof LlmAgent>[0]['beforeModelCallback'];
    instruction?: string;
  } = {},
) {
  const sessionService = new InMemorySessionService();
  const runner = createGuardedRunner({
    appName: 'live',
    agent: new LlmAgent({
      name: 'assistant',
      model: options.llm ?? new OllamaLlm({ provider: plainProvider }),
      instruction: options.instruction ?? 'You are a concise assistant.',
      generateContentConfig: deterministic,
      ...(options.tools && { tools: options.tools }),
      ...(options.beforeModelCallback && { beforeModelCallback: options.beforeModelCallback }),
    }),
    sessionService,
    ...(options.tools && { allowedTools: options.tools }),
  });
  return async (
    text: string,
    opts: { stream?: boolean; signal?: AbortSignal; onEvent?: (e: Event) => void } = {},
  ) => {
    const session = await sessionService.createSession({ appName: 'live', userId: 'local' });
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'local',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text }] },
      ...(opts.stream && { runConfig: { streamingMode: StreamingMode.SSE } }),
      ...(opts.signal && { abortSignal: opts.signal }),
    })) {
      events.push(event);
      opts.onEvent?.(event);
    }
    return events;
  };
}

function calculator() {
  const spy = vi.fn();
  const tool = new FunctionTool({
    name: 'calculator',
    description: 'Performs one arithmetic operation on two numbers and returns the exact result.',
    parameters: z.strictObject({
      operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
      a: z.number(),
      b: z.number(),
    }),
    execute: ({ operation, a, b }) => {
      spy({ operation, a, b });
      const result =
        operation === 'add'
          ? a + b
          : operation === 'subtract'
            ? a - b
            : operation === 'multiply'
              ? a * b
              : a / b;
      return Promise.resolve({ result });
    },
  });
  return { tool, spy };
}

const errors = (events: Event[]) => events.filter((e) => e.errorCode).map((e) => e.errorCode);
const mentions6000 = (text: string | undefined) => /6[,.\s ]?000/.test(text ?? '');

describe(`live ADK + OllamaLlm at ${config.baseUrl} (${config.model})`, () => {
  beforeAll(async () => {
    const health = await plainProvider.checkHealth();
    if (health.status !== 'ready') throw new Error(`Ollama is not ready (${health.status}).`);
    support = await plainProvider.checkToolSupport();
    log('server', {
      ollama: support.serverVersion,
      model: support.model,
      toolsAdvertised: support.advertised,
    });
  });

  const requireTools = (skip: (note?: string) => void) => {
    if (support.advertised === 'no') skip(`${support.model} does not advertise tool support.`);
  };

  it('basic generation with usage metadata', async () => {
    const events = await harness()('Reply with exactly the word READY and nothing else.');
    const text = finalResponseText(events);
    const final = events.at(-1);
    log('basic', { text, usage: final?.usageMetadata, finishReason: final?.finishReason });
    expect(errors(events)).toEqual([]);
    expect(text?.toUpperCase()).toContain('READY');
    expect(final?.usageMetadata?.candidatesTokenCount).toBeGreaterThan(0);
    expect(final?.usageMetadata?.promptTokenCount).toBeGreaterThan(0);
  });

  it('streaming: partial events, then one final event', async () => {
    const events = await harness()('Count from 1 to 5, separated by spaces.', { stream: true });
    const partials = events.filter((e) => e.partial).length;
    const finals = events.filter((e) => !e.partial && !e.errorCode);
    log('streaming', { partials, finals: finals.length, text: finalResponseText(events) });
    expect(partials).toBeGreaterThan(1);
    expect(finals).toHaveLength(1);
    expect(finalResponseText(events)).toMatch(/1.*2.*3/s);
  });

  for (const stream of [false, true]) {
    it(`tool calling round trip: calculator → 6000 (${stream ? 'streaming' : 'non-streaming'})`, async (ctx) => {
      requireTools(ctx.skip);
      const { tool, spy } = calculator();
      const events = await harness({
        llm: new OllamaLlm({ provider: toolProvider }),
        tools: [tool],
      })('What is 125 multiplied by 48? Use the calculator tool.', { stream });
      const calls = events.flatMap((e) =>
        (e.content?.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall),
      );
      log(`tools (${stream ? 'stream' : 'no stream'})`, {
        calls,
        executed: spy.mock.calls,
        answer: finalResponseText(events),
        errors: errors(events),
      });
      expect(spy).toHaveBeenCalled();
      expect(
        spy.mock.calls.some(
          ([args]) =>
            (args as { a: number; b: number }).a * (args as { a: number; b: number }).b === 6000,
        ),
      ).toBe(true);
      expect(mentions6000(finalResponseText(events))).toBe(true);
    });
  }

  it('structured output validated at the app boundary', async () => {
    const Plan = z.strictObject({
      topic: z.string().min(1),
      questions: z.array(z.string().min(1)).min(2).max(5),
    });
    const structured = structuredOutput(Plan);
    const events = await harness({ beforeModelCallback: structured.beforeModelCallback })(
      'Plan research on home heat pumps: give a topic and 3 questions.',
    );
    const parsed = structured.parse(finalResponseText(events));
    log('structured', parsed);
    expect(parsed.ok).toBe(true);
  });

  it('cancellation: aborting the stream ends the run with INVOCATION_ABORTED', async () => {
    const controller = new AbortController();
    const events = await harness()('Write a 500-word essay about rivers.', {
      stream: true,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.partial) controller.abort();
      },
    });
    log('cancel', { errors: errors(events), events: events.length });
    expect(errors(events)).toEqual(['INVOCATION_ABORTED']);
  });

  it('cancellation while the tool-call response is generated: the tool is not executed', async (ctx) => {
    requireTools(ctx.skip);
    const { tool, spy } = calculator();
    const controller = new AbortController();
    // Abort shortly after the request is sent, before the model can finish its tool call.
    setTimeout(() => controller.abort(), 20);
    const events = await harness({ llm: new OllamaLlm({ provider: toolProvider }), tools: [tool] })(
      'What is 125 multiplied by 48? Use the calculator tool.',
      { stream: true, signal: controller.signal },
    );
    log('cancel tool', { errors: errors(events), executed: spy.mock.calls.length });
    expect(errors(events)).toEqual(['INVOCATION_ABORTED']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a missing model is reported as OLLAMA_MODEL_NOT_FOUND', async () => {
    const missing = createOllamaProvider(
      loadOllamaConfig({ ...process.env, OLLAMA_MODEL: 'definitely-not-installed:1b' }),
      liveTransport,
    );
    const events = await harness({ llm: new OllamaLlm({ provider: missing }) })('x');
    log('missing model', errors(events));
    expect(errors(events)).toEqual(['OLLAMA_MODEL_NOT_FOUND']);
  });
});
