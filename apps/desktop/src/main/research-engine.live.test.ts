/**
 * Live Research engine comparison (phase 7): the Research step machine with
 * the legacy and the ADK model engine against the configured Ollama server
 * and model. The web is a fixed set of fixture pages (no live websites); the
 * database is a temporary file. Compares workflow invariants and validated
 * outputs, never wording. Never pulls a model.
 *
 *   pnpm test:research:ollama
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime, createSourceStore } from '@rka/agent-runtime';
import {
  createOllamaProvider,
  loadOllamaConfig,
  type OllamaConfig,
  ollamaTransportOptionsFromEnv,
} from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import {
  createToolRegistry,
  createWebTools,
  type FetchedDocument,
  type WebFetcher,
  type WebSearchProvider,
} from '@rka/tools';
import { afterAll, describe, expect, it } from 'vitest';
import { researchTaskModelsFor, type ResearchEngine } from '@rka/agent-host';
/** Trusted ngrok tunnels from OLLAMA_NGROK_BYPASS_HOSTS (same rule as the app). */
const liveTransport = {
  ngrokBypassHosts: ollamaTransportOptionsFromEnv(process.env).ngrokBypassHosts,
};

const base = loadOllamaConfig(process.env);
const dir = mkdtempSync(join(tmpdir(), 'rka-research-live-'));
const storage = openStorage({ path: join(dir, 'research-live.db') });
afterAll(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});
const log = (label: string, value: unknown) =>
  console.info(`[research-live] ${label}: ${JSON.stringify(value)}`);

const PAGES: Record<string, { title: string; text: string }> = {
  'https://fixture.example/lighthouse-history': {
    title: 'The Lindholm lighthouse',
    text:
      'The Lindholm lighthouse was built in 1872 on the northern cape. ' +
      'Its light could be seen from 22 nautical miles away. ' +
      'The lighthouse was automated in 1968 and the last keeper left in 1969.',
  },
  'https://fixture.example/lighthouse-today': {
    title: 'Lindholm lighthouse today',
    text:
      'Today the Lindholm lighthouse is a museum that opens from May to September. ' +
      'The tower is 31 metres tall and has 140 steps.',
  },
};

function fixtureWeb() {
  const searchProvider: WebSearchProvider = {
    id: 'searxng',
    checkHealth: () => Promise.reject(new Error('unused')),
    search: () =>
      Promise.resolve(
        Object.entries(PAGES).map(([url, page]) => ({
          title: page.title,
          url,
          snippet: page.text.slice(0, 80),
          engines: ['fixture'],
          publishedAt: null,
        })),
      ),
  };
  const fetcher: WebFetcher = {
    fetch: (url): Promise<FetchedDocument> => {
      const page = PAGES[url];
      if (!page) return Promise.reject(new Error('not a fixture page'));
      return Promise.resolve({
        requestedUrl: url,
        finalUrl: url,
        canonicalUrl: url,
        redirects: [],
        status: 200,
        kind: 'html',
        contentType: 'text/html',
        byteLength: page.text.length,
        sha256: 'b'.repeat(64),
        retrievedAt: new Date().toISOString(),
        title: page.title,
        text: page.text,
        truncated: false,
        metadata: {},
        timings: { downloadMs: 1, extractMs: 1 },
      });
    },
  };
  return { searchProvider, fetcher };
}

function wire(engine: ResearchEngine, config: Partial<OllamaConfig> = {}) {
  const provider = createOllamaProvider({ ...base, ...config }, liveTransport);
  const web = fixtureWeb();
  return createAgentRuntime({
    modelProvider: provider,
    tools: createToolRegistry(createWebTools({ ...web, store: createSourceStore(storage) })),
    storage,
    researchDefaults: { retryBackoffMs: 500 },
    taskModels: researchTaskModelsFor(provider, { readFlag: () => engine, log: () => undefined }),
  });
}

