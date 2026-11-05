import { ModelProviderError } from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import { createToolRegistry, createWebTools, defineTool, WebError } from '@rka/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSourceStore } from '../source-store.js';
import { loadResearchConfig } from './config.js';
import { interruptionOf, PAUSED_MESSAGE } from './failures.js';
import {
  cleanupDirs,
  DRAFT,
  EVIDENCE,
  fakeModel,
  fakeWeb,
  hang,
  harness,
  READY,
  steps,
  tempDbPath,
  waitFor,
} from './test-fixtures.js';
import { createResearchAgent } from './workflow.js';

/*
 * Workflow-level lifecycle tests: every task transition the research agent
 * can make, and every failure class in failures.ts. Storage-level transition
 * matrices live in packages/storage/src/lifecycle.test.ts.
 */

afterEach(cleanupDirs);

type H = ReturnType<typeof harness>;
const task = (h: H, id: string) => h.storage.tasks.require(id);
const info = (h: H, id: string) =>
  h.runtime.tasks.recoveryInfo(task(h, id), h.storage.steps.listByTask(id));
const logEvents = (h: H, id: string) => h.storage.logs.listByTask(id).map((l) => l.event);

describe('task lifecycle: start', () => {
  it('running → completed, with start and completion logged', async () => {
    const h = harness();
    const id = await h.start();
    expect(task(h, id).status).toBe('running');
    await h.runtime.tasks.whenIdle();
    expect(task(h, id)).toMatchObject({ status: 'completed', error: null });
    const events = logEvents(h, id);
    expect(events[0]).toBe('task.started');
    expect(events.at(-1)).toBe('task.completed');
    expect(events.filter((e) => e === 'step.started')).toHaveLength(14);
    expect(events.filter((e) => e === 'step.completed')).toHaveLength(14);
  });

  it('refuses to start when Ollama is unreachable; no task is created', async () => {
    const model = fakeModel();
    model.state.health = {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      checkedAt: READY.checkedAt,
      status: 'unreachable',
      reason: 'unavailable',
      error: 'connect ECONNREFUSED',
    };
    const h = harness({ model });
    const outcome = await h.runtime.tasks.startResearch({ goal: 'A valid research goal' });
    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Ollama is not reachable at http:\/\/127\.0\.0\.1:11434/),
    });
    expect(h.storage.tasks.list()).toHaveLength(0);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('refuses to start when the model is not installed', async () => {
    const model = fakeModel();
    model.state.health = {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:8b',
      checkedAt: READY.checkedAt,
      status: 'model-missing',
      serverVersion: '0.12.0',
      installedModels: [],
    };
    const h = harness({ model });
    expect(await h.runtime.tasks.startResearch({ goal: 'A valid research goal' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/ollama pull qwen3:8b/),
    });
    expect(h.storage.tasks.list()).toHaveLength(0);
  });
});

