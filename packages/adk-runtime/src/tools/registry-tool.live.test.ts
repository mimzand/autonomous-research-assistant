/**
 * Live RegistryTool tests: real ADK Runner, OllamaLlm, OllamaProvider, the
 * configured Ollama server and model, and the app's ToolRegistry. Run with
 * `pnpm test:adk:ollama`. Never pulls a model or changes the server.
 */
import {
  createOllamaProvider,
  loadOllamaConfig,
  type OllamaToolSupport,
  ollamaTransportOptionsFromEnv,
} from '@rka/model-provider';
import { createToolRegistry, defineTool } from '@rka/tools';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type Event, InMemorySessionService, LlmAgent, StreamingMode } from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { OllamaLlm } from '../ollama/ollama-llm.js';
import { finalResponseText } from '../structured.js';
import {
  createRegistryTools,
  type RegistryToolResult,
  UNTRUSTED_TOOL_OUTPUT_INSTRUCTION,
} from './registry-tool.js';
import { summarizeInvocation, ToolOutcomeTracker } from './outcomes.js';
/** Trusted ngrok tunnels from OLLAMA_NGROK_BYPASS_HOSTS (same rule as the app). */
const liveTransport = {
  ngrokBypassHosts: ollamaTransportOptionsFromEnv(process.env).ngrokBypassHosts,
};

const config = loadOllamaConfig(process.env);
const provider = createOllamaProvider(config, { ...liveTransport, allowToolCalls: true });
const log = (label: string, value: unknown) =>
  console.info(`[bridge-live] ${label}: ${JSON.stringify(value)}`);

/** Executions observed inside the ToolRegistry's tool implementations. */
const executed = { calculator: vi.fn(), publish: vi.fn() };

const registry = createToolRegistry([
  defineTool({
    name: 'calculator',
    description: 'Performs one arithmetic operation on two numbers and returns the exact result.',
    inputSchema: z.strictObject({
      operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
      a: z.number(),
      b: z.number(),
    }),
    outputSchema: z.object({ result: z.number() }),
    timeoutMs: 5000,
    permissions: {
      network: 'none',
      filesystem: 'none',
      effects: 'read-only',
      requiresApproval: false,
    },
    execute: ({ operation, a, b }) => {
      executed.calculator({ operation, a, b });
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
  }),
  defineTool({
    name: 'publish_note',
    description: 'Publishes a short note to the public website.',
    inputSchema: z.strictObject({ text: z.string().min(1) }),
    outputSchema: z.object({ published: z.boolean() }),
    timeoutMs: 5000,
    permissions: {
      network: 'public-web',
      filesystem: 'none',
      effects: 'external',
      requiresApproval: true,
    },
    execute: (input) => {
      executed.publish(input);
      return Promise.resolve({ published: true });
    },
  }),
]);

const limits = {
  maxCallsPerInvocation: 4,
  maxCallDurationMs: 10_000,
  maxResultBytes: 10_000,
  maxIdenticalCalls: 2,
};

function run(
  allow: string[],
  text: string,
  opts: { stream?: boolean; signal?: AbortSignal; outcomes?: ToolOutcomeTracker } = {},
) {
  const tools = createRegistryTools(registry, {
    allow,
    limits,
    ...(opts.outcomes && { outcomes: opts.outcomes }),
  });
  const sessionService = new InMemorySessionService();
  const runner = createGuardedRunner({
    appName: 'bridge-live',
    agent: new LlmAgent({
      name: 'assistant',
      model: new OllamaLlm({ provider }),
      instruction: `You are a concise assistant. ${UNTRUSTED_TOOL_OUTPUT_INSTRUCTION}`,
      generateContentConfig: { temperature: 0, seed: 42 },
      tools,
    }),
    sessionService,
    registryTools: tools,
  });
  return (async () => {
    const session = await sessionService.createSession({ appName: 'bridge-live', userId: 'local' });
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'local',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text }] },
      ...(opts.stream && { runConfig: { streamingMode: StreamingMode.SSE } }),
      ...(opts.signal && { abortSignal: opts.signal }),
    })) {
      events.push(event);
    }
    return events;
  })();
}

