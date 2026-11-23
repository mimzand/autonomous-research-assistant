/**
 * Stored Chat conversations at the ChatController boundary, with a real SQLite
 * database (in memory or on disk). The engine is a recorder: it captures exactly
 * the turns and preface the controller hands to whichever engine is selected.
 * The summarizer is a fake that records its input.
 */
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type GenerateChunk } from '@rka/model-provider';
import { type ChatEvent, type ChatTurn } from '@rka/shared';
import { openStorage, type Storage } from '@rka/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_CONTEXT_TURNS, summaryPreface } from './chat-context.js';
import { ChatController, type ChatEventSink } from './chat-controller.js';
import { type ChatEngine, type ChatEngineOptions } from './chat-engine.js';
import { SUMMARY_TURN_CHARS, type ChatSummarizer, type SummarizeRequest } from './chat-summary.js';

const MARKER = 'FIRST-REPLY-MARKER-7Q';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const done = (content: string): GenerateChunk => ({
  type: 'done',
  result: {
    model: 'qwen3:8b',
    content,
    finishReason: 'stop',
    usage: { promptTokens: 11, completionTokens: 7, totalDurationMs: 30, loadDurationMs: 0 },
  },
});

/** Resolves when `signal` aborts, including when it already has. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve());
  });

interface Recorded {
  readonly engine: ChatEngine['name'];
  readonly turns: ChatTurn[];
  readonly preface: string | undefined;
}

/** An engine that records its input and answers `reply(n)` (n = 1-based call). */
function recorder(
  name: ChatEngine['name'],
  calls: Recorded[],
  reply = (n: number) => `Reply ${n}`,
) {
  return {
    name,
    async *streamChat(turns: readonly ChatTurn[], options: ChatEngineOptions) {
      calls.push({ engine: name, turns: [...turns], preface: options.preface });
      await Promise.resolve();
      const text = reply(calls.length);
      yield { type: 'delta' as const, content: text };
      yield done(text);
    },
  } satisfies ChatEngine;
}

interface SetupOptions {
  readonly storage?: Storage;
  readonly selectEngine?: () => ChatEngine;
  readonly calls?: Recorded[];
  readonly summarize?: ChatSummarizer;
  readonly summaryTimeoutMs?: number;
}

function setup(options: SetupOptions = {}) {
  const storage = options.storage ?? openStorage({ path: ':memory:' });
  const calls = options.calls ?? [];
  const events: ChatEvent[] = [];
  const sink: ChatEventSink = { id: 1, isDestroyed: () => false, send: (e) => events.push(e) };
  const legacy = recorder('legacy', calls, (n) =>
    n === 1 ? `Answer with ${MARKER}` : `Reply ${n}`,
  );
  const chat = new ChatController({
    runtime: { model: 'qwen3:8b', streamChat: legacy.streamChat },
    conversations: storage.conversations,
    ...(options.selectEngine && { selectEngine: options.selectEngine }),
    ...(options.summarize && { summarize: options.summarize }),
    ...(options.summaryTimeoutMs !== undefined && { summaryTimeoutMs: options.summaryTimeoutMs }),
  });
  /** The conversation `ask` uses unless told otherwise. */
  const main = chat.create().conversationId;
  const ask = async (text: string, conversationId = main) => {
    const result = chat.start(sink, { conversationId, text });
    if (result.status !== 'started') throw new Error(`not started: ${JSON.stringify(result)}`);
    await chat.whenIdle();
    return result;
  };
  const rows = (conversationId = main) => storage.conversations.listMessages(conversationId);
  return { chat, sink, events, storage, calls, ask, rows, main };
}

/** A summarizer fake: records each request and answers `Summary <n>`. */
function fakeSummarizer(answer?: (n: number, request: SummarizeRequest) => Promise<string>) {
  const requests: SummarizeRequest[] = [];
  const summarize: ChatSummarizer = (request) => {
    requests.push(request);
    return answer
      ? answer(requests.length, request)
      : Promise.resolve(`Summary ${requests.length}`);
  };
  return { summarize, requests };
}

