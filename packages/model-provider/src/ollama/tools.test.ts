import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ChatMessage, type GenerateRequest } from '../schemas.js';
import {
  TAGS_QWEN,
  chatChunk,
  jsonResponse,
  ndjsonResponse,
  routeFetch,
  testConfig,
} from '../testing/fixtures.js';
import { calculator, runToolLoop } from '../testing/tool-harness.js';
import {
  assistantToolCallMessage,
  defineTool,
  toolErrorMessage,
  toolResultMessage,
  validateToolArguments,
} from '../tools.js';
import { OllamaProvider, supportsToolCalling } from './provider.js';

const VERSION = '0.40.14';

/** Deterministic ids for calls the server sends without one. */
function ids() {
  let n = 0;
  return () => `gen_${++n}`;
}

function provider(routes: Parameters<typeof routeFetch>[0], allowToolCalls = true) {
  const { fetch, calls } = routeFetch({
    '/api/version': () => jsonResponse({ version: VERSION }),
    ...routes,
  });
  return {
    ollama: new OllamaProvider(testConfig, { fetch, allowToolCalls, newToolCallId: ids() }),
    calls,
    chatBodies: () =>
      calls.filter((c) => c.path === '/api/chat').map((c) => c.body as Record<string, unknown>),
  };
}

const toolCall = (name: string, args: unknown, extra: Record<string, unknown> = {}) => ({
  ...('id' in extra ? { id: extra['id'] } : {}),
  function: { name, arguments: args, ...('index' in extra ? { index: extra['index'] } : {}) },
});

/** A chat chunk whose assistant message carries tool calls. */
function toolChunk(calls: unknown[], done = false, content = '') {
  const chunk = chatChunk(content, done);
  return { ...chunk, message: { ...chunk.message, tool_calls: calls } };
}

const ask = (content: string): ChatMessage[] => [{ role: 'user', content }];
const request = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  messages: ask('What is 125 multiplied by 48? Use the calculator tool.'),
  tools: [calculator.tool.definition],
  ...extra,
});

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('tool definitions and messages on the wire', () => {
  it('serialises tool definitions in Ollama function format', async () => {
    const { ollama, chatBodies } = provider({
      '/api/chat': () => jsonResponse(chatChunk('ok', true)),
    });
    await ollama.generate(request());
    const [body] = chatBodies();
    expect(body?.['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'calculator',
          description: calculator.tool.definition.description,
          parameters: {
            type: 'object',
            properties: {
              operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
              a: { type: 'number', description: 'First operand' },
              b: { type: 'number', description: 'Second operand' },
            },
            required: ['operation', 'a', 'b'],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  it('serialises assistant tool calls and tool results in the history', async () => {
    const { ollama, chatBodies } = provider({
      '/api/chat': () => jsonResponse(chatChunk('6000', true)),
    });
    const call = {
      id: 'call_1',
      name: 'calculator',
      arguments: { operation: 'multiply', a: 125, b: 48 },
    };
    await ollama.generate(
      request({
        messages: [
          ...ask('125 * 48?'),
          { role: 'assistant', content: '', toolCalls: [call] },
          toolResultMessage(call, { result: 6000 }),
        ],
      }),
    );
    expect(chatBodies()[0]?.['messages']).toEqual([
      { role: 'user', content: '125 * 48?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'calculator', arguments: call.arguments },
          },
        ],
      },
      { role: 'tool', content: '{"result":6000}', tool_name: 'calculator', tool_call_id: 'call_1' },
    ]);
  });

  it('leaves requests without tools exactly as before (regression)', async () => {
    const { ollama, calls, chatBodies } = provider({
      '/api/chat': () => jsonResponse(chatChunk('hi', true)),
    });
    await ollama.generate({ messages: [{ role: 'system', content: 's' }, ...ask('hello')] });
    const [body] = chatBodies();
    expect(body).not.toHaveProperty('tools');
    expect(body?.['messages']).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'hello' },
    ]);
    // No version lookup for a plain text request.
    expect(calls.map((c) => c.path)).toEqual(['/api/chat']);
  });

  it('checks the server version once for tools plus structured output', async () => {
    const { ollama, calls, chatBodies } = provider({
      '/api/chat': () => jsonResponse(chatChunk('{}', true)),
    });
    await ollama.generate(
      request({ responseFormat: { type: 'json_schema', schema: { type: 'object' } } }),
    );
    expect(calls.filter((c) => c.path === '/api/version')).toHaveLength(1);
    expect(chatBodies()[0]).toMatchObject({
      format: { type: 'object' },
      tools: [expect.any(Object)],
    });
  });
});