describe('task lifecycle: pause, resume, cancel', () => {
  it('running → interrupted (paused) → running → completed', async () => {
    const model = fakeModel({ 'compare-findings': hang });
    const h = harness({ model });
    const id = await h.start();
    await waitFor(() => model.calls('compare-findings') > 0);
    expect(h.runtime.tasks.pause(id)).toMatchObject({ ok: true });
    await h.runtime.tasks.whenIdle();
    expect(task(h, id)).toMatchObject({ status: 'interrupted', error: PAUSED_MESSAGE });
    expect(interruptionOf(task(h, id))?.kind).toBe('paused');
    expect(info(h, id)).toMatchObject({ paused: true, resumable: true, retryable: false });

    // A paused task cannot be paused again or retried.
    expect(h.runtime.tasks.pause(id)).toMatchObject({ ok: false });
    expect(h.runtime.tasks.retry(id)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Only failed tasks/),
    });

    const fixed = harness({ storage: h.storage });
    expect(fixed.runtime.tasks.resume(id)).toMatchObject({ ok: true });
    await fixed.runtime.tasks.whenIdle();
    expect(task(h, id)).toMatchObject({ status: 'completed', error: null });
    // Completed steps before the paused one were not repeated.
    expect(fixed.model.calls('create-plan')).toBe(0);
    expect(fixed.model.calls('extract-evidence')).toBe(0);
    expect(logEvents(h, id)).toEqual(
      expect.arrayContaining(['task.paused', 'task.resumed', 'task.completed']),
    );
  });

  it('running → cancelled; a cancelled task cannot be resumed, retried or paused', async () => {
    const h = harness({ model: fakeModel({ 'write-report': hang }) });
    const id = await h.start();
    await waitFor(() => h.model.calls('write-report') > 0);
    expect(h.runtime.tasks.cancel(id)).toMatchObject({ ok: true });
    await h.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('cancelled');
    expect(logEvents(h, id)).toContain('task.cancelled');
    expect(h.runtime.tasks.resume(id)).toMatchObject({ ok: false });
    expect(h.runtime.tasks.retry(id)).toMatchObject({ ok: false });
    expect(h.runtime.tasks.pause(id)).toMatchObject({ ok: false });
  });

  it('interrupted (paused) → cancelled, logged as a user action', async () => {
    const h = harness({ model: fakeModel({ 'write-report': hang }) });
    const id = await h.start();
    await waitFor(() => h.model.calls('write-report') > 0);
    h.runtime.tasks.pause(id);
    await h.runtime.tasks.whenIdle();
    expect(h.runtime.tasks.cancel(id)).toMatchObject({ ok: true, task: { status: 'cancelled' } });
    const last = h.storage.logs.listByTask(id).at(-1);
    expect(last).toMatchObject({
      event: 'task.cancelled',
      message: expect.stringMatching(/not running/),
    });
  });

  it('refuses to resume a running or completed task, and to resume twice', async () => {
    const h = harness({ model: fakeModel({ 'write-report': hang }) });
    const id = await h.start();
    await waitFor(() => h.model.calls('write-report') > 0);
    expect(h.runtime.tasks.resume(id)).toMatchObject({ ok: false }); // running
    h.runtime.tasks.pause(id);
    await h.runtime.tasks.whenIdle();

    const fresh = harness({ storage: h.storage });
    expect(fresh.runtime.tasks.resume(id)).toMatchObject({ ok: true });
    expect(fresh.runtime.tasks.resume(id)).toMatchObject({ ok: false }); // already running again
    await fresh.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('completed');
    expect(fresh.runtime.tasks.resume(id)).toMatchObject({ ok: false }); // completed
    expect(fresh.runtime.tasks.retry(id)).toMatchObject({ ok: false });
    expect(fresh.model.calls('write-report')).toBe(1);
  });

  it('marks tasks interrupted at startup recovery and logs it', async () => {
    const path = tempDbPath();
    const first = openStorage({ path });
    const h1 = harness({ storage: first, model: fakeModel({ 'compare-findings': hang }) });
    const id = await h1.start();
    await waitFor(() => h1.model.calls('compare-findings') > 0);
    first.close();

    const second = openStorage({ path });
    second.recovery.recoverInterruptedTasks();
    const h2 = harness({ storage: second });
    expect(interruptionOf(second.tasks.require(id))?.kind).toBe('app-closed');
    expect(second.logs.listByTask(id).at(-1)).toMatchObject({
      event: 'task.recovered',
      level: 'warn',
    });
    expect(info(h2, id)).toMatchObject({ resumable: true, interruption: { kind: 'app-closed' } });
    h2.runtime.tasks.resume(id);
    await h2.runtime.tasks.whenIdle();
    expect(second.tasks.require(id).status).toBe('completed');
    expect(h2.model.calls('extract-evidence')).toBe(0);
    second.close();
  });
});

