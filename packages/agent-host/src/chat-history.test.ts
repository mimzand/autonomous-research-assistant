/**
 * The stored Chat transcript at the ChatController boundary, with a real SQLite
 * database (in memory or on disk). The engine is a recorder: it captures exactly
 * the turns and preface the controller hands to whichever engine is selected.
 */
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type GenerateChunk } from '@rka/model-provider';
import { type ChatEvent, type ChatTurn } from '@rka/shared';
import { openStorage, type Storage } from '@rka/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_CONTEXT_TURNS } from './chat-context.js';
import { ChatController, type ChatEventSink } from './chat-controller.js';
import { type ChatEngine, type ChatEngineOptions } from './chat-engine.js';

const MARKER = 'FIRST-REPLY-MARKER-7Q';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

function setup(
  storage: Storage = openStorage({ path: ':memory:' }),
  selectEngine?: () => ChatEngine,
  calls: Recorded[] = [],
) {
  const events: ChatEvent[] = [];
  const sink: ChatEventSink = { id: 1, isDestroyed: () => false, send: (e) => events.push(e) };
  const legacy = recorder('legacy', calls, (n) =>
    n === 1 ? `Answer with ${MARKER}` : `Reply ${n}`,
  );
  const chat = new ChatController({
    runtime: { model: 'qwen3:8b', streamChat: legacy.streamChat },
    conversations: storage.conversations,
    ...(selectEngine && { selectEngine }),
  });
  const ask = async (text: string) => {
    const result = chat.start(sink, { text });
    if (result.status !== 'started') throw new Error(`not started: ${JSON.stringify(result)}`);
    await chat.whenIdle();
    return result;
  };
  const rows = () => {
    const c = storage.conversations.current();
    return c ? storage.conversations.listMessages(c.id) : [];
  };
  return { chat, sink, events, storage, calls, ask, rows };
}