describe('request validation', () => {
  const rejects = async (req: GenerateRequest, message: RegExp) => {
    const { ollama, calls } = provider({});
    await expect(ollama.generate(req)).rejects.toMatchObject({
      code: 'invalid-request',
      message: expect.stringMatching(message),
    });
    expect(calls).toEqual([]);
  };

  it('rejects malformed tool definitions', async () => {
    const parameters = { type: 'object' };
    await rejects(
      request({ tools: [{ name: '1bad name', description: 'd', parameters }] }),
      /Tool names/,
    );
    await rejects(request({ tools: [{ name: 'x', description: '', parameters }] }), /description/);
    await rejects(
      request({ tools: [{ name: 'x', description: 'd', parameters: { type: 'string' } }] }),
      /type "object"/,
    );
    await rejects(
      request({
        tools: [
          { name: 'x', description: 'd', parameters },
          { name: 'x', description: 'e', parameters },
        ],
      }),
      /Duplicate tool "x"/,
    );
  });

  it('rejects tool results without a matching tool call id', async () => {
    await rejects(
      request({
        messages: [
          ...ask('q'),
          { role: 'tool', toolCallId: 'nope', name: 'calculator', content: '1' },
        ],
      }),
      /unknown tool call id "nope"/,
    );
    await rejects(
      request({
        messages: [
          ...ask('q'),
          { role: 'tool', name: 'calculator', content: '1' } as unknown as ChatMessage,
        ],
      }),
      /messages/,
    );
  });

  it('rejects duplicate tool call ids in the history', async () => {
    const call = { id: 'c', name: 'calculator', arguments: {} };
    await rejects(
      request({
        messages: [...ask('q'), { role: 'assistant', content: '', toolCalls: [call, call] }],
      }),
      /Duplicate tool call id "c"/,
    );
  });
});

describe('tool calling is off unless the provider allows it', () => {
  it('refuses tool definitions and tool history before calling the server', async () => {
    const { ollama, calls } = provider(
      { '/api/chat': () => jsonResponse(chatChunk('x', true)) },
      false,
    );
    await expect(ollama.generate(request())).rejects.toMatchObject({
      code: 'unsupported',
      message: /not enabled/,
    });
    const call = { id: 'c', name: 'calculator', arguments: {} };
    await expect(
      drain(
        ollama.generateStream({
          messages: [
            ...ask('q'),
            { role: 'assistant', content: '', toolCalls: [call] },
            toolResultMessage(call, 1),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(calls).toEqual([]);
  });

  it('snapshots keep the setting', async () => {
    const { ollama } = provider({ '/api/chat': () => jsonResponse(chatChunk('x', true)) }, false);
    await expect(ollama.snapshot().generate(request())).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('tool calls in non-streaming responses', () => {
  it('parses a tool call with its server id and object arguments', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        jsonResponse(
          toolChunk(
            [
              toolCall(
                'calculator',
                { operation: 'multiply', a: 125, b: 48 },
                { id: 'call_x', index: 0 },
              ),
            ],
            true,
          ),
        ),
    });
    const result = await ollama.generate(request());
    expect(result.toolCalls).toEqual([
      { id: 'call_x', name: 'calculator', arguments: { operation: 'multiply', a: 125, b: 48 } },
    ]);
    expect(result.invalidToolCalls).toBeUndefined();
    expect(result.finishReason).toBe('stop');
    expect(result.usage.completionTokens).toBe(8);
  });

  it('keeps multiple calls in order and generates missing or duplicate ids', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        jsonResponse(
          toolChunk(
            [
              toolCall('calculator', { operation: 'add', a: 1, b: 2 }),
              toolCall('calculator', { operation: 'add', a: 3, b: 4 }, { id: 'dup' }),
              toolCall('calculator', { operation: 'add', a: 5, b: 6 }, { id: 'dup' }),
            ],
            true,
          ),
        ),
    });
    const result = await ollama.generate(request());
    expect(result.toolCalls?.map((c) => [c.id, c.arguments['a']])).toEqual([
      ['gen_1', 1],
      ['dup', 3],
      ['gen_2', 5],
    ]);
  });

  it('accepts arguments sent as a JSON string; reports malformed arguments', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        jsonResponse(
          toolChunk(
            [
              toolCall('calculator', '{"operation":"add","a":1,"b":2}', { id: 'a' }),
              toolCall('calculator', '{"operation":', { id: 'b' }),
              toolCall('calculator', [1, 2], { id: 'c' }),
              toolCall('calculator', 42, { id: 'd' }),
            ],
            true,
          ),
        ),
    });
    const result = await ollama.generate(request());
    expect(result.toolCalls).toEqual([
      { id: 'a', name: 'calculator', arguments: { operation: 'add', a: 1, b: 2 } },
    ]);
    expect(result.invalidToolCalls).toEqual([
      expect.objectContaining({
        id: 'b',
        reason: 'malformed-arguments',
        message: expect.stringContaining('not valid JSON'),
        rawArguments: '{"operation":',
      }),
      expect.objectContaining({
        id: 'c',
        reason: 'malformed-arguments',
        message: expect.stringContaining('JSON object'),
      }),
      expect.objectContaining({ id: 'd', reason: 'malformed-arguments' }),
    ]);
  });

  it('reports calls to tools that were not provided', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        jsonResponse(toolChunk([toolCall('run_shell', { cmd: 'rm -rf /' }, { id: 'x' })], true)),
    });
    const result = await ollama.generate(request());
    expect(result.toolCalls).toBeUndefined();
    expect(result.invalidToolCalls).toEqual([
      {
        id: 'x',
        name: 'run_shell',
        reason: 'unknown-tool',
        message: 'The model called "run_shell", which is not one of the provided tools.',
        rawArguments: '{"cmd":"rm -rf /"}',
      },
    ]);
  });

  it('rejects a response whose tool calls have no function name', async () => {
    const { ollama } = provider({
      '/api/chat': () => jsonResponse(toolChunk([{ function: { arguments: {} } }], true)),
    });
    await expect(ollama.generate(request())).rejects.toMatchObject({ code: 'invalid-response' });
  });
});

