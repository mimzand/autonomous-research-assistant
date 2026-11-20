import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RESEARCH_ENGINE,
  parseResearchEngine,
  PINNED_ENGINE_KEY,
  pinnedEngine,
  RESEARCH_ENGINE_ENV,
  researchTaskModelsFor,
} from './research-engine.js';
import { taskModelsFor } from './task-models.js';

const provider = () => createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: '127.0.0.1:9' }));
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  vi.restoreAllMocks();
});

describe('research.engine flag', () => {
  it('defaults to legacy and accepts legacy/adk (trimmed, any case)', () => {
    expect(DEFAULT_RESEARCH_ENGINE).toBe('legacy');
    expect(parseResearchEngine(undefined)).toEqual({ engine: 'legacy' });
    expect(parseResearchEngine(' ')).toEqual({ engine: 'legacy' });
    expect(parseResearchEngine(' ADK ')).toEqual({ engine: 'adk' });
    expect(parseResearchEngine('Legacy')).toEqual({ engine: 'legacy' });
  });

  it('fails safe on unknown values', () => {
    for (const raw of ['gemini', 'true', 'x'.repeat(300)]) {
      const parsed = parseResearchEngine(raw);
      expect(parsed.engine).toBe('legacy');
      expect(parsed.warning).toMatch(/^Ignoring RESEARCH_ENGINE=/);
      expect(parsed.warning?.length).toBeLessThan(160);
    }
  });

  it('is independent of AGENT_ENGINE', () => {
    process.env['AGENT_ENGINE'] = 'adk';
    process.env[RESEARCH_ENGINE_ENV] = '';
    const log = vi.fn();
    const models = researchTaskModelsFor(provider(), { log });
    expect(pinnedEngine(models.capture())).toBe('legacy');
    process.env[RESEARCH_ENGINE_ENV] = 'adk';
    process.env['AGENT_ENGINE'] = 'legacy';
    expect(pinnedEngine(models.capture())).toBe('adk');
  });
});

describe('engine pinning in the task model capture', () => {
  it('legacy tasks store exactly what Phase 6 stored; ADK tasks add only the pin', () => {
    const p = provider();
    const legacy = researchTaskModelsFor(p, { readFlag: () => undefined, log: () => undefined });
    expect(legacy.capture()).toEqual(taskModelsFor(p).capture());
    const adk = researchTaskModelsFor(p, { readFlag: () => 'adk', log: () => undefined });
    const captured = adk.capture();
    expect(captured).toEqual({
      ...taskModelsFor(p).capture(),
      config: { ...(taskModelsFor(p).capture().config as object), [PINNED_ENGINE_KEY]: 'adk' },
    });
  });

  it('providerFor follows the stored pin, never the current flag', () => {
    const p = provider();
    let flag: string | undefined = 'adk';
    const models = researchTaskModelsFor(p, { readFlag: () => flag, log: () => undefined });
    const adkTask = models.capture();
    flag = 'legacy';
    const legacyTask = models.capture();
    flag = 'adk';
    expect(models.providerFor(legacyTask).constructor.name).toBe('OllamaProvider');
    flag = 'legacy';
    expect(models.providerFor(adkTask).constructor.name).toBe('LazyAdkResearchModel');
  });

  it('a stored engine this version does not know is never run on another engine', async () => {
    const p = provider();
    const models = researchTaskModelsFor(p, { readFlag: () => undefined, log: () => undefined });
    const captured = models.capture();
    const odd = {
      ...captured,
      config: { ...(captured.config as object), [PINNED_ENGINE_KEY]: 'v9' },
    };
    expect(pinnedEngine(odd)).toEqual({ unknown: 'v9' });
    const generate = vi.spyOn(p, 'generate');
    const model = models.providerFor(odd);
    await expect(model.generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /started with the research engine "v9".*not run with a different engine/,
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('when ADK cannot be loaded, the call fails visibly and nothing falls back to legacy', async () => {
    const p = provider();
    const snapshotGenerate = vi.fn();
    vi.spyOn(p, 'snapshot').mockImplementation(() => {
      const s = createOllamaProvider(p.currentConfig);
      s.generate = snapshotGenerate;
      return s;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const models = researchTaskModelsFor(p, {
      readFlag: () => 'adk',
      log: () => undefined,
      loadAdk: () => Promise.reject(new Error('Cannot find module /secret/engine.js')),
    });
    const model = models.providerFor(models.capture());
    const error = await model
      .generate({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/^The ADK research engine could not be started\./);
    expect((error as Error).message).not.toContain('/secret');
    expect(snapshotGenerate).not.toHaveBeenCalled();
    await expect(
      model.generateStream({ messages: [] })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('logs the engine a new task is pinned to', () => {
    const log = vi.fn();
    const models = researchTaskModelsFor(provider(), { readFlag: () => 'turbo', log });
    models.capture();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Ignoring RESEARCH_ENGINE="turbo"/));
  });
});