describe('task lifecycle: failure → retry', () => {
  it('a malformed report fails the task; Retry runs only the failed step', async () => {
    let broken = true;
    const model = fakeModel({
      'write-report': () => (broken ? 'Sorry, I cannot do that.' : DRAFT),
    });
    const h = harness({ model });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(task(h, id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/Write report\) failed: The model's answer was not valid/),
    });
    const report = h.storage.steps.listByTask(id).find((s) => s.kind === 'report');
    expect(report).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^\[malformed-output\]/),
    });
    expect(info(h, id)).toMatchObject({ retryable: true, failedSteps: 1 });
    expect(logEvents(h, id)).toEqual(
      expect.arrayContaining(['model.retry', 'model.failed', 'task.failed']),
    );

    broken = false;
    const before = { plan: model.calls('create-plan'), evidence: model.calls('extract-evidence') };
    expect(h.runtime.tasks.retry(id)).toMatchObject({
      ok: true,
      task: { status: 'running', error: null },
    });
    await h.runtime.tasks.whenIdle();
    expect(task(h, id)).toMatchObject({ status: 'completed', error: null });
    expect(model.calls('create-plan')).toBe(before.plan);
    expect(model.calls('extract-evidence')).toBe(before.evidence);
    expect(h.storage.reports.listByTask(id)).toHaveLength(1);
    expect(logEvents(h, id)).toContain('task.retry');
  });

  it('when every source failed, Retry fetches them again', async () => {
    const down = () => [
      new WebError('http-error', 'HTTP 503', 503),
      new WebError('http-error', 'HTTP 503', 503),
    ];
    const web = fakeWeb({
      failUrls: {
        'https://a.example/heat': down(),
        'https://b.example/cold': down(),
        'https://c.example/cost': down(),
      },
    });
    const h = harness({ web });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('failed');
    const failedFetches = h.storage.steps.listByTask(id).filter((s) => s.kind === 'fetch');
    expect(failedFetches.map((s) => s.error)).toEqual([
      '[http-error-5xx] HTTP 503',
      '[http-error-5xx] HTTP 503',
      '[http-error-5xx] HTTP 503',
    ]);
    expect(info(h, id)).toMatchObject({ retryable: true, failedSteps: 4 }); // 3 fetch + analyze

    // The sites are back (each failure list is used up).
    expect(h.runtime.tasks.retry(id)).toMatchObject({ ok: true });
    await h.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('completed');
    expect(steps(h.storage, id).every((s) => s.endsWith(':completed'))).toBe(true);
  });

  it('refuses Retry when nothing can run again', async () => {
    const h = harness();
    const plain = h.storage.tasks.create({ title: 'Other', input: { kind: 'other' } });
    expect(h.runtime.tasks.retry(plain.id)).toMatchObject({ ok: false });
    const id = await h.start();
    expect(h.runtime.tasks.retry(id)).toMatchObject({ ok: false }); // running
    await h.runtime.tasks.whenIdle();
  });
});