describe('Chat transcript in SQLite', () => {
  it('stores both exchanges and the second model call receives both', async () => {
    const h = setup();
    expect(h.storage.conversations.get(h.main)?.title).toBe('New chat');
    await h.ask('Hi');
    await h.ask('And again?');
    expect(h.rows().map((r) => [r.seq, r.role, r.content, r.status])).toEqual([
      [1, 'user', 'Hi', 'complete'],
      [2, 'assistant', `Answer with ${MARKER}`, 'complete'],
      [3, 'user', 'And again?', 'complete'],
      [4, 'assistant', 'Reply 2', 'complete'],
    ]);
    expect(h.rows()[1]).toMatchObject({ model: 'qwen3:8b', promptTokens: 11, completionTokens: 7 });
    // The first message replaced "New chat"; the second left the title alone.
    expect(h.storage.conversations.get(h.main)).toMatchObject({ title: 'Hi', model: 'qwen3:8b' });
    expect(h.calls[1]).toEqual({
      engine: 'legacy',
      turns: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: `Answer with ${MARKER}` },
        { role: 'user', content: 'And again?' },
      ],
      preface: undefined,
    });
  });

  it('past the cap, without a summarizer: 8 turns plus the question note', async () => {
    const h = setup();
    for (let i = 1; i <= 5; i++) await h.ask(`Question ${i}`);
    const last = h.calls.at(-1);
    // 4 stored exchanges + the new question = 9 qualifying turns → 1 omitted.
    expect(last?.turns).toHaveLength(CHAT_CONTEXT_TURNS);
    expect(last?.turns.at(-1)).toEqual({ role: 'user', content: 'Question 5' });
    expect(last?.preface).toBe('Earlier turns omitted: 1. Omitted questions:\n- Question 1.');
    await h.ask('Question 6');
    const sixth = h.calls.at(-1);
    expect(sixth?.preface).toBe(
      'Earlier turns omitted: 3. Omitted questions:\n- Question 1\n- Question 2.',
    );
    expect(JSON.stringify(sixth)).not.toContain(MARKER);
    expect(h.rows().map((r) => r.content)).toContain(`Answer with ${MARKER}`);
    expect(h.rows()).toHaveLength(12);
  });

  it('legacy and ADK selection receive the same window', async () => {
    const calls: Recorded[] = [];
    // Replies depend only on the question, so both runs store the same transcript.
    const answer = () => `Answer to ${calls.at(-1)?.turns.at(-1)?.content ?? '?'}`;
    const engines = {
      legacy: recorder('legacy', calls, answer),
      adk: recorder('adk', calls, answer),
    };
    let next: ChatEngine['name'] = 'legacy';
    const h = setup({ selectEngine: () => engines[next], calls });
    for (let i = 1; i <= 5; i++) await h.ask(`Question ${i}`);
    // The same stored transcript, once through each engine: identical input.
    const viaLegacy = h.calls.at(-1);
    const other = h.chat.create().conversationId;
    for (let i = 1; i <= 4; i++) {
      next = 'legacy';
      await h.ask(`Question ${i}`, other);
    }
    next = 'adk';
    await h.ask('Question 5', other);
    const viaAdk = h.calls.at(-1);
    expect(viaLegacy?.engine).toBe('legacy');
    expect(viaAdk?.engine).toBe('adk');
    expect(viaAdk?.preface).toBeDefined();
    expect({ turns: viaAdk?.turns, preface: viaAdk?.preface }).toEqual({
      turns: viaLegacy?.turns,
      preface: viaLegacy?.preface,
    });
  });

  it('stores a cancelled reply only with text, and an error reply even when empty', async () => {
    let mode: 'cancel-empty' | 'cancel-text' | 'error' = 'cancel-empty';
    const engine: ChatEngine = {
      name: 'legacy',
      async *streamChat(_turns, { signal }) {
        if (mode === 'error') throw new Error('model crashed');
        if (mode === 'cancel-text') yield { type: 'delta', content: 'Half' };
        await untilAborted(signal);
        throw new Error('cancelled');
      },
    };
    const h = setup({ selectEngine: () => engine });
    const first = h.chat.start(h.sink, { conversationId: h.main, text: 'One' });
    if (first.status === 'started') h.chat.stop({ streamId: first.streamId });
    await h.chat.whenIdle();
    mode = 'cancel-text';
    const second = h.chat.start(h.sink, { conversationId: h.main, text: 'Two' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (second.status === 'started') h.chat.stop({ streamId: second.streamId });
    await h.chat.whenIdle();
    mode = 'error';
    h.chat.start(h.sink, { conversationId: h.main, text: 'Three' });
    await h.chat.whenIdle();
    expect(h.rows().map((r) => [r.role, r.content, r.status])).toEqual([
      ['user', 'One', 'complete'],
      ['user', 'Two', 'complete'],
      ['assistant', 'Half', 'cancelled'],
      ['user', 'Three', 'complete'],
      ['assistant', '', 'error'],
    ]);
    // The error bubble comes back in the history; it is never sent to the model.
    expect(h.chat.history({ conversationId: h.main }).messages.at(-1)).toEqual({
      role: 'assistant',
      content: '',
      status: 'error',
      model: null,
      promptTokens: null,
      completionTokens: null,
    });
  });

  it('a rejected start (invalid, unknown conversation) writes nothing; unknown history is empty', () => {
    const h = setup();
    expect(h.chat.start(h.sink, { conversationId: h.main, text: '   ' })).toMatchObject({
      status: 'rejected',
      code: 'invalid-request',
    });
    expect(h.chat.start(h.sink, { text: 'No id' })).toMatchObject({ code: 'invalid-request' });
    expect(h.chat.start(h.sink, { conversationId: 'missing', text: 'Hi' })).toMatchObject({
      status: 'rejected',
      code: 'invalid-request',
    });
    expect(h.chat.activeStreamId).toBeUndefined();
    expect(h.storage.conversations.get('missing')).toBeUndefined();
    expect(h.storage.conversations.list().map((c) => c.id)).toEqual([h.main]);
    expect(
      h.storage.sqlite.prepare('select count(*) as n from conversation_messages').get(),
    ).toEqual({ n: 0 });
    expect(h.chat.history({ conversationId: 'missing' })).toEqual({ messages: [] });
    expect(() => h.chat.history({})).toThrow();
  });

  it('refuses a message when the conversation is full, without dropping old rows', () => {
    const h = setup();
    for (let i = 1; i <= 199; i++) {
      h.storage.conversations.append({
        conversationId: h.main,
        role: 'user',
        content: `m${i}`,
        status: 'complete',
      });
    }
    expect(h.chat.start(h.sink, { conversationId: h.main, text: 'one more' })).toMatchObject({
      status: 'rejected',
      code: 'invalid-request',
    });
    expect(h.rows()).toHaveLength(199);
  });

  it('lists conversations newest-updated first, without bodies', async () => {
    let tick = 0;
    let id = 0;
    const context = {
      now: () => new Date(Date.UTC(2026, 10, 21, 10, 0, tick++)).toISOString(),
      newId: () => `id-${++id}`,
    };
    const h = setup({ storage: openStorage({ path: ':memory:', context }) });
    const second = h.chat.create().conversationId;
    expect(h.chat.list().conversations.map((c) => c.id)).toEqual([second, h.main]);
    await h.ask('Bump the first one');
    expect(h.chat.list().conversations).toEqual([
      { id: h.main, title: 'Bump the first one', updatedAt: expect.any(String) },
      { id: second, title: 'New chat', updatedAt: expect.any(String) },
    ]);
  });
});