const results = (events: Event[]) =>
  events.flatMap((e) =>
    (e.content?.parts ?? []).flatMap((p) => (p.functionResponse ? [p.functionResponse] : [])),
  );
const errors = (events: Event[]) => events.filter((e) => e.errorCode).map((e) => e.errorCode);

let support: OllamaToolSupport;

describe(`live RegistryTool bridge at ${config.baseUrl} (${config.model})`, () => {
  beforeAll(async () => {
    support = await provider.checkToolSupport();
    log('server', {
      ollama: support.serverVersion,
      model: support.model,
      toolsAdvertised: support.advertised,
    });
  });

  const requireTools = (skip: (note?: string) => void) => {
    if (support.advertised === 'no') skip(`${support.model} does not advertise tool support.`);
  };

  for (const stream of [false, true]) {
    it(`calculator through the ToolRegistry → 6000 (${stream ? 'streaming' : 'non-streaming'})`, async (ctx) => {
      requireTools(ctx.skip);
      executed.calculator.mockClear();
      const events = await run(
        ['calculator'],
        'What is 125 multiplied by 48? Use the calculator tool.',
        { stream },
      );
      log(`calculator (${stream ? 'stream' : 'no stream'})`, {
        registryExecutions: executed.calculator.mock.calls,
        results: results(events),
        answer: finalResponseText(events),
        errors: errors(events),
      });
      // The registry's own tool implementation ran (not a separate calculator).
      expect(executed.calculator).toHaveBeenCalled();
      const responses = results(events).map((r) => r.response as RegistryToolResult);
      expect(responses).toContainEqual(
        expect.objectContaining({ status: 'ok', tool: 'calculator', data: { result: 6000 } }),
      );
      expect(finalResponseText(events)).toMatch(/6[,.\s ]?000/);
    });
  }

  it('cancellation: the run ends with INVOCATION_ABORTED and the registry tool does not run', async (ctx) => {
    requireTools(ctx.skip);
    executed.calculator.mockClear();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const events = await run(
      ['calculator'],
      'What is 125 multiplied by 48? Use the calculator tool.',
      {
        signal: controller.signal,
      },
    );
    log('cancel', {
      errors: errors(events),
      registryExecutions: executed.calculator.mock.calls.length,
    });
    expect(errors(events)).toEqual(['INVOCATION_ABORTED']);
    expect(executed.calculator).not.toHaveBeenCalled();
  });

  it('a tool that needs approval is never executed without a recorded approval', async (ctx) => {
    requireTools(ctx.skip);
    executed.publish.mockClear();
    const events = await run(
      ['publish_note'],
      'Publish a note with the text "hello world" using the publish_note tool. I approve this.',
    );
    const responses = results(events).map((r) => r.response as RegistryToolResult);
    log('approval', { responses, answer: finalResponseText(events), errors: errors(events) });
    expect(executed.publish).not.toHaveBeenCalled();
    // If the model attempted the call, the bridge answered approval_required.
    for (const response of responses) expect(response.status).toBe('approval_required');
  });

  it('Phase 4.1 regression: the authoritative result says approval_required, whatever the model claims', async (ctx) => {
    requireTools(ctx.skip);
    executed.publish.mockClear();
    const outcomes = new ToolOutcomeTracker();
    const events = await run(
      ['publish_note'],
      'Publish a note with the text "hello world" using the publish_note tool. I approve this.',
      { outcomes },
    );
    const result = summarizeInvocation(events, outcomes);
    // Diagnostics only (redacted): what the model said, next to what really happened.
    log('authoritative approval result', {
      status: result.status,
      message: result.message,
      outcomes: result.outcomes,
      shownModelText: result.modelText ?? null,
      rawModelTextForDiagnostics: result.diagnostics.rawModelText ?? null,
    });
    expect(executed.publish).not.toHaveBeenCalled();
    expect(result.status).toBe('approval_required');
    expect(result.message).toBe('Not done: "publish_note" needs your approval and was not run.');
    expect(result.outcomes.every((o) => !o.executionStarted && !o.succeeded)).toBe(true);
    // The model's text, whatever it claims, is not presented as the result.
    expect(result.modelText).toBeUndefined();
  });
});
