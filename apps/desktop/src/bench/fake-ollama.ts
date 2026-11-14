/**
 * Deterministic in-process fake Ollama for the benchmark's `fake` mode and its
 * tests. Answers the Research prompts with fixed valid JSON. Never loads a
 * model and never uses the GPU.
 */
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

const ANSWERS: Record<string, (user: string) => unknown> = {
  'create-plan': () => ({
    title: 'Lindholm lighthouse',
    objective: 'Find when it was built and its use today.',
    questions: [
      { question: 'When was it built and how is it used?', searchQueries: ['Lindholm lighthouse'] },
    ],
  }),
  'extract-evidence': (u) =>
    u.includes('lighthouse-history')
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
              claim: 'A museum today.',
              quote: 'Today the Lindholm lighthouse is a museum',
              questions: ['q1'],
              confidence: 'high',
            },
          ],
        },
  'compare-findings': () => ({
    findings: [
      {
        question: 'q1',
        statement: 'Built in 1872, now a museum.',
        evidence: ['E1', 'E2'],
        agreement: 'consistent',
      },
    ],
    contradictions: [],
    gaps: [],
  }),
  'write-report': () => ({
    title: 'Lindholm lighthouse',
    summary: [
      {
        text: 'The lighthouse was built in 1872 and is a museum today.',
        evidence: ['E1', 'E2'],
        certainty: 'high',
      },
    ],
    sections: [],
  }),
  'review-report': () => ({ verdicts: [{ id: 'P1', verdict: 'supported', note: 'ok' }] }),
};

export interface FakeOllama {
  readonly host: string;
  /** /api/chat bodies, in order (kept in memory only; for parity checks). */
  readonly chatBodies: unknown[];
  /** Requests whose response has not finished (0 when nothing is in flight). */
  openRequests(): number;
  /** Highest number of /api/chat requests that were open at the same time. */
  maxConcurrentChats(): number;
  close(): Promise<void>;
}

export async function startFakeOllama(options: { latencyMs?: number } = {}): Promise<FakeOllama> {
  const latency = options.latencyMs ?? 0;
  const chatBodies: unknown[] = [];
  let open = 0;
  let openChats = 0;
  let maxChats = 0;
  const server: Server = createServer((req, res) => {
    open++;
    res.on('close', () => open--);
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/version') return void res.end(JSON.stringify({ version: '0.40.14' }));
      if (req.url === '/api/tags') {
        return void res.end(
          JSON.stringify({ models: [{ name: 'qwen3:8b', capabilities: ['completion'] }] }),
        );
      }
      if (req.url === '/api/show') {
        return void res.end(JSON.stringify({ capabilities: ['completion'] }));
      }
      if (req.url !== '/api/chat') {
        res.statusCode = 404;
        return void res.end('{"error":"not found"}');
      }
      const body = JSON.parse(raw) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      chatBodies.push(body);
      openChats++;
      maxChats = Math.max(maxChats, openChats);
      res.on('close', () => openChats--);
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      const task = /^Task: ([a-z-]+)/m.exec(user)?.[1] ?? '';
      const answer = JSON.stringify(ANSWERS[task]?.(user) ?? {});
      const timer = setTimeout(() => {
        if (res.destroyed) return;
        res.end(
          JSON.stringify({
            model: body.model,
            message: { role: 'assistant', content: answer },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 100,
            eval_count: 20,
            total_duration: latency * 1e6,
            load_duration: 0,
          }),
        );
      }, latency);
      res.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    host: `127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatBodies,
    openRequests: () => open,
    maxConcurrentChats: () => maxChats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
