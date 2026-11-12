/*
 * The real Google ADK Runner driving OllamaLlm, which talks through the real
 * OllamaProvider (real fetch, real HTTP) to a local fake Ollama server.
 *
 * FunctionTool is imported from @google/adk here, in test code only, and
 * allowed through the agent guard with the test-only `allowedTools` option.
 */
import { FunctionTool } from '@google/adk';
import { createOllamaProvider, loadOllamaConfig, type OllamaProvider } from '@rka/model-provider';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import {
  type ChatBody,
  chunk,
  type FakeOllama,
  json,
  reply,
  startFakeOllama,
  streamLines,
  toolCallChunk,
} from '../testing/fake-ollama.js';
import { OllamaLlm } from './ollama-llm.js';

let ollama: FakeOllama;
beforeAll(async () => (ollama = await startFakeOllama()));
afterAll(() => ollama.close());

function provider(env: Record<string, string> = {}, allowToolCalls = false): OllamaProvider {
  return createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: ollama.baseUrl, ...env }), {
    ...(allowToolCalls && { allowToolCalls: true }),
  });
}

function calculatorTool(spy = vi.fn()) {
  const tool = new FunctionTool({
    name: 'calculator',
    description: 'Performs one arithmetic operation on two numbers.',
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

function setup(
  options: {
    llm?: OllamaLlm;
    tools?: BaseTool[];
    instruction?: string;
    outputSchema?: z.ZodObject;
    beforeModelCallback?: ConstructorParameters<typeof LlmAgent>[0]['beforeModelCallback'];
  } = {},
) {
  const sessionService = new InMemorySessionService();
  const agent = new LlmAgent({
    name: 'assistant',
    model: options.llm ?? new OllamaLlm({ provider: provider() }),
    instruction: options.instruction ?? 'You are a helpful assistant.',
    ...(options.tools && { tools: options.tools }),
    ...(options.outputSchema && { outputSchema: options.outputSchema }),
    ...(options.beforeModelCallback && { beforeModelCallback: options.beforeModelCallback }),
  });
  const runner = createGuardedRunner({
    appName: 'test',
    agent,
    sessionService,
    ...(options.tools && { allowedTools: options.tools }),
  });
  const session = () => sessionService.createSession({ appName: 'test', userId: 'local' });
  const run = async (
    sessionId: string,
    text: string,
    opts: { stream?: boolean; signal?: AbortSignal; onEvent?: (e: Event) => void } = {},
  ) => {
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'local',
      sessionId,
      newMessage: { role: 'user', parts: [{ text }] },
      ...(opts.stream && { runConfig: { streamingMode: StreamingMode.SSE } }),
      ...(opts.signal && { abortSignal: opts.signal }),
    })) {
      events.push(event);
      opts.onEvent?.(event);
    }
    return events;
  };
  const stored = async (sessionId: string) =>
    (await sessionService.getSession({ appName: 'test', userId: 'local', sessionId }))?.events ??
    [];
  return { run, session, stored };
}

const textOf = (e: Event | undefined) =>
  (e?.content?.parts ?? []).map((p) => p.text ?? '').join('');
const errors = (events: Event[]) => events.filter((e) => e.errorCode).map((e) => e.errorCode);