describe('tool calls in streaming responses', () => {
  it('streams text deltas and returns tool calls only in the final chunk', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        ndjsonResponse([
          chatChunk('Let me '),
          chatChunk('calculate.'),
          toolChunk([
            toolCall(
              'calculator',
              { operation: 'multiply', a: 125, b: 48 },
              { id: 's1', index: 0 },
            ),
          ]),
          chatChunk('', true),
        ]),
    });
    const chunks = await drain(ollama.generateStream(request()));
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'delta', content: 'Let me ' },
      { type: 'delta', content: 'calculate.' },
    ]);
    expect(chunks.at(-1)).toEqual({
      type: 'done',
      result: expect.objectContaining({
        content: 'Let me calculate.',
        toolCalls: [
          { id: 's1', name: 'calculator', arguments: { operation: 'multiply', a: 125, b: 48 } },
        ],
      }),
    });
  });

  it('collects calls spread over several chunks, including the done chunk', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        ndjsonResponse([
          toolChunk([toolCall('calculator', { operation: 'add', a: 1, b: 1 }, { index: 0 })]),
          toolChunk([toolCall('calculator', { operation: 'add', a: 2, b: 2 }, { index: 1 })]),
          toolChunk([toolCall('calculator', { operation: 'add', a: 3, b: 3 }, { index: 2 })], true),
        ]),
    });
    const done = (await drain(ollama.generateStream(request()))).at(-1);
    expect(done?.type === 'done' && done.result.toolCalls?.map((c) => c.arguments['a'])).toEqual([
      1, 2, 3,
    ]);
  });

  it('a call re-sent with the same index replaces the earlier, incomplete one', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        ndjsonResponse([
          toolChunk([toolCall('calculator', '{"operation":"multiply","a":125', { index: 0 })]),
          toolChunk([
            toolCall('calculator', { operation: 'multiply', a: 125, b: 48 }, { index: 0, id: 'z' }),
          ]),
          chatChunk('', true),
        ]),
    });
    const done = (await drain(ollama.generateStream(request()))).at(-1);
    expect(done).toMatchObject({
      type: 'done',
      result: { toolCalls: [{ id: 'z', arguments: { b: 48 } }] },
    });
    expect(done?.type === 'done' && done.result.invalidToolCalls).toBeUndefined();
  });

  it('never returns tool calls from a stream that ends early', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        ndjsonResponse([
          toolChunk([toolCall('calculator', { operation: 'add', a: 1, b: 2 }, { id: 'early' })]),
        ]),
    });
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const chunk of ollama.generateStream(request())) seen.push(chunk);
      })(),
    ).rejects.toMatchObject({ code: 'invalid-response', message: /ended before completion/ });
    expect(seen).toEqual([]);
  });

  it('never returns tool calls when the server reports an error mid-stream', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        ndjsonResponse([
          toolChunk([toolCall('calculator', { operation: 'add', a: 1, b: 2 }, { id: 'e' })]),
          { error: 'model crashed' },
        ]),
    });
    await expect(drain(ollama.generateStream(request()))).rejects.toMatchObject({
      code: 'http-error',
      message: /model crashed/,
    });
  });
});