describe('Several conversations', () => {
  it('keeps each conversation to itself; clearing A leaves B and its summary', async () => {
    const SECRET = 'ONLY-IN-A-9F2';
    const summarizer = fakeSummarizer();
    const h = setup({ summarize: summarizer.summarize });
    const a = h.main;
    const b = h.chat.create().conversationId;
    await h.ask(`Remember ${SECRET}`, a);
    // Enough turns in B for a summary of its own.
    for (let i = 1; i <= 5; i++) await h.ask(`B question ${i}`, b);

    expect(JSON.stringify(h.rows(a))).toContain(SECRET);
    const forB = h.calls.filter((c) => c.turns.some((t) => t.content.startsWith('B question')));
    expect(forB).toHaveLength(5);
    expect(JSON.stringify(forB)).not.toContain(SECRET);
    // The summarizer only ever saw B's turns while working for B.
    expect(summarizer.requests).toHaveLength(1);
    expect(JSON.stringify(summarizer.requests)).not.toContain(SECRET);
    expect(h.storage.conversations.get(b)).toMatchObject({
      summary: 'Summary 1',
      summarizedThroughSeq: 1,
    });

    await h.chat.clear({ conversationId: a });
    expect(h.storage.conversations.get(a)).toBeUndefined();
    expect(h.chat.history({ conversationId: a })).toEqual({ messages: [] });
    expect(h.rows(b)).toHaveLength(10);
    expect(h.storage.conversations.get(b)).toMatchObject({
      summary: 'Summary 1',
      summarizedThroughSeq: 1,
    });
    expect(h.chat.list().conversations.map((c) => c.id)).toEqual([b]);
  });

  it('one reply at a time: a second start is busy, in either conversation', async () => {
    const engine: ChatEngine = {
      name: 'legacy',
      async *streamChat(_turns, { signal }) {
        yield { type: 'delta', content: '' }; // nothing visible until stopped
        await untilAborted(signal);
        throw new Error('cancelled');
      },
    };
    const h = setup({ selectEngine: () => engine });
    const other = h.chat.create().conversationId;
    const started = h.chat.start(h.sink, { conversationId: h.main, text: 'Long one' });
    expect(started.status).toBe('started');
    for (const conversationId of [h.main, other]) {
      expect(h.chat.start(h.sink, { conversationId, text: 'Second' })).toMatchObject({
        status: 'rejected',
        code: 'busy',
      });
    }
    expect(h.rows().map((r) => r.content)).toEqual(['Long one']);
    expect(h.rows(other)).toEqual([]);
    if (started.status === 'started') h.chat.stop({ streamId: started.streamId });
    await h.chat.whenIdle();
  });

  it('clearing another conversation does not stop the running reply', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine: ChatEngine = {
      name: 'legacy',
      async *streamChat() {
        yield { type: 'delta', content: 'Kept' };
        await gate;
        yield done('Kept');
      },
    };
    const h = setup({ selectEngine: () => engine });
    const other = h.chat.create().conversationId;
    h.chat.start(h.sink, { conversationId: h.main, text: 'Running' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.chat.clear({ conversationId: other });
    expect(h.chat.activeStreamId).toBeDefined();
    release();
    await h.chat.whenIdle();
    expect(h.events.at(-1)).toMatchObject({ type: 'done' });
    expect(h.rows().map((r) => [r.role, r.content])).toEqual([
      ['user', 'Running'],
      ['assistant', 'Kept'],
    ]);
  });
});

describe('Rolling summary', () => {
  it('folds only newly omitted turns, once each; the reply gets 8 turns plus the summary', async () => {
    const summarizer = fakeSummarizer();
    const h = setup({ summarize: summarizer.summarize });
    for (let i = 1; i <= 4; i++) await h.ask(`Question ${i}`);
    expect(summarizer.requests).toHaveLength(0); // 8 qualifying turns: nothing omitted

    // Ninth qualifying turn: Question 1 falls out.
    await h.ask('Question 5');
    expect(summarizer.requests).toHaveLength(1);
    expect(summarizer.requests[0]).toMatchObject({
      previousSummary: '',
      turns: [{ role: 'user', content: 'Question 1' }],
    });
    expect(h.storage.conversations.get(h.main)).toMatchObject({
      summary: 'Summary 1',
      summarizedThroughSeq: 1,
    });
    const fifth = h.calls.at(-1);
    expect(fifth?.turns).toHaveLength(CHAT_CONTEXT_TURNS);
    expect(fifth?.preface).toBe(summaryPreface('Summary 1'));
    // The first reply (with the marker) is still in the window here.
    expect(fifth?.turns[0]).toEqual({ role: 'assistant', content: `Answer with ${MARKER}` });

    // Next message: two more turns fall out (the marker reply and Question 2).
    await h.ask('Question 6');
    expect(summarizer.requests).toHaveLength(2);
    expect(summarizer.requests[1]).toMatchObject({
      previousSummary: 'Summary 1',
      turns: [
        { role: 'assistant', content: `Answer with ${MARKER}` },
        { role: 'user', content: 'Question 2' },
      ],
    });
    expect(JSON.stringify(summarizer.requests[1]?.turns)).not.toContain('Question 1');
    expect(h.storage.conversations.get(h.main)).toMatchObject({
      summary: 'Summary 2',
      summarizedThroughSeq: 3,
    });
    const sixth = h.calls.at(-1);
    expect(sixth?.turns).toHaveLength(CHAT_CONTEXT_TURNS);
    expect(sixth?.preface).toBe(summaryPreface('Summary 2'));
    expect(sixth?.preface).not.toContain('Omitted questions');
    // A marker only in an omitted assistant reply reaches neither the turns nor the preface.
    expect(JSON.stringify(sixth)).not.toContain(MARKER);
    // The stored bubble is untouched.
    expect(h.rows()[1]?.content).toBe(`Answer with ${MARKER}`);
  });

  it('clips each turn for the summarizer only', async () => {
    const summarizer = fakeSummarizer();
    const h = setup({ summarize: summarizer.summarize });
    const long = `${'L'.repeat(SUMMARY_TURN_CHARS)}TAIL`;
    await h.ask(long);
    for (let i = 2; i <= 5; i++) await h.ask(`Question ${i}`);
    expect(summarizer.requests[0]?.turns[0]?.content).toHaveLength(SUMMARY_TURN_CHARS);
    expect(h.rows()[0]?.content).toBe(long);
  });

  it('a failing summarizer leaves the summary and cursor as they were; the reply still starts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let fail = false;
    const summarizer = fakeSummarizer((n) =>
      fail ? Promise.reject(new Error('ollama down')) : Promise.resolve(`Summary ${n}`),
    );
    const h = setup({ summarize: summarizer.summarize });
    for (let i = 1; i <= 5; i++) await h.ask(`Question ${i}`);
    expect(h.storage.conversations.get(h.main)).toMatchObject({
      summary: 'Summary 1',
      summarizedThroughSeq: 1,
    });

    fail = true;
    await h.ask('Question 6');
    expect(summarizer.requests).toHaveLength(2);
    expect(h.storage.conversations.get(h.main)).toMatchObject({
      summary: 'Summary 1',
      summarizedThroughSeq: 1,
    });
    expect(h.events.at(-1)).toMatchObject({ type: 'done' });
    expect(h.calls.at(-1)?.preface).toBe(summaryPreface('Summary 1'));

    // The next success folds everything after the old cursor, not only the latest turns.
    fail = false;
    await h.ask('Question 7');
    expect(summarizer.requests[2]?.previousSummary).toBe('Summary 1');
    expect(summarizer.requests[2]?.turns.map((t) => t.content)).toEqual([
      `Answer with ${MARKER}`,
      'Question 2',
      'Reply 2',
      'Question 3',
    ]);
  });

  it('without a stored summary, a failure keeps the question note', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const summarizer = fakeSummarizer(() => Promise.reject(new Error('boom')));
    const h = setup({ summarize: summarizer.summarize });
    for (let i = 1; i <= 5; i++) await h.ask(`Question ${i}`);
    expect(summarizer.requests).toHaveLength(1);
    expect(h.storage.conversations.get(h.main)).toMatchObject({
      summary: null,
      summarizedThroughSeq: null,
    });
    expect(h.calls.at(-1)?.preface).toBe(
      'Earlier turns omitted: 1. Omitted questions:\n- Question 1.',
    );
    expect(h.events.at(-1)).toMatchObject({ type: 'done' });
  });

  it.each([
    ['empty', '   '],
    ['too long', 'x'.repeat(1501)],
  ])('rejects a %s summary and keeps the question note', async (_label, text) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const summarizer = fakeSummarizer(() => Promise.resolve(text));
    const h = setup({ summarize: summarizer.summarize });
    for (let i = 1; i <= 5; i++) await h.ask(`Question ${i}`);
    expect(h.storage.conversations.get(h.main)?.summary).toBeNull();
    expect(h.calls.at(-1)?.preface).toMatch(/^Earlier turns omitted: 1\./);
  });

  it('a summarizer that never answers times out; the reply still starts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let seenSignal: AbortSignal | undefined;
    const summarizer = fakeSummarizer((_n, request) => {
      seenSignal = request.signal;
      return new Promise<string>(() => undefined); // ignores its signal
    });
    const h = setup({ summarize: summarizer.summarize, summaryTimeoutMs: 20 });
    for (let i = 1; i <= 5; i++) await h.ask(`Question ${i}`);
    expect(seenSignal?.aborted).toBe(true);
    expect(h.storage.conversations.get(h.main)?.summary).toBeNull();
    expect(h.events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('stopping during the summary cancels the reply and stores nothing new', async () => {
    const summarizer = fakeSummarizer(
      (_n, request) =>
        new Promise<string>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = setup({ summarize: summarizer.summarize });
    for (let i = 1; i <= 4; i++) await h.ask(`Question ${i}`);
    const calls = h.calls.length;
    const started = h.chat.start(h.sink, { conversationId: h.main, text: 'Question 5' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (started.status === 'started') h.chat.stop({ streamId: started.streamId });
    await h.chat.whenIdle();
    expect(h.events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(h.calls).toHaveLength(calls); // the reply engine was never called
    expect(h.rows().at(-1)).toMatchObject({ role: 'user', content: 'Question 5' });
    expect(h.storage.conversations.get(h.main)?.summary).toBeNull();
  });
});

describe('Clear', () => {
  it('a late done after the conversation is deleted writes nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine: ChatEngine = {
      name: 'legacy',
      async *streamChat() {
        yield { type: 'delta', content: 'Late' };
        await gate; // the reply finishes only after the delete
        yield done('Late');
      },
    };
    const h = setup({ selectEngine: () => engine });
    h.chat.start(h.sink, { conversationId: h.main, text: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Delete without aborting first (as if the finish raced the delete), then let it finish.
    h.storage.conversations.delete(h.main);
    release();
    await h.chat.whenIdle();
    expect(h.storage.sqlite.prepare('select count(*) as n from conversations').get()).toEqual({
      n: 0,
    });
    expect(
      h.storage.sqlite.prepare('select count(*) as n from conversation_messages').get(),
    ).toEqual({ n: 0 });
    expect(h.chat.history({ conversationId: h.main })).toEqual({ messages: [] });
  });

  it('chat.clear stops that conversation’s reply and deletes only it', async () => {
    let endless = true;
    const engine: ChatEngine = {
      name: 'legacy',
      async *streamChat(_turns, { signal }) {
        if (!endless) {
          yield { type: 'delta', content: 'Fresh' };
          yield done('Fresh');
          return;
        }
        yield { type: 'delta', content: 'partial' };
        await untilAborted(signal);
        throw new Error('cancelled');
      },
    };
    const h = setup({ selectEngine: () => engine });
    h.chat.start(h.sink, { conversationId: h.main, text: 'First' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.chat.clear({ conversationId: h.main });
    expect(h.chat.activeStreamId).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(h.chat.history({ conversationId: h.main })).toEqual({ messages: [] });
    expect(h.storage.conversations.get(h.main)).toBeUndefined();
    // The deleted id is no longer accepted.
    expect(h.chat.start(h.sink, { conversationId: h.main, text: 'Again' })).toMatchObject({
      code: 'invalid-request',
    });

    endless = false;
    const next = h.chat.create().conversationId;
    await h.ask('After clear', next);
    expect(h.storage.conversations.get(next)?.title).toBe('After clear');
    expect(h.rows(next).map((r) => r.content)).toEqual(['After clear', 'Fresh']);
  });
});

describe('Restart', () => {
  it('a new controller on the same database returns each previous transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rka-chat-history-'));
    dirs.push(dir);
    const path = join(dir, 'research.db');
    const first = setup({ storage: openStorage({ path }) });
    await first.ask('Remember me');
    const id = first.main;
    first.storage.close();

    const second = setup({ storage: openStorage({ path }) });
    expect(second.chat.list().conversations.map((c) => c.title)).toEqual([
      'New chat', // the one this setup just created
      'Remember me',
    ]);
    expect(second.chat.history({ conversationId: id })).toEqual({
      messages: [
        {
          role: 'user',
          content: 'Remember me',
          status: 'complete',
          model: null,
          promptTokens: null,
          completionTokens: null,
        },
        {
          role: 'assistant',
          content: `Answer with ${MARKER}`,
          status: 'complete',
          model: 'qwen3:8b',
          promptTokens: 11,
          completionTokens: 7,
        },
      ],
    });
    // And the next message continues it.
    await second.ask('Still there?', id);
    expect(second.calls.at(-1)?.turns.map((t) => t.content)).toEqual([
      'Remember me',
      `Answer with ${MARKER}`,
      'Still there?',
    ]);
    second.storage.close();
  });
});