describe('A. basic text generation', () => {
  it('Runner → OllamaLlm → OllamaProvider → Ollama → final response with usage', async () => {
    ollama.setChat((body, res) => reply(body, res, [chunk('Hello '), chunk('there.', true)]));
    const { run, session } = setup({ instruction: 'Be brief.' });
    const events = await run((await session()).id, 'Say hello.');

    expect(events).toHaveLength(1);
    const [final] = events;
    expect(textOf(final)).toBe('Hello there.');
    expect(final?.partial).toBeFalsy();
    expect(final?.finishReason).toBe('STOP');
    expect(final?.usageMetadata).toEqual({
      promptTokenCount: 21,
      candidatesTokenCount: 9,
      totalTokenCount: 30,
    });

    const [body] = ollama.chats;
    expect(body).toMatchObject({ model: 'qwen3:8b', stream: false, think: false });
    expect(body?.messages).toEqual([
      { role: 'system', content: expect.stringContaining('Be brief.') },
      { role: 'user', content: 'Say hello.' },
    ]);
    expect(body).not.toHaveProperty('tools');
  });

  it('maps generation settings and keeps the model configuration the agent was created with', async () => {
    ollama.setChat((body, res) => reply(body, res, [chunk('ok', true)]));
    const live = provider({ OLLAMA_MODEL: 'qwen3:8b', OLLAMA_NUM_CTX: '8192' });
    const llm = new OllamaLlm({ provider: live });
    // A Settings change after the agent was created does not affect it.
    live.reconfigure(loadOllamaConfig({ OLLAMA_HOST: ollama.baseUrl, OLLAMA_MODEL: 'other:1b' }));
    const { run, session } = setup({
      llm,
      beforeModelCallback: ({ request }) => {
        request.config = {
          ...request.config,
          temperature: 0.2,
          topP: 0.9,
          topK: 40,
          maxOutputTokens: 64,
          stopSequences: ['END'],
          seed: 7,
          thinkingConfig: { includeThoughts: true },
        };
        return undefined;
      },
    });
    await run((await session()).id, 'x');
    expect(ollama.chats[0]).toMatchObject({
      model: 'qwen3:8b',
      think: true,
      options: {
        num_ctx: 8192,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        num_predict: 64,
        stop: ['END'],
        seed: 7,
      },
    });
  });
});

describe('B. streaming', () => {
  it('emits partial text events, then one final event; the session stores the text once', async () => {
    ollama.setChat((body, res) =>
      reply(body, res, [chunk('One, '), chunk('two, '), chunk('three.'), chunk('', true)]),
    );
    const { run, session, stored } = setup();
    const id = (await session()).id;
    const events = await run(id, 'Count to three.', { stream: true });

    const partial = events.filter((e) => e.partial);
    const final = events.filter((e) => !e.partial);
    expect(partial.map(textOf)).toEqual(['One, ', 'two, ', 'three.']);
    expect(final).toHaveLength(1);
    expect(textOf(final[0])).toBe('One, two, three.');
    expect(final[0]?.usageMetadata?.candidatesTokenCount).toBe(9);
    expect(ollama.chats[0]?.stream).toBe(true);

    const modelEvents = (await stored(id)).filter((e) => e.author === 'assistant');
    expect(modelEvents.map(textOf)).toEqual(['One, two, three.']);
  });
});