describe('unsupported servers and models', () => {
  it('refuses tools on servers older than 0.3.0', async () => {
    const { ollama, chatBodies } = provider({
      '/api/version': () => jsonResponse({ version: '0.2.8' }),
    });
    await expect(ollama.generate(request())).rejects.toMatchObject({
      code: 'unsupported',
      message: /0\.3\.0 or newer \(found 0\.2\.8\)/,
    });
    expect(chatBodies()).toEqual([]);
    expect(supportsToolCalling('0.3.0')).toBe(true);
    expect(supportsToolCalling('0.2.99')).toBe(false);
  });

  it('maps a model without tool support (HTTP 400) to unsupported', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        jsonResponse(
          { error: 'registry.ollama.ai/library/gemma3:latest does not support tools' },
          400,
        ),
    });
    await expect(ollama.generate(request({ model: 'gemma3:latest' }))).rejects.toMatchObject({
      code: 'unsupported',
      status: 400,
    });
  });

  it('reports advertised tool support from /api/show', async () => {
    const show = (capabilities?: string[]) =>
      provider({
        '/api/tags': () => jsonResponse(TAGS_QWEN),
        '/api/show': () => jsonResponse(capabilities ? { capabilities } : {}),
      }).ollama;
    await expect(show(['completion', 'tools']).checkToolSupport()).resolves.toEqual({
      model: 'qwen3:8b',
      serverVersion: VERSION,
      serverSupportsTools: true,
      advertised: 'yes',
    });
    await expect(
      show(['completion', 'vision']).checkToolSupport('gemma3:latest'),
    ).resolves.toMatchObject({ advertised: 'no' });
    await expect(show().checkToolSupport()).resolves.toMatchObject({ advertised: 'unknown' });
  });
});

describe('cancellation and timeouts with tools', () => {
  it('a pre-cancelled request never reaches /api/chat', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ollama, chatBodies } = provider({
      '/api/chat': () => jsonResponse(chatChunk('x', true)),
    });
    await expect(ollama.generate(request(), { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(chatBodies()).toEqual([]);
  });
});

describe('tool helpers', () => {
  it('defineTool derives the JSON Schema; validateToolArguments applies the Zod schema', () => {
    const tool = defineTool({
      name: 'lookup',
      description: 'Look up',
      input: z.strictObject({ id: z.int().min(1) }),
    });
    expect(tool.definition.parameters).toMatchObject({ type: 'object', required: ['id'] });
    expect(validateToolArguments(tool, { id: 'c', name: 'lookup', arguments: { id: 3 } })).toEqual({
      ok: true,
      value: { id: 3 },
    });
    expect(
      validateToolArguments(tool, { id: 'c', name: 'lookup', arguments: { id: 0 } }),
    ).toMatchObject({ ok: false, message: /id:/ });
    expect(
      validateToolArguments(tool, { id: 'c', name: 'lookup', arguments: { id: 1, extra: true } }),
    ).toMatchObject({ ok: false });
    expect(
      validateToolArguments(tool, { id: 'c', name: 'other', arguments: { id: 1 } }),
    ).toMatchObject({ ok: false, message: /not "lookup"/ });
    expect(() => defineTool({ name: 'bad name', description: 'x', input: z.object({}) })).toThrow();
  });

  it('formats results, errors and the assistant turn (rejected calls get answerable ids)', () => {
    const call = { id: 'c1', name: 'calculator', arguments: { a: 1 } };
    expect(toolResultMessage(call, 'plain')).toEqual({
      role: 'tool',
      toolCallId: 'c1',
      name: 'calculator',
      content: 'plain',
    });
    expect(toolErrorMessage(call, 'nope').content).toBe('{"error":"nope"}');
    const message = assistantToolCallMessage({
      model: 'm',
      content: 'thinking aloud',
      finishReason: 'stop',
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalDurationMs: null,
        loadDurationMs: null,
      },
      toolCalls: [call],
      invalidToolCalls: [
        {
          id: 'c2',
          name: 'not a valid name!',
          reason: 'unknown-tool',
          message: 'x',
          rawArguments: '{}',
        },
      ],
    });
    expect(message).toEqual({
      role: 'assistant',
      content: 'thinking aloud',
      toolCalls: [call, { id: 'c2', name: 'invalid_tool', arguments: {} }],
    });
  });
});

