import { type ModelProvider } from '@rka/model-provider';
import { createInMemoryTaskRepository } from '@rka/storage';
import { createToolRegistry, defineTool } from '@rka/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgentRuntime } from './runtime.js';

const modelProvider: ModelProvider = {
  id: 'ollama',
  model: 'qwen3:8b',
  checkHealth: vi.fn(async () => ({
    status: 'ready' as const,
    provider: 'ollama' as const,
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    serverVersion: '0.40.14',
  })),
};

describe('createAgentRuntime', () => {
  it('delegates health checks to the model provider', async () => {
    const runtime = createAgentRuntime({
      modelProvider,
      tools: createToolRegistry([]),
      tasks: createInMemoryTaskRepository(),
    });
    await expect(runtime.getModelHealth()).resolves.toMatchObject({ status: 'ready' });
    expect(modelProvider.checkHealth).toHaveBeenCalledOnce();
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
