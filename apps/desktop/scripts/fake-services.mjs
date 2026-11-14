#!/usr/bin/env node
/**
 * Fake Ollama + fake SearXNG for MANUAL checks of the installed app (no real
 * model, no GPU, no internet). Dependency-free; listens on 127.0.0.1 only.
 *
 *   node apps/desktop/scripts/fake-services.mjs
 *
 * Then in the app: Settings → Ollama Connection → http://127.0.0.1:11435,
 * Settings → AI Models → use "fake-model:1b", and (for web search)
 * Settings → Research & Web Search → SearXNG URL http://127.0.0.1:8089.
 *
 * Behaviour:
 * - Chat without tools: streams a short reply slowly (so Stop can be tried).
 * - Chat with web search on and a message containing "search": the model calls
 *   web_search once, then answers from the (fake) results.
 * - A message containing "slow": the search answers after 10 s (try Stop).
 * - Research: the fake model cannot produce research plans; a task fails
 *   visibly at its first step (use a real model for a full research run).
 */
import { createServer } from 'node:http';

const OLLAMA_PORT = Number(process.env.FAKE_OLLAMA_PORT ?? 11435);
const SEARXNG_PORT = Number(process.env.FAKE_SEARXNG_PORT ?? 8089);
const MODEL = 'fake-model:1b';

const json = (res, value, status = 200) =>
  void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chunk = (content, done, extra = {}) =>
  `${JSON.stringify({
    model: MODEL,
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content, ...extra },
    done,
    ...(done && {
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 10,
      total_duration: 1e9,
    }),
  })}\n`;

async function streamText(res, text) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const word of text.split(/(?<= )/)) {
    if (res.destroyed) return;
    res.write(chunk(word, false));
    await sleep(150);
  }
  res.end(chunk('', true));
}

const ollama = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/api/version') return json(res, { version: '0.40.14' });
    if (req.url === '/api/tags')
      return json(res, { models: [{ name: MODEL, model: MODEL, size: 1_000_000, details: {} }] });
    if (req.url === '/api/show')
      return json(res, { capabilities: ['completion', 'tools'], model_info: {}, details: {} });
    if (req.url !== '/api/chat') return json(res, { error: 'not found' }, 404);

    const messages = body.messages ?? [];
    const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    const results = messages.filter((m) => m.role === 'tool');
    const offersSearch = (body.tools ?? []).some((t) => t.function?.name === 'web_search');
    console.log(`Ollama: chat (${offersSearch ? 'web_search offered' : 'no tools'})`);

    if (!body.stream) return json(res, JSON.parse(chunk('{}', true)));
    if (offersSearch && results.length === 0 && /search|slow/i.test(user)) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const query = user.replace(/\s+/g, ' ').trim().slice(0, 120);
      return res.end(
        chunk('', true, {
          tool_calls: [{ function: { name: 'web_search', arguments: { query } } }],
        }),
      );
    }
    if (results.length > 0) {
      return void streamText(
        res,
        'According to the (fake) search results, the answer is 42. Source: https://example.org/answer',
      );
    }
    return void streamText(
      res,
      'Hello from the fake Ollama server. This reply streams slowly so that you can press Stop.',
    );
  });
});

const searxng = createServer((req, res) => {
  const q = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('q') ?? '';
  console.log(`SearXNG: search "${q}"`);
  const reply = () =>
    json(res, {
      query: q,
      results: [1, 2, 3].map((i) => ({
        title: `Fake result ${i}`,
        url: `https://example.org/result-${i}`,
        content: `Fake snippet ${i} for "${q}".`,
        engines: ['fake'],
      })),
      unresponsive_engines: [],
    });
  if (/slow/i.test(q)) setTimeout(reply, 10_000);
  else reply();
});

ollama.listen(OLLAMA_PORT, '127.0.0.1', () =>
  console.log(`Fake Ollama:  http://127.0.0.1:${OLLAMA_PORT}  (model ${MODEL})`),
);
searxng.listen(SEARXNG_PORT, '127.0.0.1', () =>
  console.log(`Fake SearXNG: http://127.0.0.1:${SEARXNG_PORT}\nPress Ctrl+C to stop.`),
);