describe('Chat transcript in SQLite', () => {
  it('stores both exchanges and the second model call receives both', async () => {
    const h = setup();
    await h.ask('Hi');
    await h.ask('And again?');
    expect(h.rows().map((r) => [r.seq, r.role, r.content, r.status])).toEqual([
      [1, 'user', 'Hi', 'complete'],
      [2, 'assistant', `Answer with ${MARKER}`, 'complete'],
      [3, 'user', 'And again?', 'complete'],
      [4, 'assistant', 'Reply 2', 'complete'],
    ]);
    expect(h.rows()[1]).toMatchObject({ model: 'qwen3:8b', promptTokens: 11, completionTokens: 7 });
    expect(h.storage.conversations.current()).toMatchObject({ title: 'Hi', model: 'qwen3:8b' });
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

  it('past the cap: 8 turns plus a preface; the first reply stays in SQLite only', async () => {
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
    const h = setup(undefined, () => engines[next], calls);
    for (let i = 1; i <= 5; i++) await h.ask(`Question ${i}`);
    // The same stored transcript, once through each engine: identical input.
    const viaLegacy = h.calls.at(-1);
    h.storage.conversations.delete(h.storage.conversations.current()?.id ?? '');
    for (let i = 1; i <= 4; i++) {
      next = 'legacy';
      await h.ask(`Question ${i}`);
    }
    next = 'adk';
    await h.ask('Question 5');
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
    const storage = openStorage({ path: ':memory:' });
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
    const h = setup(storage, () => engine);
    const first = h.chat.start(h.sink, { text: 'One' });
    if (first.status === 'started') h.chat.stop({ streamId: first.streamId });
    await h.chat.whenIdle();
    mode = 'cancel-text';
    const second = h.chat.start(h.sink, { text: 'Two' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (second.status === 'started') h.chat.stop({ streamId: second.streamId });
    await h.chat.whenIdle();
    mode = 'error';
    h.chat.start(h.sink, { text: 'Three' });
    await h.chat.whenIdle();
    expect(h.rows().map((r) => [r.role, r.content, r.status])).toEqual([
      ['user', 'One', 'complete'],
      ['user', 'Two', 'complete'],
      ['assistant', 'Half', 'cancelled'],
      ['user', 'Three', 'complete'],
      ['assistant', '', 'error'],
    ]);
    // The error bubble comes back in the history; it is never sent to the model.
    expect(h.chat.history().messages.at(-1)).toEqual({
      role: 'assistant',
      content: '',
      status: 'error',
      model: null,
      promptTokens: null,
      completionTokens: null,
    });
  });

  it('a rejected start (invalid or busy) writes nothing', async () => {
    const storage = openStorage({ path: ':memory:' });
    const engine: ChatEngine = {
      name: 'legacy',
      async *streamChat(_turns, { signal }) {
        yield { type: 'delta', content: '' }; // nothing visible until stopped
        await untilAborted(signal);
        throw new Error('cancelled');
      },
    };
    const h = setup(storage, () => engine);
    expect(h.chat.start(h.sink, { text: '   ' })).toMatchObject({ status: 'rejected' });
    expect(storage.conversations.current()).toBeUndefined();
    const started = h.chat.start(h.sink, { text: 'Long one' });
    expect(h.chat.start(h.sink, { text: 'Second' })).toMatchObject({ code: 'busy' });
    expect(h.rows().map((r) => r.content)).toEqual(['Long one']);
    if (started.status === 'started') h.chat.stop({ streamId: started.streamId });
    await h.chat.whenIdle();
  });

  it('refuses a message when the conversation is full, without dropping old rows', async () => {
    const h = setup();
    const { conversation } = h.storage.conversations.append({
      role: 'user',
      content: 'm1',
      status: 'complete',
    });
    for (let i = 2; i <= 199; i++) {
      h.storage.conversations.append({ role: 'user', content: `m${i}`, status: 'complete' });
    }
    expect(h.chat.start(h.sink, { text: 'one more' })).toMatchObject({
      status: 'rejected',
      code: 'invalid-request',
    });
    expect(h.storage.conversations.listMessages(conversation.id)).toHaveLength(199);
  });
});

describe('Clear', () => {
  it('a late done after Clear writes nothing; the next message starts a new conversation', async () => {
    const storage = openStorage({ path: ':memory:' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const engine: ChatEngine = {
      name: 'legacy',
      async *streamChat() {
        yield { type: 'delta', content: 'Late' };
        await gate; // the reply finishes only after Clear
        yield done('Late');
      },
    };
    const h = setup(storage, () => engine);
    h.chat.start(h.sink, { text: 'First' });
    const old = storage.conversations.current();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Delete without aborting first (as if the finish raced the delete), then let it finish.
    storage.conversations.delete(old?.id ?? '');
    release();
    await h.chat.whenIdle();
    expect(storage.sqlite.prepare('select count(*) as n from conversations').get()).toEqual({
      n: 0,
    });
    expect(storage.sqlite.prepare('select count(*) as n from conversation_messages').get()).toEqual(
      { n: 0 },
    );
    expect(h.chat.history()).toEqual({ messages: [] });
  });

  it('chat.clear stops the active reply, deletes the transcript, and the next message is new', async () => {
    const storage = openStorage({ path: ':memory:' });
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
    const h = setup(storage, () => engine);
    h.chat.start(h.sink, { text: 'First' });
    const old = storage.conversations.current();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.chat.clear();
    expect(h.chat.activeStreamId).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(h.chat.history()).toEqual({ messages: [] });
    expect(storage.conversations.get(old?.id ?? '')).toBeUndefined();

    endless = false;
    await h.ask('After clear');
    const now = storage.conversations.current();
    expect(now?.id).not.toBe(old?.id);
    expect(now?.title).toBe('After clear');
    expect(h.rows().map((r) => r.content)).toEqual(['After clear', 'Fresh']);
  });
});

describe('Restart', () => {
  it('a new controller on the same database returns the previous transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rka-chat-history-'));
    dirs.push(dir);
    const path = join(dir, 'research.db');
    const first = setup(openStorage({ path }));
    await first.ask('Remember me');
    first.storage.close();

    const second = setup(openStorage({ path }));
    expect(second.chat.history()).toEqual({
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
    await second.ask('Still there?');
    expect(second.calls.at(-1)?.turns.map((t) => t.content)).toEqual([
      'Remember me',
      `Answer with ${MARKER}`,
      'Still there?',
    ]);
    second.storage.close();
  });
});
