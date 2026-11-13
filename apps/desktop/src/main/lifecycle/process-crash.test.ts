/**
 * Phase 7.6: Research crash recovery with a REAL process.
 *
 * Each scenario starts a Research task in a child Node process (the app's own
 * Research wiring, see test-fixtures.ts) and ends that process at an exact
 * point: SIGKILL while a model request is in flight (the parent's fake Ollama
 * kills it on receipt), SIGKILL from inside the child at a fault-injection
 * point (web fetch, right after the report insert), or a normal quit
 * (will-quit closes SQLite, then the process exits). Then the parent
 * "restarts" with the app's startup path (openAppStorage → recovery), checks
 * the database, restarts again, and resumes with Settings now selecting the
 * other engine.
 *
 * Deterministic: fake Ollama on 127.0.0.1, scripted web, temporary databases.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAdkRuntime, type AdkRuntime } from '@rka/adk-runtime';
import { createAgentRuntime, createSourceStore } from '@rka/agent-runtime';
import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { type Storage } from '@rka/storage';
import { createToolRegistry, createWebTools } from '@rka/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databasePath, openAppStorage } from '../app-storage.js';
import { researchTaskInfo, researchTaskModelsFor } from '../research-engine.js';
import {
  killMarker,
  ollamaReply,
  PAGES,
  scriptedWeb,
  type CrashChildArgs,
} from './test-fixtures.js';

const ENGINES = ['legacy', 'adk'] as const;
const appDir = join(import.meta.dirname, '..', '..', '..');
const childEntry = join(import.meta.dirname, 'test-fixtures.ts');

// --- fake Ollama ---------------------------------------------------------------------------

let server: Server;
let host = '';
let requests: string[] = [];
/** What to do when a chat request for this task arrives (the response is then never sent). */
let onTask: { task: string; nth: number; action: (child: ChildProcess) => void } | null = null;
let current: ChildProcess | null = null;

