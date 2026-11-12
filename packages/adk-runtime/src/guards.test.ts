/*
 * The agent guard must reject every way an ADK agent could reach a cloud
 * model, execute code, touch the shell or file system, or call tools. The
 * prohibited classes are imported straight from @google/adk here (test code
 * only) to prove they are rejected when someone tries to use them.
 */
import {
  AgentTool,
  BuiltInCodeExecutor,
  ContainerCodeExecutor,
  FunctionTool,
  Gemini,
  GOOGLE_SEARCH,
  LocalEnvironment,
  LoopAgent,
  SequentialAgent,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import { describe, expect, it } from 'vitest';
import { InMemorySessionService, LlmAgent, type LlmResponse } from './adk.js';
import { AdkSecurityError, assertSafeAgent, createGuardedRunner } from './guards.js';
import { LocalLlm } from './local-llm.js';

class FakeLocalLlm extends LocalLlm {
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { content: { role: 'model', parts: [{ text: 'ok' }] } };
  }
}

const local = () => new FakeLocalLlm({ model: 'local-test' });
const agent = (extra: Partial<ConstructorParameters<typeof LlmAgent>[0]> = {}) =>
  new LlmAgent({ name: 'a', model: local(), instruction: 'x', ...extra });

const rejects = (build: () => unknown, message: RegExp) => {
  expect(() => assertSafeAgent(build() as LlmAgent)).toThrow(AdkSecurityError);
  expect(() => assertSafeAgent(build() as LlmAgent)).toThrow(message);
};

describe('assertSafeAgent', () => {
  it('accepts an LlmAgent with a local model and nothing else', () => {
    expect(() => assertSafeAgent(agent())).not.toThrow();
    expect(() => assertSafeAgent(agent({ subAgents: [agent({ name: 'b' })] }))).not.toThrow();
  });

  it('rejects model names, which ADK resolves to Gemini through its registry', () => {
    rejects(
      () => agent({ model: 'gemini-2.5-flash' }),
      /local model instance.*"gemini-2\.5-flash"/,
    );
    rejects(() => agent({ model: 'qwen3:8b' }), /local model instance/);
  });

  it('rejects an agent without its own model (ADK would fall back to a Gemini default)', () => {
    rejects(() => new LlmAgent({ name: 'a', instruction: 'x' }), /no model/);
  });

  it('rejects Google model instances', () => {
    rejects(
      () => agent({ model: new Gemini({ model: 'gemini-2.5-flash', apiKey: 'x' }) }),
      /Gemini/,
    );
  });

  it('rejects every code executor, including UnsafeLocalCodeExecutor', () => {
    rejects(() => agent({ codeExecutor: new UnsafeLocalCodeExecutor() }), /code executor/);
    rejects(() => agent({ codeExecutor: new BuiltInCodeExecutor() }), /code executor/);
    rejects(
      () => agent({ codeExecutor: new ContainerCodeExecutor({ image: 'python:3' }) }),
      /code executor/,
    );
  });

  it('rejects any tool: built-in Google tools, function tools and agent tools', () => {
    rejects(() => agent({ tools: [GOOGLE_SEARCH] }), /must not have tools/);
    const shell = new FunctionTool({
      name: 'run_shell',
      description: 'Runs a shell command',
      execute: () => Promise.resolve('never'),
    });
    rejects(() => agent({ tools: [shell] }), /must not have tools/);
    rejects(() => agent({ tools: [new AgentTool({ agent: agent({ name: 'inner' }) })] }), /tools/);
  });

  it('rejects unsafe sub-agents anywhere in the tree', () => {
    rejects(
      () =>
        agent({
          subAgents: [agent({ name: 'b', subAgents: [agent({ name: 'c', model: 'gemini-pro' })] })],
        }),
      /"a\/b\/c"/,
    );
    rejects(
      () =>
        agent({ subAgents: [agent({ name: 'b', codeExecutor: new UnsafeLocalCodeExecutor() })] }),
      /"a\/b".*code executor/,
    );
  });

  it('rejects non-LLM agents (workflow agents can wrap anything)', () => {
    rejects(() => new LoopAgent({ name: 'loop', subAgents: [agent()] }), /must be an LlmAgent/);
    rejects(
      () => new SequentialAgent({ name: 'seq', subAgents: [agent()] }),
      /must be an LlmAgent/,
    );
  });

  it('LocalEnvironment exists in ADK but nothing in the guarded surface accepts it', () => {
    // LocalEnvironment runs shell commands. It is not exported by the facade
    // (see security.test.ts) and agents cannot carry it: the guard only lets
    // through LlmAgents without tools or executors.
    expect(typeof LocalEnvironment).toBe('function');
    expect(Object.keys(agent())).not.toContain('environment');
  });
});

describe('Phase 3 guard rules', () => {
  it('accepts the OllamaLlm adapter as a local model', async () => {
    const { OllamaLlm } = await import('./ollama/ollama-llm.js');
    const { createOllamaProvider, loadOllamaConfig } = await import('@rka/model-provider');
    const llm = new OllamaLlm({ provider: createOllamaProvider(loadOllamaConfig({})) });
    expect(() => assertSafeAgent(agent({ model: llm }))).not.toThrow();
  });

  it('rejects outputKey (ADK would store unvalidated output in session state)', () => {
    rejects(() => agent({ outputKey: 'plan' }), /must not use outputKey/);
  });

  it('allowedTools admits exactly the listed tool instances (test-only)', () => {
    const calc = new FunctionTool({
      name: 'calculator',
      description: 'c',
      execute: () => Promise.resolve(1),
    });
    const other = new FunctionTool({
      name: 'calculator',
      description: 'c',
      execute: () => Promise.resolve(1),
    });
    expect(() => assertSafeAgent(agent({ tools: [calc] }), { allowedTools: [calc] })).not.toThrow();
    expect(() => assertSafeAgent(agent({ tools: [other] }), { allowedTools: [calc] })).toThrow(
      /must not have tools/,
    );
    expect(() =>
      assertSafeAgent(agent({ tools: [GOOGLE_SEARCH] }), { allowedTools: [calc] }),
    ).toThrow(/must not have tools/);
    // Still no code executors or cloud models, even with an allowlist.
    expect(() =>
      assertSafeAgent(agent({ tools: [calc], codeExecutor: new UnsafeLocalCodeExecutor() }), {
        allowedTools: [calc],
      }),
    ).toThrow(/code executor/);
  });
});

describe('createGuardedRunner', () => {
  it('builds a runner without plugins or artifact, memory and credential services', () => {
    const runner = createGuardedRunner({
      appName: 'test',
      agent: agent(),
      sessionService: new InMemorySessionService(),
    });
    expect(runner.artifactService).toBeUndefined();
    expect(runner.memoryService).toBeUndefined();
    expect(runner.credentialService).toBeUndefined();
    // PluginManager keeps its plugins in a private set.
    expect((runner.pluginManager as unknown as { plugins: Set<unknown> }).plugins.size).toBe(0);
  });

  it('refuses unsafe agents before a runner exists', () => {
    expect(() =>
      createGuardedRunner({
        appName: 'test',
        agent: agent({ codeExecutor: new UnsafeLocalCodeExecutor() }),
        sessionService: new InMemorySessionService(),
      }),
    ).toThrow(AdkSecurityError);
  });
});