describe('environment failures: wait, then resume', () => {
  it('Ollama stops mid-run → interrupted (waiting for Ollama) → resume continues', async () => {
    const model = fakeModel({
      // Ollama stops while the analysis runs: this and every later call fail with "unavailable".
      'compare-findings': () => {
        model.state.down = true;
        throw new ModelProviderError('unavailable', 'connection reset');
      },
    });
    const h = harness({ model });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();

    const t = task(h, id);
    expect(t.status).toBe('interrupted');
    expect(interruptionOf(t)).toMatchObject({ kind: 'model-unavailable' });
    expect(t.error).toMatch(/^Waiting for Ollama: .*Start Ollama/);
    const analyze = h.storage.steps.listByTask(id).find((s) => s.kind === 'analyze');
    expect(analyze?.status).toBe('interrupted');
    expect(logEvents(h, id)).toContain('task.waiting');
    expect(info(h, id)).toMatchObject({ resumable: true, retryable: false });

    model.state.down = false;
    const fixed = harness({ storage: h.storage });
    expect(fixed.runtime.tasks.resume(id)).toMatchObject({ ok: true });
    await fixed.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('completed');
    expect(fixed.model.calls('extract-evidence')).toBe(0);
  });

  it('two different sites unreachable → offline; resume re-queues the transient failure', async () => {
    const web = fakeWeb();
    web.state.offline = true;
    const h = harness({ web });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();

    const t = task(h, id);
    expect(t.status).toBe('interrupted');
    expect(interruptionOf(t)?.kind).toBe('offline');
    expect(t.error).toMatch(/^Waiting for the internet connection: 2 different sites/);
    // First source: failed (recorded, not hidden); its evidence step skipped with a reason.
    expect(steps(h.storage, id).slice(4, 7)).toEqual([
      '5:fetch:failed',
      '6:evidence:skipped',
      '7:fetch:interrupted',
    ]);

    web.state.offline = false;
    const back = harness({ storage: h.storage, web });
    expect(back.runtime.tasks.resume(id)).toMatchObject({ ok: true });
    await back.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('completed');
    expect(steps(h.storage, id).every((s) => s.endsWith(':completed'))).toBe(true);
    const resumed = h.storage.logs.listByTask(id).find((l) => l.event === 'task.resumed');
    expect(resumed?.data).toMatchObject({ requeuedSteps: 2 });
  });

  it('SearXNG unreachable → interrupted (waiting for SearXNG)', async () => {
    const web = fakeWeb();
    web.state.searchDown = true;
    const h = harness({ web });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(interruptionOf(task(h, id))).toMatchObject({
      kind: 'search-unavailable',
      message: expect.stringMatching(/Start SearXNG/),
    });
    expect(steps(h.storage, id).slice(0, 2)).toEqual(['1:plan:completed', '2:search:interrupted']);

    web.state.searchDown = false;
    const back = harness({ storage: h.storage, web });
    back.runtime.tasks.resume(id);
    await back.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('completed');
  });

  it('SearXNG up but all engines unreachable → waiting for the internet connection', async () => {
    const web = fakeWeb();
    web.state.enginesDown = true;
    const h = harness({ web });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(interruptionOf(task(h, id))?.kind).toBe('offline');
  });
});

describe('malformed model output', () => {
  it('accepts JSON wrapped in think tags and code fences', async () => {
    const model = fakeModel({
      'review-report': () => '<think>checking</think>\nHere you go:\n```json\n{"verdicts":[]}\n```',
    });
    const h = harness({ model });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('completed');
    expect(model.calls('review-report')).toBe(1);
  });

  it('malformed evidence for one source fails that source only, and the report says so', async () => {
    const model = fakeModel({
      'extract-evidence': (prompt) =>
        prompt.includes('url="https://b.example/cold"')
          ? '{"relevant": "maybe"'
          : EVIDENCE[Object.keys(EVIDENCE).find((u) => prompt.includes(`url="${u}"`)) ?? ''],
    });
    const h = harness({ model });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(task(h, id).status).toBe('completed');
    const evidenceB = h.storage.steps.listByTask(id).find((s) => s.seq === 10);
    expect(evidenceB).toMatchObject({
      kind: 'evidence',
      status: 'failed',
      error: expect.stringMatching(/^\[malformed-output\]/),
    });
    expect(h.storage.reports.latest(id)?.content).toContain(
      'Source not used: https://b.example/cold',
    );
    expect(task(h, id).output).toMatchObject({ failedSteps: 1 });
  });
});

