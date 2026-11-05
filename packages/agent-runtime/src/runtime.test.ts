import { type ModelProvider } from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import { createToolRegistry, defineTool } from '@rka/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from './runtime.js';

const health = {
  status: 'ready',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3:8b',
  checkedAt: '2026-11-04T12:00:00.000Z',
  serverVersion: '0.40.14',
  capabilities: ['completion', 'tools', 'thinking'],
  contextLength: 40960,
  structuredOutput: true,
} as const;

const unused = () => {
  throw new Error('not used in this test');
};

const modelProvider: ModelProvider = {
  id: 'ollama',
  defaultModel: 'qwen3:8b',
  checkHealth: vi.fn(async () => ({ ...health, capabilities: [...health.capabilities] })),
  checkModel: unused,
  generate: unused,
  generateStream: vi.fn(async function* () {
    yield { type: 'delta' as const, content: 'Hi' };
  }),
};

describe('createAgentRuntime', () => {
  it('delegates health checks to the model provider', async () => {
    const runtime = createAgentRuntime({
      modelProvider,
      tools: createToolRegistry([]),
      tasks: openStorage({ path: ':memory:' }).tasks,
    });
    const controller = new AbortController();
    await expect(runtime.getModelHealth(controller.signal)).resolves.toMatchObject({
      status: 'ready',
    });
    expect(modelProvider.checkHealth).toHaveBeenCalledWith({ signal: controller.signal });
  });

  it('exposes tool summaries from the registry', () => {
    const tool = defineTool({
      name: 'noop',
      description: 'Does nothing.',
      inputSchema: z.object({}),
      requiresApproval: false,
      execute: async () => undefined,
    });
    const runtime = createAgentRuntime({
      modelProvider,
      tools: createToolRegistry([tool]),
      tasks: openStorage({ path: ':memory:' }).tasks,
    });
    expect(runtime.listTools().map((t) => t.name)).toEqual(['noop']);
  });

  it('streams chat through the model provider with thinking off', async () => {
    const runtime = createAgentRuntime({
      modelProvider,
      tools: createToolRegistry([]),
      tasks: openStorage({ path: ':memory:' }).tasks,
    });
    const controller = new AbortController();
    const chunks = [];
    for await (const chunk of runtime.streamChat([{ role: 'user', content: 'Hello' }], {
      signal: controller.signal,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'delta', content: 'Hi' }]);
    expect(runtime.model).toBe('qwen3:8b');
    expect(modelProvider.generateStream).toHaveBeenCalledWith(
      { messages: [{ role: 'user', content: 'Hello' }], think: false },
      { signal: controller.signal },
    );
  });
});
