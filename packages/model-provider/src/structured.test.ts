import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OllamaProvider } from './ollama/provider.js';
import { generateObject, toModelJsonSchema } from './structured.js';
import { chatChunk, jsonResponse, routeFetch, testConfig } from './testing/fixtures.js';

const Plan = z.object({
  topic: z.string(),
  subquestions: z.array(z.string()).min(1),
});

function providerReturning(content: string) {
  const { fetch, calls } = routeFetch({
    '/api/version': () => jsonResponse({ version: '0.40.14' }),
    '/api/chat': () => jsonResponse(chatChunk(content, true)),
  });
  return { ollama: new OllamaProvider(testConfig, { fetch }), calls };
}

const request = { messages: [{ role: 'user' as const, content: 'Plan research on heat pumps' }] };

describe('generateObject', () => {
  it('sends the schema and returns the validated object', async () => {
    const { ollama, calls } = providerReturning('{"topic":"Heat pumps","subquestions":["How?"]}');
    const { object, result } = await generateObject(ollama, request, Plan);

    expect(object).toEqual({ topic: 'Heat pumps', subquestions: ['How?'] });
    expect(result.finishReason).toBe('stop');
    const chat = calls.find((c) => c.path === '/api/chat');
    expect(chat?.body).toMatchObject({
      format: {
        type: 'object',
        properties: { topic: { type: 'string' }, subquestions: { type: 'array' } },
        required: ['topic', 'subquestions'],
      },
    });
  });

  it('rejects output that is not JSON', async () => {
    const { ollama } = providerReturning('Sure! Here is the plan...');
    await expect(generateObject(ollama, request, Plan)).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('valid JSON'),
    });
  });

  it('rejects JSON that does not match the schema', async () => {
    const { ollama } = providerReturning('{"topic":"Heat pumps","subquestions":[]}');
    await expect(generateObject(ollama, request, Plan)).rejects.toMatchObject({
      code: 'invalid-response',
      message: expect.stringContaining('subquestions'),
    });
  });
});

describe('toModelJsonSchema', () => {
  it('drops the $schema meta key', () => {
    const schema = toModelJsonSchema(z.object({ a: z.string() }));
    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({ type: 'object' });
  });
});
