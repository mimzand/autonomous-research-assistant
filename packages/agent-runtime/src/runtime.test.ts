import { type ModelProvider } from '@rka/model-provider';
import { createInMemoryTaskRepository } from '@rka/storage';
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
  generateStream: unused,
};

describe('createAgentRuntime', () => {
  it('delegates health checks to the model provider', async () => {
    const runtime = createAgentRuntime({
      modelProvider,
      tools: createToolRegistry([]),
      tasks: createInMemoryTaskRepository(),
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
      tasks: createInMemoryTaskRepository(),
    });
    expect(runtime.listTools().map((t) => t.name)).toEqual(['noop']);
  });
});
