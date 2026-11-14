import { FunctionTool } from '@google/adk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Content, type GenaiSchema, type LlmRequest } from '../adk.js';
import { toChatMessages, toModelParts } from './messages.js';
import { toGenerateRequest } from './request.js';
import { genaiSchemaToJsonSchema } from './schema.js';

const S = (schema: Record<string, unknown>) => schema as GenaiSchema;
const request = (patch: Partial<LlmRequest> = {}): LlmRequest => ({
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  liveConnectConfig: {},
  toolsDict: {},
  ...patch,
});
const convert = (patch: Partial<LlmRequest> = {}) =>
  toGenerateRequest(request(patch), { model: 'qwen3:8b' });

describe('GenAI schema → JSON Schema', () => {
  it('converts types, nesting, required, enums and constraints', () => {
    expect(
      genaiSchemaToJsonSchema(
        S({
          type: 'OBJECT',
          description: 'A plan',
          properties: {
            title: { type: 'STRING', minLength: '1', maxLength: '80', pattern: '^[A-Z]' },
            count: { type: 'INTEGER', minimum: 1, maximum: 10 },
            score: { type: 'NUMBER', minimum: 0, exclusiveMinimum: true },
            done: { type: 'BOOLEAN' },
            kind: { type: 'STRING', enum: ['a', 'b'] },
            tags: { type: 'ARRAY', items: { type: 'STRING' }, minItems: '1', maxItems: '5' },
            nested: { type: 'OBJECT', properties: { x: { type: 'NUMBER' } }, required: ['x'] },
            note: { type: 'STRING', nullable: true },
            either: { anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }] },
          },
          required: ['title', 'count'],
          propertyOrdering: ['title'],
        }),
      ),
    ).toEqual({
      type: 'object',
      description: 'A plan',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Z]' },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        score: { type: 'number', exclusiveMinimum: 0 },
        done: { type: 'boolean' },
        kind: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
        nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        note: { type: ['string', 'null'] },
        either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      required: ['title', 'count'],
    });
  });

  it('converts what ADK actually derives from a Zod schema (FunctionTool declaration)', () => {
    const tool = new FunctionTool({
      name: 't',
      description: 'd',
      parameters: z.strictObject({
        q: z.string().min(3).max(50),
        n: z.int().min(1).max(5).optional(),
        k: z.enum(['a', 'b']),
        list: z.array(z.number()).max(3),
        maybe: z.string().nullable(),
      }),
      execute: () => Promise.resolve(null),
    });
    const declared = tool._getDeclaration();
    const json = genaiSchemaToJsonSchema(declared?.parameters ?? S({}));
    expect(json).toMatchObject({
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 3, maxLength: 50 },
        n: { type: 'integer', minimum: 1, maximum: 5 },
        k: { type: 'string', enum: ['a', 'b'] },
        list: { type: 'array', items: { type: 'number' }, maxItems: 3 },
      },
      required: ['q', 'k', 'list', 'maybe'],
    });
    // ADK's GenAI conversion drops additionalProperties; the adapter uses the
    // tool's own Zod schema instead when it has one (see request tests).
    expect(json).not.toHaveProperty('additionalProperties');
  });

  it('fails loudly on unsupported or invalid schemas', () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [
        { type: 'OBJECT', properties: { a: { type: 'DATE' } } },
        /properties\.a: unsupported type "DATE"/,
      ],
      [{ type: 'STRING', $ref: '#/x' }, /unsupported keyword "\$ref"/],
      [{ type: 'STRING', minLength: 'ten' }, /"minLength" must be a non-negative integer/],
      [{ type: 'ARRAY' }, /array without "items"/],
      [{ description: 'no type' }, /has no type/],
      [{ type: 'NUMBER', exclusiveMaximum: true }, /"exclusiveMaximum" needs "maximum"/],
      [{ type: 'STRING', enum: [] }, /"enum" must be a non-empty array/],
    ];
    for (const [schema, message] of bad) {
      expect(() => genaiSchemaToJsonSchema(S(schema))).toThrow(message);
    }
  });
});