const taskOf = (user: string) => /^Task: ([a-z-]+)/m.exec(user)?.[1] ?? 'unknown';
const json = (res: ServerResponse, value: unknown, status = 200) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.url === '/api/version') return json(res, { version: '0.40.14' });
      if (req.url === '/api/tags')
        return json(res, { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 1 }] });
      if (req.url === '/api/show')
        return json(res, { capabilities: ['completion'], model_info: {}, details: {} });
      if (req.url !== '/api/chat') return json(res, { error: 'not found' }, 404);
      const body = JSON.parse(raw) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      const task = taskOf(user);
      requests.push(task);
      if (onTask && current && task === onTask.task) {
        if (requests.filter((t) => t === task).length === onTask.nth) {
          onTask.action(current);
          return; // never answered: the process ends while the request is in flight
        }
      }
      json(res, {
        model: body.model,
        created_at: '2026-11-13T10:00:00Z',
        message: { role: 'assistant', content: JSON.stringify(ollamaReply(task, user)) },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 10,
        eval_count: 5,
        total_duration: 1_000_000,
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

// --- the child process -----------------------------------------------------------------------

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** Loads test-fixtures.ts through Vite (TS + workspace packages) in a plain Node child. */
function loaderFile(root: string): string {
  const file = join(root, 'loader.mjs');
  writeFileSync(
    file,
    [
      'const vite = await import(process.env.RKA_VITE);',
      // A dev server in middleware mode (no port) keeps the module graph open, so the
      // lazy ADK import inside loadAdkRuntime works like in the bundled app.
      "const server = await vite.createServer({ configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false } });",
      'const module = await server.ssrLoadModule(process.env.RKA_CHILD);',
      'await module.crashChildMain(JSON.parse(process.env.RKA_ARGS));',
      // The IPC channel would keep the process alive; end it explicitly.
      'process.exit(0);',
    ].join('\n'),
  );
  return file;
}

interface ChildRun {
  readonly taskId: string | null;
  readonly signal: NodeJS.Signals | null;
  readonly code: number | null;
  readonly finished: boolean;
  /** Ended by SIGKILL (POSIX) or TerminateProcess (Windows), without cleanup. */
  readonly abrupt: boolean;
}

function runChild(root: string, args: CrashChildArgs): Promise<ChildRun> {
  const vite = pathToFileURL(createRequire(join(appDir, 'package.json')).resolve('vite')).href;
  const child = fork(loaderFile(root), [], {
    cwd: appDir,
    env: {
      ...process.env,
      RKA_VITE: vite,
      RKA_CHILD: childEntry,
      RKA_ARGS: JSON.stringify(args),
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  current = child;
  let taskId: string | null = null;
  let finished = false;
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
  child.on('message', (m: { taskId?: string; finished?: boolean }) => {
    if (m.taskId) taskId = m.taskId;
    if (m.finished) finished = true;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not end in time. stderr: ${stderr.slice(-2000)}`));
    }, 90_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      current = null;
      // An abrupt end is SIGKILL on POSIX; on Windows a self-kill (TerminateProcess)
      // shows as exit code 1, so the child leaves a marker just before it.
      const selfKilled = existsSync(killMarker(args.dbPath));
      if (code && code !== 0 && !selfKilled)
        return reject(new Error(`child failed (${code}): ${stderr.slice(-2000)}`));
      resolve({ taskId, signal, code, finished, abrupt: signal === 'SIGKILL' || selfKilled });
    });
  });
}

// --- restart side ---------------------------------------------------------------------------

/** The app's Research wiring after a restart; Settings now select `engine`. */
function restart(storage: Storage, engine: 'legacy' | 'adk') {
  const provider = createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: host }));
  const adk = { generates: 0 };
  const loadAdk = async (): Promise<AdkRuntime> => {
    const runtime = await loadAdkRuntime();
    const Base = runtime.engine.AdkResearchModel;
    class Counting extends Base {
      override generate(...a: Parameters<InstanceType<typeof Base>['generate']>) {
        adk.generates++;
        return super.generate(...a);
      }
    }
    return { ...runtime, engine: { ...runtime.engine, AdkResearchModel: Counting } };
  };
  const runtime = createAgentRuntime({
    modelProvider: provider,
    tools: createToolRegistry(
      createWebTools({ ...scriptedWeb(), store: createSourceStore(storage) }),
    ),
    storage,
    researchDefaults: { retryBackoffMs: 0 },
    taskModels: researchTaskModelsFor(provider, {
      readFlag: () => engine,
      loadAdk,
      log: () => undefined,
    }),
  });
  return { runtime, adk };
}

const state = (storage: Storage, id: string) => ({
  task: storage.tasks.require(id).status,
  steps: storage.steps.listByTask(id).map((s) => `${s.kind}:${s.status}:${s.attempts}`),
  reports: storage.reports.listByTask(id).length,
  sources: storage.sources.listByTask(id).length,
});

interface Scenario {
  readonly name: string;
  readonly args?: Partial<CrashChildArgs>;
  readonly onTask?: { task: string; nth: number; action: 'kill' | 'quit' };
  /** The step that was running when the process ended. */
  readonly interrupted: string;
  /** Report rows present before resuming. */
  readonly reportsBefore: number;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'killed during model generation (write report)',
    onTask: { task: 'write-report', nth: 1, action: 'kill' },
    interrupted: 'report',
    reportsBefore: 0,
  },
  {
    name: 'killed during a web fetch',
    args: { killOnFetch: Object.keys(PAGES)[1] },
    interrupted: 'fetch',
    reportsBefore: 0,
  },
  {
    name: 'killed during evidence extraction',
    onTask: { task: 'extract-evidence', nth: 2, action: 'kill' },
    interrupted: 'evidence',
    reportsBefore: 0,
  },
  {
    name: 'killed during review',
    onTask: { task: 'review-report', nth: 1, action: 'kill' },
    interrupted: 'review',
    reportsBefore: 0,
  },
  {
    name: 'killed during report save (right after the report row was written)',
    args: { killAfterReportInsert: true },
    interrupted: 'save',
    reportsBefore: 1,
  },
  {
    name: 'normal quit while a model request is in flight (will-quit closes SQLite)',
    onTask: { task: 'compare-findings', nth: 1, action: 'quit' },
    interrupted: 'analyze',
    reportsBefore: 0,
  },
];

describe('Phase 7.6: real process interruption → restart → recovery → resume', () => {
  for (const engine of ENGINES) {
    for (const s of SCENARIOS) {
      it(`${engine}: ${s.name}`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'rka-crash-'));
        roots.push(root);
        const dbPath = databasePath(join(root, 'userData'));
        mkdirSync(dirname(dbPath), { recursive: true });
        requests = [];
        onTask = s.onTask
          ? {
              task: s.onTask.task,
              nth: s.onTask.nth,
              action: (child) =>
                s.onTask?.action === 'kill' ? child.kill('SIGKILL') : child.send('quit'),
            }
          : null;

        // 1. The task runs in another process, which ends abruptly (or quits).
        const run = await runChild(root, { dbPath, host, engine, ...s.args });
        onTask = null;
        expect(run.taskId, 'task created').not.toBeNull();
        expect(run.finished, 'the task never completed in the child').toBe(false);
        if (s.onTask?.action === 'quit') expect(run.code).toBe(0);
        else
          expect(
            run.abrupt,
            `ended abruptly (signal ${String(run.signal)}, code ${String(run.code)})`,
          ).toBe(true);
        const id = run.taskId as string;

        // 2. Restart: the app's startup path (migrations + recovery).
        const first = openAppStorage({ userDataDir: join(root, 'userData') });
        expect(first.recovery.interruptedTaskIds).toEqual([id]);
        expect(first.storage.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
        const recovered = state(first.storage, id);
        expect(recovered.task).toBe('interrupted');
        expect(recovered.steps.some((x) => x.includes(':running:'))).toBe(false);
        const crashed = first.storage.steps.listByTask(id).find((x) => x.status === 'interrupted');
        expect(crashed?.kind).toBe(s.interrupted);
        // Finished work stays finished, each step ran once.
        const done = first.storage.steps.listByTask(id).filter((x) => x.status === 'completed');
        expect(done.length).toBeGreaterThan(0);
        expect(done.every((x) => x.attempts === 1)).toBe(true);
        expect(recovered.reports).toBe(s.reportsBefore);
        const input = JSON.stringify(first.storage.tasks.require(id).input);
        expect(researchTaskInfo(first.storage.tasks.require(id).input)?.engine).toBe(engine);
        first.storage.close();

        // 3. Restart again before resuming: recovery is idempotent.
        const second = openAppStorage({ userDataDir: join(root, 'userData') });
        expect(second.recovery.interruptedTaskIds).toEqual([]);
        expect(state(second.storage, id)).toEqual(recovered);

        // 4. Resume with Settings now selecting the other engine.
        const other = engine === 'adk' ? 'legacy' : 'adk';
        const { runtime, adk } = restart(second.storage, other);
        requests = [];
        runtime.tasks.resume(id);
        await runtime.tasks.whenIdle();
        const final = state(second.storage, id);
        expect(final.task).toBe('completed');
        expect(final.reports).toBe(1); // never a second version
        expect(final.sources).toBe(2); // no duplicate sources
        expect(JSON.stringify(second.storage.tasks.require(id).input)).toBe(input);
        // The pinned engine ran the remaining model calls, not the current Settings.
        const modelCallsAfterResume = requests.filter((t) => t !== 'unknown').length;
        if (modelCallsAfterResume > 0) {
          expect(adk.generates > 0, 'ADK used after resume').toBe(engine === 'adk');
        }
        // Completed steps were not repeated.
        for (const step of done) {
          expect(second.storage.steps.get(step.id)?.attempts).toBe(1);
        }
        const report = second.storage.reports.listByTask(id)[0];
        expect((second.storage.tasks.require(id).output as { reportId: string }).reportId).toBe(
          report?.id,
        );
        expect(report?.content).toContain('via Local Ollama');
        expect(second.storage.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
        second.storage.close();
      }, 120_000);
    }
  }
});
