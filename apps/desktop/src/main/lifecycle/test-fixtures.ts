/**
 * Phase 7.6 lifecycle acceptance: fixtures and the child-process entry used to
 * kill a REAL process at exact points of a Research task. Test-only (never
 * imported by the app; see security-guards.test.ts).
 *
 * The child runs the app's own Research wiring (createAgentRuntime, the real
 * OllamaProvider over HTTP to a fake Ollama in the parent, researchTaskModelsFor
 * with its engine pinning, SQLite on a temporary file) and is terminated with
 * SIGKILL — either by the parent while a model request is in flight, or by
 * itself at a fault-injection point. No other process is affected.
 */
import { writeFileSync } from 'node:fs';
import { createAgentRuntime, createSourceStore } from '@rka/agent-runtime';
import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import {
  createToolRegistry,
  createWebTools,
  type FetchedDocument,
  type WebFetcher,
  type WebSearchProvider,
} from '@rka/tools';
import { researchTaskModelsFor } from '@rka/agent-host';

export const GOAL = 'What does the Lindholm lighthouse look like and when was it built?';
export const LIMITS = { maxQuestions: 1, maxQueriesPerQuestion: 1, maxSources: 2 };

export const PAGES: Record<string, { title: string; text: string }> = {
  'https://one.example/history': {
    title: 'Lindholm lighthouse history',
    text: 'The Lindholm lighthouse was built in 1872 on the northern cape. It was automated in 1968.',
  },
  'https://two.example/today': {
    title: 'Lindholm lighthouse today',
    text: 'The Lindholm lighthouse is a white tower 31 metres tall with 140 steps.',
  },
};
const URLS = Object.keys(PAGES);

/** Replies of the fake Ollama, by the "Task: ..." line of the prompt. */
export function ollamaReply(task: string, user: string): unknown {
  switch (task) {
    case 'create-plan':
      return {
        title: 'Lindholm lighthouse',
        objective: 'Describe the Lindholm lighthouse and when it was built.',
        questions: [
          {
            question: 'When was it built and how does it look?',
            searchQueries: ['lindholm lighthouse'],
          },
        ],
      };
    case 'extract-evidence':
      return user.includes(`url="${URLS[0] ?? ''}"`)
        ? {
            relevant: true,
            summary: 'History.',
            claims: [
              {
                claim: 'Built in 1872.',
                quote: 'was built in 1872 on the northern cape',
                questions: ['q1'],
                confidence: 'high',
              },
            ],
          }
        : {
            relevant: true,
            summary: 'Today.',
            claims: [
              {
                claim: 'A white tower 31 metres tall.',
                quote: 'is a white tower 31 metres tall',
                questions: ['q1'],
                confidence: 'high',
              },
            ],
          };
    case 'compare-findings':
      return {
        findings: [
          {
            question: 'q1',
            statement: 'Built 1872; white 31 m tower.',
            evidence: ['E1', 'E2'],
            agreement: 'consistent',
          },
        ],
        contradictions: [],
        gaps: [],
      };
    case 'write-report':
      return {
        title: 'The Lindholm lighthouse',
        summary: [
          { text: 'The lighthouse was built in 1872.', evidence: ['E1'], certainty: 'high' },
        ],
        sections: [
          {
            heading: 'Appearance',
            paragraphs: [
              { text: 'It is a white tower 31 metres tall.', evidence: ['E2'], certainty: 'high' },
            ],
          },
        ],
      };
    case 'review-report':
      return {
        verdicts: [
          { id: 'P1', verdict: 'supported', note: 'ok' },
          { id: 'P2', verdict: 'supported', note: 'ok' },
        ],
      };
    default:
      return {};
  }
}

/** A scripted web (no network). `onFetch` runs before a page is returned. */
export function scriptedWeb(onFetch: (url: string) => void = () => undefined) {
  const searchProvider: WebSearchProvider = {
    id: 'searxng',
    checkHealth: () => Promise.reject(new Error('unused')),
    search: () =>
      Promise.resolve(
        URLS.map((url) => ({
          title: PAGES[url]?.title ?? url,
          url,
          snippet: 'snippet',
          engines: ['fixture'],
          publishedAt: null,
        })),
      ),
  };
  const fetcher: WebFetcher = {
    fetch(url): Promise<FetchedDocument> {
      onFetch(url);
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
        sha256: 'c'.repeat(64),
        retrievedAt: '2026-11-13T10:00:00.000Z',
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

export interface CrashChildArgs {
  readonly dbPath: string;
  /** Fake Ollama in the parent, e.g. "127.0.0.1:43210". */
  readonly host: string;
  /** The Research engine "Settings" selects when the task is created. */
  readonly engine: 'legacy' | 'adk';
  /** Kill this process when fetching this URL (during the web fetch). */
  readonly killOnFetch?: string;
  /** Kill this process right after the report row is inserted (during report save). */
  readonly killAfterReportInsert?: boolean;
}

/** Written just before a self-kill: on Windows the parent sees exit code 1, not a signal. */
export const killMarker = (dbPath: string) => `${dbPath}.killed`;

/** Terminates this process immediately; nothing after it runs. */
function die(dbPath: string): never {
  writeFileSync(killMarker(dbPath), 'self-kill');
  // POSIX: SIGKILL. Windows: Node maps it to TerminateProcess (exit code 1).
  process.kill(process.pid, 'SIGKILL');
  // Block until the signal lands, so no further write can happen.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
}

/** Child-process entry: starts one Research task and runs it until it is killed. */
export async function crashChildMain(args: CrashChildArgs): Promise<void> {
  const storage = openStorage({ path: args.dbPath });
  if (args.killAfterReportInsert) {
    const create = storage.reports.create.bind(storage.reports);
    storage.reports.create = (taskId, input) => {
      create(taskId, input);
      return die(args.dbPath);
    };
  }
  const provider = createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: args.host }));
  const web = scriptedWeb((url) => {
    if (url === args.killOnFetch) die(args.dbPath);
  });
  const runtime = createAgentRuntime({
    modelProvider: provider,
    tools: createToolRegistry(createWebTools({ ...web, store: createSourceStore(storage) })),
    storage,
    researchDefaults: { retryBackoffMs: 0 },
    taskModels: researchTaskModelsFor(provider, {
      readFlag: () => args.engine,
      log: () => undefined,
    }),
  });
  // Normal quit: Electron's will-quit handler closes the database, then the process exits.
  process.on('message', (message) => {
    if (message === 'quit') {
      storage.close();
      process.exit(0);
    }
  });
  const outcome = await runtime.tasks.startResearch({ goal: GOAL, limits: LIMITS });
  if (!outcome.ok) throw new Error(outcome.message);
  process.send?.({ taskId: outcome.task.id });
  await runtime.tasks.whenIdle();
  process.send?.({ finished: true });
}