describe('configurable retries and backoff', () => {
  function direct(limits: Record<string, number>, web = fakeWeb(), model = fakeModel()) {
    const storage = openStorage({ path: ':memory:' });
    const sleep = vi.fn((_ms: number, _signal: AbortSignal) => Promise.resolve());
    const tools = createToolRegistry(
      createWebTools({
        fetcher: web.fetcher,
        store: createSourceStore(storage),
        searchProvider: web.searchProvider,
      }),
    );
    const agent = createResearchAgent({
      storage,
      modelProvider: model.provider,
      tools,
      defaults: { retryBackoffMs: 100, ...limits },
      sleep,
    });
    return { storage, sleep, agent, web, model };
  }

  it('uses modelRetries and exponential backoff for model calls', async () => {
    const d = direct({ modelRetries: 3 }, fakeWeb(), fakeModel({ 'create-plan': () => 'nope' }));
    const t = await d.agent.start({ goal: 'A valid research goal' });
    await d.agent.whenIdle();
    expect(d.model.calls('create-plan')).toBe(4);
    expect(d.sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400]);
    const retries = d.storage.logs.listByTask(t.id).filter((l) => l.event === 'model.retry');
    expect(retries.map((r) => r.data)).toEqual([
      expect.objectContaining({ attempt: 1, of: 4, delayMs: 100 }),
      expect.objectContaining({ attempt: 2, of: 4, delayMs: 200 }),
      expect.objectContaining({ attempt: 3, of: 4, delayMs: 400 }),
    ]);
    d.storage.close();
  });

  it('toolRetries 0 makes one attempt per fetch', async () => {
    const web = fakeWeb({
      failUrls: { 'https://a.example/heat': [new WebError('timeout', 'slow')] },
    });
    const d = direct({ toolRetries: 0 }, web);
    await d.agent.start({ goal: 'A valid research goal' });
    await d.agent.whenIdle();
    expect(web.fetched.filter((u) => u.includes('a.example'))).toHaveLength(1);
    expect(d.sleep).not.toHaveBeenCalled();
    d.storage.close();
  });

  it('per-task limits override the configured defaults; unspecified ones keep them', async () => {
    const d = direct({ modelRetries: 0, maxSources: 2 });
    const t = await d.agent.start({ goal: 'A valid research goal', limits: { maxSources: 3 } });
    await d.agent.whenIdle();
    expect((t.input as { limits: Record<string, number> }).limits).toMatchObject({
      modelRetries: 0,
      maxSources: 3,
      retryBackoffMs: 100,
    });
    d.storage.close();
  });

  it('loads defaults from the environment and rejects invalid values', () => {
    expect(
      loadResearchConfig({
        RESEARCH_MODEL_RETRIES: '3',
        RESEARCH_RETRY_BACKOFF_MS: ' 250 ',
        RESEARCH_MAX_SOURCES: '',
      }),
    ).toEqual({ modelRetries: 3, retryBackoffMs: 250 });
    expect(loadResearchConfig({})).toEqual({});
    expect(() => loadResearchConfig({ RESEARCH_MODEL_RETRIES: '9' })).toThrow(
      /Invalid RESEARCH_MODEL_RETRIES/,
    );
    expect(() => loadResearchConfig({ RESEARCH_TOOL_RETRIES: 'two' })).toThrow(
      /Invalid RESEARCH_TOOL_RETRIES/,
    );
    expect(() => loadResearchConfig({ RESEARCH_MODEL_TIMEOUT_MS: '10' })).toThrow(
      /RESEARCH_MODEL_TIMEOUT_MS/,
    );
  });
});

describe('approval guard', () => {
  it('never runs a tool that needs approval; the task fails and the refusal is logged', async () => {
    const storage = openStorage({ path: ':memory:' });
    const web = fakeWeb();
    const execute = vi.fn(async () => ({ ok: true }));
    // A fetch_source replacement that claims external effects.
    const risky = defineTool({
      name: 'fetch_source',
      description: 'test',
      inputSchema: z.object({ url: z.string() }).loose(),
      outputSchema: z.object({ ok: z.boolean() }),
      timeoutMs: 1000,
      permissions: {
        network: 'public-web',
        filesystem: 'none',
        effects: 'external',
        requiresApproval: true,
      },
      execute,
    });
    const search = createWebTools({
      fetcher: web.fetcher,
      store: createSourceStore(storage),
      searchProvider: web.searchProvider,
    }).filter((t) => t.name === 'web_search');
    const agent = createResearchAgent({
      storage,
      modelProvider: fakeModel().provider,
      tools: createToolRegistry([...search, risky]),
      defaults: { retryBackoffMs: 0 },
    });
    const t = await agent.start({ goal: 'A valid research goal' });
    await agent.whenIdle();
    expect(execute).not.toHaveBeenCalled();
    expect(storage.tasks.require(t.id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/requires user approval and was not run/),
    });
    expect(storage.logs.listByTask(t.id).map((l) => l.event)).toContain('tool.refused');
    storage.close();
  });
});