describe('tool-calling harness (calculator)', () => {
  /**
   * A scripted model: asks for the calculator, then answers from the tool
   * result it receives. It reads the result from the request, so the test
   * proves the result really travelled back to the "model".
   */
  function scriptedModel(firstCalls: unknown[], streaming: boolean) {
    return (body: unknown) => {
      const messages = (body as { messages: { role: string; content: string }[] }).messages;
      const last = messages.at(-1);
      const reply =
        last?.role === 'tool'
          ? (() => {
              const results = messages
                .filter((m) => m.role === 'tool')
                .map((m) => JSON.parse(m.content) as { result?: number; error?: string });
              const answer = results.find((r) => r.result !== undefined);
              return answer
                ? chatChunk(`125 multiplied by 48 is ${answer.result}.`, true)
                : toolChunk(
                    [
                      toolCall(
                        'calculator',
                        { operation: 'multiply', a: 125, b: 48 },
                        { id: 'retry' },
                      ),
                    ],
                    true,
                  );
            })()
          : toolChunk(firstCalls, true);
      return streaming ? ndjsonResponse([chatChunk(''), { ...reply }]) : jsonResponse(reply);
    };
  }

  for (const stream of [false, true]) {
    it(`computes 125 × 48 = 6000 through a tool round trip (${stream ? 'streaming' : 'non-streaming'})`, async () => {
      const { ollama, chatBodies } = provider({
        '/api/chat': scriptedModel(
          [toolCall('calculator', { operation: 'multiply', a: 125, b: 48 }, { id: 'call_1' })],
          stream,
        ),
      });
      const run = await runToolLoop({
        provider: ollama,
        messages: ask('What is 125 multiplied by 48? Use the calculator tool.'),
        tools: [calculator],
        stream,
      });
      expect(run.final.content).toContain('6000');
      expect(run.rounds).toBe(2);
      expect(run.events).toEqual([
        {
          round: 1,
          kind: 'executed',
          name: 'calculator',
          callId: 'call_1',
          detail: { args: { operation: 'multiply', a: 125, b: 48 }, output: { result: 6000 } },
        },
      ]);
      const second = chatBodies()[1]?.['messages'] as unknown[];
      expect(second.at(-1)).toEqual({
        role: 'tool',
        content: '{"result":6000}',
        tool_name: 'calculator',
        tool_call_id: 'call_1',
      });
    });
  }

  it('does not execute calls with invalid arguments or unknown tools; the model gets the errors and retries', async () => {
    const { ollama, chatBodies } = provider({
      '/api/chat': scriptedModel(
        [
          toolCall('calculator', { operation: 'power', a: 125, b: 48 }, { id: 'bad_args' }),
          toolCall('run_shell', { cmd: 'whoami' }, { id: 'bad_tool' }),
          toolCall('calculator', '{oops', { id: 'bad_json' }),
        ],
        false,
      ),
    });
    const run = await runToolLoop({
      provider: ollama,
      messages: ask('125 * 48?'),
      tools: [calculator],
    });
    expect(run.events.map((e) => [e.round, e.kind, e.callId])).toEqual([
      [1, 'rejected', 'bad_args'],
      [1, 'rejected', 'bad_tool'],
      [1, 'rejected', 'bad_json'],
      [2, 'executed', 'retry'],
    ]);
    const errors = (
      chatBodies()[1]?.['messages'] as { role: string; content: string; tool_call_id?: string }[]
    ).filter((m) => m.role === 'tool');
    expect(errors.map((m) => m.tool_call_id)).toEqual(['bad_args', 'bad_tool', 'bad_json']);
    expect(errors.every((m) => m.content.includes('"error"'))).toBe(true);
    expect(run.final.content).toContain('6000');
  });

  it('stops after the round limit', async () => {
    const { ollama } = provider({
      '/api/chat': () =>
        jsonResponse(toolChunk([toolCall('calculator', { operation: 'add', a: 1, b: 1 })], true)),
    });
    await expect(
      runToolLoop({ provider: ollama, messages: ask('loop'), tools: [calculator], maxRounds: 2 }),
    ).rejects.toThrow(/after 2 rounds/);
  });
});