const LIMITS = { maxQuestions: 1, maxQueriesPerQuestion: 1, maxSources: 2, modelRetries: 1 };
const GOAL = 'When was the Lindholm lighthouse built, and what is it used for today?';

describe(`live Research engines at ${base.baseUrl} (${base.model})`, () => {
  for (const engine of ['legacy', 'adk'] as const) {
    it(`${engine}: a bounded end-to-end task (plan, evidence, analysis, report, review)`, async () => {
      const runtime = wire(engine);
      const outcome = await runtime.tasks.startResearch({ goal: GOAL, limits: LIMITS });
      if (!outcome.ok) throw new Error(outcome.message);
      const id = outcome.task.id;
      await runtime.tasks.whenIdle();
      const task = storage.tasks.require(id);
      const steps = storage.steps.listByTask(id);
      const usage = storage.modelUsage.listByTask(id);
      const report = storage.reports.listByTask(id)[0];
      log(`${engine} task`, {
        status: task.status,
        error: task.error,
        steps: steps.map((s) => `${s.kind}:${s.status}:${s.attempts}`),
        usage: usage.map((u) => `${u.purpose}:${u.promptTokens}/${u.completionTokens}`),
      });
      expect(task.status, engine).toBe('completed');
      // The pinned engine is stored with the task.
      const pinned = (task.input as { model: { config: Record<string, unknown> } }).model.config[
        'researchEngine'
      ];
      expect(pinned ?? 'legacy', engine).toBe(engine);
      // Every model step produced a validated, stored output and one usage row per accepted call.
      const modelSteps = steps.filter((s) =>
        ['plan', 'evidence', 'analyze', 'report', 'review'].includes(s.kind),
      );
      expect(
        modelSteps.every((s) => s.status === 'completed' && s.output !== null),
        engine,
      ).toBe(true);
      for (const kind of ['plan', 'analyze', 'report', 'review']) {
        expect(
          usage.filter((u) => u.purpose === `research:${kind}`),
          `${engine} ${kind}`,
        ).toHaveLength(1);
      }
      expect(
        usage.every((u) => u.model === base.model && (u.completionTokens ?? 0) > 0),
        engine,
      ).toBe(true);
      // Grounding: the report cites only fixture sources.
      expect(report?.content, engine).toBeDefined();
      const links = [...(report?.content ?? '').matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
      expect(links.length, engine).toBeGreaterThan(0);
      expect(
        links.every((l) => l !== undefined && l in PAGES),
        engine,
      ).toBe(true);
      expect(storage.sqlite.prepare('select count(*) as n from adk_events').get()).toEqual({
        n: 0,
      });
    }, 900_000);

    it(`${engine}: cancellation during a model call`, async () => {
      const runtime = wire(engine);
      const outcome = await runtime.tasks.startResearch({ goal: GOAL, limits: LIMITS });
      if (!outcome.ok) throw new Error(outcome.message);
      const id = outcome.task.id;
      // The first step (plan) is a model call.
      for (let i = 0; i < 200; i++) {
        if (storage.steps.listByTask(id)[0]?.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(runtime.tasks.cancel(id)).toMatchObject({ ok: true });
      await runtime.tasks.whenIdle();
      const task = storage.tasks.require(id);
      log(`${engine} cancel`, {
        status: task.status,
        steps: storage.steps.listByTask(id).map((s) => s.status),
      });
      expect(task.status, engine).toBe('cancelled');
      expect(storage.reports.listByTask(id), engine).toEqual([]);
    });

    it(`${engine}: a missing model is refused before a task is created (nothing is downloaded)`, async () => {
      const runtime = wire(engine, { model: 'rka-live-test-missing-model:0' });
      const outcome = await runtime.tasks.startResearch({ goal: GOAL, limits: LIMITS });
      log(`${engine} missing model`, outcome);
      expect(outcome, engine).toMatchObject({
        ok: false,
        message: expect.stringMatching(/not installed/),
      });
    });
  }
});