describe('C. tool calling (test-only calculator)', () => {
  const calculatorScript = (body: ChatBody, res: Parameters<typeof reply>[1]) => {
    const last = body.messages.at(-1) ?? {};
    if (last['role'] === 'tool') {
      const { result } = JSON.parse(last['content'] as string) as { result: number };
      return reply(body, res, [chunk(`125 multiplied by 48 is ${result}.`), chunk('', true)]);
    }
    // Phase 2 live fixture (Ollama 0.40.14): the tool call arrives in the first
    // of two chunks, with an id, an index and object arguments.
    return reply(body, res, [
      toolCallChunk('call_live_1', 'calculator', { operation: 'multiply', a: 125, b: 48 }),
      chunk('', true),
    ]);
  };

  for (const stream of [false, true]) {
    it(`executes the calculator and answers 6000 (${stream ? 'streaming' : 'non-streaming'})`, async () => {
      ollama.setChat(calculatorScript);
      const { tool, spy } = calculatorTool();
      const { run, session } = setup({
        llm: new OllamaLlm({ provider: provider({}, true) }),
        tools: [tool],
      });
      const events = await run(
        (await session()).id,
        'What is 125 multiplied by 48? Use the calculator tool.',
        { stream },
      );

      expect(spy).toHaveBeenCalledExactlyOnceWith({ operation: 'multiply', a: 125, b: 48 });
      const call = events.find((e) => e.content?.parts?.some((p) => p.functionCall));
      expect(call?.partial).toBeFalsy();
      expect(call?.content?.parts?.[0]?.functionCall).toEqual({
        id: 'call_live_1',
        name: 'calculator',
        args: { operation: 'multiply', a: 125, b: 48 },
      });
      const response = events.find((e) => e.content?.parts?.some((p) => p.functionResponse));
      expect(response?.content?.parts?.[0]?.functionResponse).toMatchObject({
        id: 'call_live_1',
        response: { result: 6000 },
      });
      expect(finalResponseText(events)).toBe('125 multiplied by 48 is 6000.');

      // Round 1 declared the tool with the Zod-derived schema; round 2 carried the call and the result.
      expect(ollama.chats).toHaveLength(2);
      expect(ollama.chats[0]?.tools?.[0]?.function).toMatchObject({
        name: 'calculator',
        parameters: {
          type: 'object',
          required: ['operation', 'a', 'b'],
          additionalProperties: false,
        },
      });
      expect(ollama.chats[1]?.messages.slice(-2)).toEqual([
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_live_1',
              type: 'function',
              function: { name: 'calculator', arguments: { operation: 'multiply', a: 125, b: 48 } },
            },
          ],
        },
        {
          role: 'tool',
          content: '{"result":6000}',
          tool_name: 'calculator',
          tool_call_id: 'call_live_1',
        },
      ]);
    });
  }

  it('fails closed on malformed arguments or unknown tools: nothing is executed', async () => {
    const { tool, spy } = calculatorTool();
    for (const call of [
      { name: 'calculator', args: '{"operation":' },
      { name: 'run_shell', args: { cmd: 'whoami' } },
    ]) {
      ollama.setChat((body, res) =>
        reply(body, res, [toolCallChunk('bad', call.name, call.args), chunk('', true)]),
      );
      const { run, session } = setup({
        llm: new OllamaLlm({ provider: provider({}, true) }),
        tools: [tool],
      });
      const events = await run((await session()).id, 'go');
      expect(errors(events)).toEqual(['OLLAMA_INVALID_TOOL_CALL']);
      expect(events.some((e) => e.content?.parts?.some((p) => p.functionCall))).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('arguments that fail the tool’s Zod schema are rejected by ADK and not executed', async () => {
    ollama.setChat((body, res) => {
      const last = body.messages.at(-1) ?? {};
      return last['role'] === 'tool'
        ? reply(body, res, [chunk('I could not compute that.', true)])
        : reply(body, res, [
            toolCallChunk('c1', 'calculator', { operation: 'power', a: 2, b: 3 }),
            chunk('', true),
          ]);
    });
    const { tool, spy } = calculatorTool();
    const { run, session } = setup({
      llm: new OllamaLlm({ provider: provider({}, true) }),
      tools: [tool],
    });
    const events = await run((await session()).id, 'go');
    expect(spy).not.toHaveBeenCalled();
    const response = events.find((e) => e.content?.parts?.some((p) => p.functionResponse));
    expect(JSON.stringify(response?.content?.parts?.[0]?.functionResponse?.response)).toContain(
      'error',
    );
  });

  it('the production provider (tool calling off) refuses tool requests', async () => {
    ollama.setChat((body, res) => reply(body, res, [chunk('x', true)]));
    const { tool, spy } = calculatorTool();
    const { run, session } = setup({ llm: new OllamaLlm({ provider: provider() }), tools: [tool] });
    const events = await run((await session()).id, 'go');
    expect(errors(events)).toEqual(['OLLAMA_UNSUPPORTED']);
    expect(ollama.chats).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('D. structured output', () => {
  const Plan = z.strictObject({
    topic: z.string().min(1),
    questions: z.array(z.string()).min(2).max(5),
  });
  const plan = { topic: 'heat pumps', questions: ['cost?', 'efficiency?'] };

  it('ADK outputSchema: the GenAI schema is converted for Ollama; valid output passes app validation', async () => {
    ollama.setChat((body, res) => reply(body, res, [chunk(JSON.stringify(plan), true)]));
    const { run, session } = setup({ outputSchema: Plan });
    const events = await run((await session()).id, 'Plan.');
    expect(ollama.chats[0]?.format).toMatchObject({
      type: 'object',
      properties: {
        topic: { type: 'string', minLength: 1 },
        questions: { type: 'array', minItems: 2, maxItems: 5 },
      },
      required: ['topic', 'questions'],
    });
    expect(structuredOutput(Plan).parse(finalResponseText(events))).toEqual({
      ok: true,
      value: plan,
    });
  });

  it('structuredOutput(): sends the lossless Zod JSON Schema and validates at the app boundary', async () => {
    const structured = structuredOutput(Plan);
    for (const [label, text, expected] of [
      ['valid, in a code fence', '```json\n' + JSON.stringify(plan) + '\n```', { ok: true }],
      [
        'missing field',
        JSON.stringify({ topic: 'x' }),
        { ok: false, error: expect.stringContaining('questions') },
      ],
      ['wrong type', JSON.stringify({ topic: 'x', questions: 'a, b' }), { ok: false }],
      ['extra field', JSON.stringify({ ...plan, extra: 1 }), { ok: false }],
    ] as const) {
      ollama.setChat((body, res) => reply(body, res, [chunk(text, true)]));
      const { run, session } = setup({ beforeModelCallback: structured.beforeModelCallback });
      const events = await run((await session()).id, 'Plan.');
      expect(ollama.chats[0]?.format, label).toEqual(structured.jsonSchema);
      expect(ollama.chats[0]?.format, label).toMatchObject({ additionalProperties: false });
      expect(structured.parse(finalResponseText(events)), label).toMatchObject(expected);
    }
  });

  it('a non-JSON reply becomes an error event: nothing reaches the session as a result', async () => {
    ollama.setChat((body, res) =>
      reply(body, res, [chunk('Sure! Here is a plan: research heat pumps.', true)]),
    );
    const structured = structuredOutput(Plan);
    const { run, session, stored } = setup({ beforeModelCallback: structured.beforeModelCallback });
    const id = (await session()).id;
    const events = await run(id, 'Plan.');
    expect(errors(events)).toEqual(['OLLAMA_INVALID_STRUCTURED_OUTPUT']);
    expect(finalResponseText(events)).toBeUndefined();
    expect(structured.parse(finalResponseText(events))).toMatchObject({ ok: false });
    expect((await stored(id)).some((e) => textOf(e).includes('Sure!'))).toBe(false);
  });
});

describe('E. cancellation', () => {
  it('aborting mid-stream aborts the Ollama HTTP request', async () => {
    ollama.setChat((_body, res) =>
      streamLines(res, [chunk('a'), chunk('b'), chunk('c'), chunk('', true)], 200),
    );
    const { run, session } = setup();
    const controller = new AbortController();
    const events = await run((await session()).id, 'go', {
      stream: true,
      signal: controller.signal,
      onEvent: () => controller.abort(),
    });
    await ollama.clientAborted();
    // ADK reports the abort as an event, not an exception.
    expect(errors(events)).toEqual(['INVOCATION_ABORTED']);
    expect(events.filter((e) => !e.partial && !e.errorCode)).toEqual([]);
  });

  it('aborting while a tool-call response streams: the tool never runs', async () => {
    const { tool, spy } = calculatorTool();
    ollama.setChat((_body, res) =>
      streamLines(
        res,
        [
          chunk('Let me calculate.'),
          toolCallChunk('c9', 'calculator', { operation: 'add', a: 1, b: 2 }),
          chunk('', true),
        ],
        200,
      ),
    );
    const { run, session } = setup({
      llm: new OllamaLlm({ provider: provider({}, true) }),
      tools: [tool],
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300); // after the tool-call line, before the final chunk
    const events = await run((await session()).id, 'go', {
      stream: true,
      signal: controller.signal,
    });
    await ollama.clientAborted();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy).not.toHaveBeenCalled();
    expect(events.some((e) => e.content?.parts?.some((p) => p.functionCall))).toBe(false);
    expect(errors(events)).toEqual(['INVOCATION_ABORTED']);
  });

  it('a run cancelled before it starts sends nothing to Ollama', async () => {
    ollama.setChat((body, res) => reply(body, res, [chunk('x', true)]));
    const { run, session } = setup();
    const controller = new AbortController();
    controller.abort();
    const events = await run((await session()).id, 'go', { signal: controller.signal });
    expect(ollama.chats).toHaveLength(0);
    expect(events.filter((e) => !e.errorCode)).toEqual([]);
  });
});

describe('F. session isolation', () => {
  it('independent sessions do not share conversation history', async () => {
    ollama.setChat((body, res) => reply(body, res, [chunk(`reply ${body.messages.length}`, true)]));
    const { run, session } = setup({ instruction: 'sys' });
    const a = (await session()).id;
    const b = (await session()).id;
    await run(a, 'secret for A');
    await run(a, 'second for A');
    await run(b, 'hello from B');

    const users = (i: number) =>
      ollama.chats[i]?.messages.filter((m) => m['role'] !== 'system').map((m) => m['content']);
    expect(users(1)).toEqual(['secret for A', 'reply 2', 'second for A']);
    expect(users(2)).toEqual(['hello from B']);
  });
});

describe('errors as ADK error events', () => {
  it.each([
    [
      'model not found',
      (b: ChatBody, res: Parameters<typeof json>[0]) =>
        json(res, { error: `model '${b.model}' not found` }, 404),
      'OLLAMA_MODEL_NOT_FOUND',
    ],
    [
      'model without tool support',
      (_b: ChatBody, res: Parameters<typeof json>[0]) =>
        json(res, { error: 'model does not support tools' }, 400),
      'OLLAMA_UNSUPPORTED',
    ],
    [
      'server error',
      (_b: ChatBody, res: Parameters<typeof json>[0]) => json(res, { error: 'boom' }, 500),
      'OLLAMA_HTTP_ERROR',
    ],
    [
      'connection dropped mid-stream',
      (_b: ChatBody, res: Parameters<typeof json>[0]) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify(chunk('partial'))}\n`);
        setTimeout(() => res.socket?.destroy(), 20);
      },
      expect.stringMatching(/OLLAMA_(UNAVAILABLE|INVALID_RESPONSE)/),
    ],
    [
      'malformed stream',
      (_b: ChatBody, res: Parameters<typeof json>[0]) => void streamLines(res, ['not json']),
      'OLLAMA_INVALID_RESPONSE',
    ],
  ])('%s', async (_label, handler, code) => {
    ollama.setChat(handler);
    const { run, session } = setup();
    expect(errors(await run((await session()).id, 'go', { stream: true }))).toEqual([code]);
  });

  it('times out', async () => {
    ollama.setChat(() => undefined); // never answers
    const { run, session } = setup({
      llm: new OllamaLlm({ provider: provider(), timeoutMs: 150 }),
    });
    expect(errors(await run((await session()).id, 'go'))).toEqual(['OLLAMA_TIMEOUT']);
  });

  it('Ollama unavailable', async () => {
    const offline = createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: 'http://127.0.0.1:9' }));
    const { run, session } = setup({ llm: new OllamaLlm({ provider: offline }) });
    expect(errors(await run((await session()).id, 'go'))).toEqual(['OLLAMA_UNAVAILABLE']);
  });

  it('unsupported content and settings are rejected before any request', async () => {
    ollama.setChat((body, res) => reply(body, res, [chunk('x', true)]));
    const cases: [ConstructorParameters<typeof LlmAgent>[0]['beforeModelCallback'], string][] = [
      [
        ({ request }) =>
          void request.contents.push({
            role: 'user',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
          }),
        'OLLAMA_UNSUPPORTED_CONTENT',
      ],
      [
        ({ request }) => void (request.config = { ...request.config, presencePenalty: 1 }),
        'OLLAMA_UNSUPPORTED_CONFIG',
      ],
      [
        ({ request }) =>
          void (request.config = {
            ...request.config,
            responseSchema: {
              type: 'OBJECT' as never,
              properties: { a: { type: 'BOGUS' as never } },
            },
          }),
        'OLLAMA_SCHEMA_CONVERSION',
      ],
    ];
    for (const [callback, code] of cases) {
      const { run, session } = setup({ beforeModelCallback: callback });
      expect(errors(await run((await session()).id, 'go'))).toEqual([code]);
    }
    expect(ollama.chats).toHaveLength(0);
  });
});