describe('ADK contents → provider messages', () => {
  it('maps system instruction, text, function calls and responses in order with their ids', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'What is 125 × 48?' }] },
      {
        role: 'model',
        parts: [
          { text: 'Calling. ' },
          { functionCall: { id: 'call_1', name: 'calculator', args: { a: 125, b: 48 } } },
          { functionCall: { id: 'call_2', name: 'calculator', args: { a: 1, b: 2 } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call_1', name: 'calculator', response: { result: 6000 } } },
          { functionResponse: { id: 'call_2', name: 'calculator', response: { result: 3 } } },
        ],
      },
      { role: 'model', parts: [{ text: 'Thinking…', thought: true }, { text: 'It is 6000.' }] },
      { role: 'user', parts: [{ text: 'Thanks.' }, { text: 'Bye.' }] },
    ];
    expect(toChatMessages(contents, 'Be precise.')).toEqual([
      { role: 'system', content: 'Be precise.' },
      { role: 'user', content: 'What is 125 × 48?' },
      {
        role: 'assistant',
        content: 'Calling. ',
        toolCalls: [
          { id: 'call_1', name: 'calculator', arguments: { a: 125, b: 48 } },
          { id: 'call_2', name: 'calculator', arguments: { a: 1, b: 2 } },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'calculator', content: '{"result":6000}' },
      { role: 'tool', toolCallId: 'call_2', name: 'calculator', content: '{"result":3}' },
      // Thought parts are the model's own reasoning and are deliberately not sent back.
      { role: 'assistant', content: 'It is 6000.' },
      { role: 'user', content: 'Thanks.\n\nBye.' },
    ]);
  });

  it('accepts a system instruction given as Content or parts', () => {
    expect(toChatMessages([], { role: 'system', parts: [{ text: 'A' }, { text: 'B' }] })).toEqual([
      { role: 'system', content: 'A\n\nB' },
    ]);
  });

  it('rejects multimodal and other unsupported content instead of dropping it', () => {
    const reject = (contents: Content[], message: RegExp) =>
      expect(() => toChatMessages(contents)).toThrow(message);
    reject(
      [
        {
          role: 'user',
          parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'AA==' } }],
        },
      ],
      /inlineData/,
    );
    reject(
      [{ role: 'user', parts: [{ fileData: { fileUri: 'gs://x', mimeType: 'application/pdf' } }] }],
      /fileData/,
    );
    reject(
      [
        {
          role: 'model',
          parts: [{ executableCode: { code: 'print(1)', language: 'PYTHON' as never } }],
        },
      ],
      /executableCode/,
    );
    reject(
      [{ role: 'model', parts: [{ functionCall: { name: 'calculator', args: {} } }] }],
      /without an id/,
    );
    reject(
      [{ role: 'user', parts: [{ functionResponse: { name: 'calculator', response: {} } }] }],
      /without an id/,
    );
    reject(
      [{ role: 'model', parts: [{ functionCall: { id: 'x', name: 'bad name!', args: {} } }] }],
      /invalid function name/,
    );
    reject([{ role: 'tool', parts: [{ text: 'x' }] }], /unsupported role/);
    expect(() =>
      toChatMessages([], {
        role: 'system',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }],
      }),
    ).toThrow(/inlineData/);
  });

  it('builds ADK parts from a provider result', () => {
    expect(
      toModelParts({
        content: 'Done.',
        thinking: 'hmm',
        toolCalls: [{ id: 'c', name: 'calculator', arguments: { a: 1 } }],
      }),
    ).toEqual([
      { text: 'hmm', thought: true },
      { text: 'Done.' },
      { functionCall: { id: 'c', name: 'calculator', args: { a: 1 } } },
    ]);
  });
});

describe('ADK LlmRequest → provider request', () => {
  it('maps generation settings, thinking and timeouts', () => {
    const { request: req, timeoutMs } = convert({
      config: {
        temperature: 0.1,
        topP: 0.5,
        topK: 20,
        maxOutputTokens: 100,
        stopSequences: ['X'],
        seed: 3,
        candidateCount: 1,
        labels: { adk_agent_name: 'a' },
        httpOptions: { timeout: 1234 },
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    expect(req).toMatchObject({
      model: 'qwen3:8b',
      think: false,
      options: { temperature: 0.1, topP: 0.5, topK: 20, maxTokens: 100, stop: ['X'], seed: 3 },
    });
    expect(timeoutMs).toBe(1234);
    expect(convert({ config: { thinkingConfig: { thinkingBudget: 512 } } }).request.think).toBe(
      true,
    );
    expect(convert().request.think).toBe(false);
    expect(
      toGenerateRequest(request(), { model: 'm', contextLength: 16384 }).request.options,
    ).toEqual({ contextLength: 16384 });
  });

  it('rejects settings Ollama cannot honour', () => {
    const rejects = (config: LlmRequest['config'], message: RegExp) =>
      expect(() => convert({ config })).toThrow(message);
    rejects({ presencePenalty: 1 }, /presencePenalty/);
    rejects({ candidateCount: 2 }, /one candidate/);
    rejects(
      { httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com' } },
      /httpOptions\.baseUrl/,
    );
    rejects({ httpOptions: { headers: { 'x-goog-api-key': 'k' } } }, /httpOptions\.headers/);
    rejects({ toolConfig: { functionCallingConfig: {} } }, /toolConfig/);
    rejects({ tools: [{ googleSearch: {} }] }, /only function declarations/);
    rejects({ responseMimeType: 'text/x.enum' }, /not supported/);
    rejects({ responseJsonSchema: 'nope' }, /JSON Schema object/);
  });

  it('structured output: responseJsonSchema wins over responseSchema; JSON mime without schema → json mode', () => {
    const own = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    expect(
      convert({ config: { responseJsonSchema: own, responseSchema: S({ type: 'STRING' }) } }),
    ).toMatchObject({
      structured: true,
      request: { responseFormat: { type: 'json_schema', schema: own } },
    });
    expect(
      convert({ config: { responseMimeType: 'application/json' } }).request.responseFormat,
    ).toEqual({ type: 'json' });
    expect(convert().structured).toBe(false);
  });

  it('tool parameters come from the tool’s Zod schema when available (lossless)', () => {
    const tool = new FunctionTool({
      name: 'calculator',
      description: 'Calc',
      parameters: z.strictObject({ a: z.number().max(10) }),
      execute: () => Promise.resolve(null),
    });
    const declaration = tool._getDeclaration();
    if (!declaration) throw new Error('no declaration');
    const { request: req } = convert({
      config: { tools: [{ functionDeclarations: [declaration] }] },
      toolsDict: { calculator: tool },
    });
    expect(req.tools).toEqual([
      {
        name: 'calculator',
        description: 'Calc',
        parameters: {
          type: 'object',
          properties: { a: { type: 'number', maximum: 10 } },
          required: ['a'],
          additionalProperties: false,
        },
      },
    ]);
    // Without the tool instance the GenAI declaration is converted instead.
    expect(
      convert({ config: { tools: [{ functionDeclarations: [declaration] }] } }).request.tools?.[0]
        ?.parameters,
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'number', maximum: 10 } },
      required: ['a'],
    });
  });
});
