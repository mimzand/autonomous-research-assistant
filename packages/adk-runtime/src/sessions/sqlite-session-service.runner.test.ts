/*
 * SqliteSessionService with the real ADK Runner, OllamaLlm, OllamaProvider
 * (real HTTP to a fake Ollama), the ToolRegistry bridge and the app's real
 * SQLite storage, in temporary database files. Never touches the user's
 * database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// ADK's own type guard, imported in test code only: proves the error is ADK-compatible.
import {
  isStaleSessionError as adkIsStaleSessionError,
  StaleSessionError as AdkStaleSessionError,
} from '@google/adk';
import { createOllamaProvider, loadOllamaConfig } from '@rka/model-provider';
import { openStorage, type Storage, TABLE_NAMES } from '@rka/storage';
import { createToolRegistry, defineTool } from '@rka/tools';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createEvent, type Event, LlmAgent, type Session, StreamingMode } from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { OllamaLlm } from '../ollama/ollama-llm.js';
import { finalResponseText } from '../structured.js';
import {
  chunk,
  type ChatBody,
  type FakeOllama,
  reply,
  startFakeOllama,
  streamLines,
  toolCallChunk,
} from '../testing/fake-ollama.js';
import { summarizeInvocation, ToolOutcomeTracker } from '../tools/outcomes.js';
import { createRegistryTools } from '../tools/registry-tool.js';
import { findIncompleteInvocations } from './history.js';
import {
  isStaleSessionError,
  SqliteSessionService,
  StaleSessionError,
} from './sqlite-session-service.js';

const APP = 'assistant';

let ollama: FakeOllama;
beforeAll(async () => (ollama = await startFakeOllama()));
afterAll(() => ollama.close());

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

/** A temp database file (never the user's real database). */
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rka-adk-sessions-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'research.db');
}

function open(path: string): { storage: Storage; service: SqliteSessionService } {
  const storage = openStorage({ path });
  cleanups.unshift(() => storage.close());
  return { storage, service: new SqliteSessionService({ repository: storage.adkSessions }) };
}

const executed = vi.fn();
const registry = createToolRegistry([
  defineTool({
    name: 'calculator',
    description: 'Arithmetic on two numbers.',
    inputSchema: z.strictObject({
      operation: z.enum(['add', 'multiply']),
      a: z.number(),
      b: z.number(),
    }),
    outputSchema: z.object({ result: z.number() }),
    timeoutMs: 1000,
    permissions: {
      network: 'none',
      filesystem: 'none',
      effects: 'read-only',
      requiresApproval: false,
    },
    execute: ({ operation, a, b }) => {
      executed({ operation, a, b });
      return Promise.resolve({ result: operation === 'add' ? a + b : a * b });
    },
  }),
]);

function runnerFor(
  service: SqliteSessionService,
  opts: { tools?: boolean; outcomes?: ToolOutcomeTracker } = {},
) {
  const provider = createOllamaProvider(loadOllamaConfig({ OLLAMA_HOST: ollama.baseUrl }), {
    ...(opts.tools && { allowToolCalls: true }),
  });
  const tools = opts.tools
    ? createRegistryTools(registry, {
        allow: ['calculator'],
        limits: {
          maxCallsPerInvocation: 3,
          maxCallDurationMs: 1000,
          maxResultBytes: 10_000,
          maxIdenticalCalls: 2,
        },
        ...(opts.outcomes && { outcomes: opts.outcomes }),
      })
    : [];
  return createGuardedRunner({
    appName: APP,
    agent: new LlmAgent({
      name: 'assistant',
      model: new OllamaLlm({ provider }),
      instruction: 'You are concise.',
      tools,
    }),
    sessionService: service,
    registryTools: tools,
  });
}

async function turn(
  runner: ReturnType<typeof runnerFor>,
  userId: string,
  sessionId: string,
  text: string,
  opts: { stream?: boolean; signal?: AbortSignal; onEvent?: (e: Event) => void } = {},
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId,
    sessionId,
    newMessage: { role: 'user', parts: [{ text }] },
    ...(opts.stream && { runConfig: { streamingMode: StreamingMode.SSE } }),
    ...(opts.signal && { abortSignal: opts.signal }),
  })) {
    events.push(event);
    opts.onEvent?.(event);
  }
  return events;
}

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const textOf = (e: Event) => (e.content?.parts ?? []).map((p) => p.text ?? '').join('');
const roles = (body: ChatBody) =>
  body.messages.map((m) => `${String(m['role'])}:${String(m['content'] ?? '')}`);
const count = (storage: Storage, table: string) =>
  (storage.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

/** Answers each chat with "answer N" (N = number of messages it received). */
const echoCount = () =>
  ollama.setChat((body, res) =>
    reply(body, res, [chunk(`answer ${String(body.messages.length)}`, true)]),
  );

describe('A. create and retrieve', () => {
  it('creates a session with split state, generates ids, and refuses duplicate ids', async () => {
    const { service, storage } = open(tempDb());
    const created = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's1',
      state: { topic: 'ADK', 'app:theme': 'dark', 'user:lang': 'fa', 'temp:scratch': 1 },
    });
    expect(created).toMatchObject({ id: 's1', appName: APP, userId: 'u1', events: [] });
    expect(plain(created.state)).toEqual({ topic: 'ADK', 'app:theme': 'dark', 'user:lang': 'fa' });

    const loaded = await service.getSession({ appName: APP, userId: 'u1', sessionId: 's1' });
    expect(plain(loaded)).toEqual(plain(created));
    // temp: state is never stored.
    expect(
      JSON.stringify(storage.sqlite.prepare('select * from adk_sessions').all()),
    ).not.toContain('scratch');

    const generated = await service.createSession({ appName: APP, userId: 'u1' });
    expect(generated.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      service.createSession({ appName: APP, userId: 'u1', sessionId: 's1' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      await service.getSession({ appName: APP, userId: 'u1', sessionId: 'missing' }),
    ).toBeUndefined();
  });

  it('getOrCreateSession reuses an existing session', async () => {
    const { service } = open(tempDb());
    const a = await service.getOrCreateSession({ appName: APP, userId: 'u1', sessionId: 'x' });
    const b = await service.getOrCreateSession({ appName: APP, userId: 'u1', sessionId: 'x' });
    expect(b.lastUpdateTime).toBe(a.lastUpdateTime);
  });
});

describe('B. list isolation', () => {
  it('lists one user’s sessions in one app, paginated, without events', async () => {
    const { service } = open(tempDb());
    for (const id of ['a', 'b', 'c'])
      await service.createSession({ appName: APP, userId: 'u1', sessionId: id });
    await service.createSession({ appName: APP, userId: 'u2', sessionId: 'z' });
    await service.createSession({ appName: 'other-app', userId: 'u1', sessionId: 'y' });

    const all = await service.listSessions({ appName: APP, userId: 'u1' });
    expect(all.sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(all).toMatchObject({ page: 1, limit: 3, totalItems: 3, totalPages: 1 });
    expect(all.sessions.every((s) => s.events.length === 0 && s.userId === 'u1')).toBe(true);

    const page2 = await service.listSessions({ appName: APP, userId: 'u1', limit: 2, page: 2 });
    expect(page2.sessions.map((s) => s.id)).toEqual(['c']);
    expect(page2).toMatchObject({ page: 2, limit: 2, totalItems: 3, totalPages: 2 });

    // Listing every user's sessions is refused (documented deviation).
    await expect(service.listSessions({ appName: APP })).rejects.toThrow(/requires a userId/);
  });
});

describe('C. delete', () => {
  it('deletes one session and its events, keeping other sessions and shared state', async () => {
    echoCount();
    const { service, storage } = open(tempDb());
    const runner = runnerFor(service);
    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 'keep',
      state: { 'app:a': 1, 'user:b': 2 },
    });
    await service.createSession({ appName: APP, userId: 'u1', sessionId: 'drop' });
    await service.createSession({ appName: APP, userId: 'u2', sessionId: 'drop' });
    await turn(runner, 'u1', 'keep', 'hi');
    await turn(runner, 'u1', 'drop', 'hi');
    await turn(runner, 'u2', 'drop', 'hi');

    await service.deleteSession({ appName: APP, userId: 'u1', sessionId: 'drop' });
    expect(
      await service.getSession({ appName: APP, userId: 'u1', sessionId: 'drop' }),
    ).toBeUndefined();
    // No orphan events.
    expect(
      storage.sqlite
        .prepare(
          "select count(*) as n from adk_events where user_id = 'u1' and session_id = 'drop'",
        )
        .get(),
    ).toEqual({ n: 0 });
    // Same id under another user is untouched.
    expect(
      (await service.getSession({ appName: APP, userId: 'u2', sessionId: 'drop' }))?.events,
    ).toHaveLength(2);
    const kept = await service.getSession({ appName: APP, userId: 'u1', sessionId: 'keep' });
    expect(kept?.events).toHaveLength(2);
    expect(kept?.state).toMatchObject({ 'app:a': 1, 'user:b': 2 });
    // Deleting a missing session is a no-op, as in ADK's services.
    await expect(
      service.deleteSession({ appName: APP, userId: 'u1', sessionId: 'drop' }),
    ).resolves.toBeUndefined();
  });
});

describe('D/F. event history and continuing after reopen', () => {
  it('a turn is stored in order; after close and reopen the next turn sees the full history', async () => {
    echoCount();
    const path = tempDb();
    const first = open(path);
    await first.service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const turn1 = await turn(runnerFor(first.service), 'u1', 's', 'My name is Morteza.');
    expect(finalResponseText(turn1)).toBe('answer 2');
    const before = await first.service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    first.storage.close();

    // "Restart": new storage, service and runner on the same file.
    const second = open(path);
    const reloaded = await second.service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's',
    });
    expect(plain(reloaded)).toEqual(plain(before));
    expect(reloaded?.events.map((e) => [e.author, textOf(e)])).toEqual([
      ['user', 'My name is Morteza.'],
      ['assistant', 'answer 2'],
    ]);

    const turn2 = await turn(runnerFor(second.service), 'u1', 's', 'What is my name?');
    expect(finalResponseText(turn2)).toBe('answer 4');
    // The model received the earlier turn from the reloaded history.
    const sent = roles(ollama.chats.at(-1) as ChatBody);
    expect(sent[0]).toMatch(/^system:.*You are concise\.$/s);
    expect(sent.slice(1)).toEqual([
      'user:My name is Morteza.',
      'assistant:answer 2',
      'user:What is my name?',
    ]);
    const after = await second.service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    expect(after?.events.map(textOf)).toEqual([
      'My name is Morteza.',
      'answer 2',
      'What is my name?',
      'answer 4',
    ]);
    // Restored events are real ADK events (built with ADK's own factory).
    expect(after?.events.every((e) => typeof e.actions.stateDelta === 'object')).toBe(true);
  });

  it('bounded history reads: numRecentEvents and afterTimestamp', async () => {
    echoCount();
    const { service } = open(tempDb());
    await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const runner = runnerFor(service);
    await turn(runner, 'u1', 's', 'one');
    await turn(runner, 'u1', 's', 'two');
    const all = await service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const recent = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's',
      config: { numRecentEvents: 2 },
    });
    expect(recent?.events.map(textOf)).toEqual(['two', 'answer 4']);
    const cut = all?.events[1]?.timestamp ?? 0;
    const after = await service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's',
      config: { afterTimestamp: cut },
    });
    expect(after?.events.every((e) => e.timestamp > cut)).toBe(true);
  });
});

describe('E. state scopes', () => {
  it('session, user and app state are stored in their scopes; temp: is never stored', async () => {
    const { service, storage } = open(tempDb());
    const s1 = await service.createSession({ appName: APP, userId: 'u1', sessionId: 's1' });
    const s2 = await service.createSession({ appName: APP, userId: 'u1', sessionId: 's2' });
    await service.createSession({ appName: APP, userId: 'u2', sessionId: 's3' });

    await service.appendEvent({
      session: s1,
      event: createEvent({
        invocationId: 'inv',
        author: 'assistant',
        actions: {
          stateDelta: { step: 2, 'user:lang': 'fa', 'app:version': 5, 'temp:draft': 'x' },
        },
      }),
    });
    expect(plain(s1.state)).toEqual({ step: 2, 'user:lang': 'fa', 'app:version': 5 });
    expect(JSON.stringify(s1.events[0]?.actions.stateDelta)).not.toContain('draft');

    const reS1 = await service.getSession({ appName: APP, userId: 'u1', sessionId: 's1' });
    const reS2 = await service.getSession({ appName: APP, userId: 'u1', sessionId: 's2' });
    const reS3 = await service.getSession({ appName: APP, userId: 'u2', sessionId: 's3' });
    expect(plain(reS1?.state)).toEqual({ step: 2, 'user:lang': 'fa', 'app:version': 5 });
    expect(plain(reS2?.state)).toEqual({ 'user:lang': 'fa', 'app:version': 5 }); // same user, other session
    expect(plain(reS3?.state)).toEqual({ 'app:version': 5 }); // other user: app state only
    expect(s2.state).toEqual({}); // a stale in-memory copy is not mutated behind the caller's back
    const raw = JSON.stringify([
      storage.sqlite.prepare('select * from adk_events').all(),
      storage.sqlite.prepare('select * from adk_sessions').all(),
      storage.sqlite.prepare('select * from adk_user_state').all(),
      storage.sqlite.prepare('select * from adk_app_state').all(),
    ]);
    expect(raw).not.toContain('draft');
  });

  it('refuses values JSON cannot represent instead of silently changing them', async () => {
    const { service } = open(tempDb());
    const s = await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    for (const bad of [Number.NaN, new Date(0), () => 1, 10n]) {
      await expect(
        service.appendEvent({
          session: s,
          event: createEvent({ invocationId: 'i', author: 'x', actions: { stateDelta: { bad } } }),
        }),
      ).rejects.toThrow(/Cannot store/);
    }
    await expect(
      service.createSession({
        appName: APP,
        userId: 'u1',
        sessionId: 't',
        state: { when: new Date(0) },
      }),
    ).rejects.toThrow(/Cannot store/);
    expect(s.events).toEqual([]);
  });
});

describe('G. duplicate event ids', () => {
  it('re-appending the same event does not duplicate it, in memory or in storage', async () => {
    const { service, storage } = open(tempDb());
    const s = await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const event = createEvent({
      invocationId: 'i',
      author: 'user',
      content: { role: 'user', parts: [{ text: 'hi' }] },
    });
    await service.appendEvent({ session: s, event });
    await service.appendEvent({ session: s, event });
    expect(s.events).toHaveLength(1);
    expect(count(storage, 'adk_events')).toBe(1);
    expect(
      (await service.getSession({ appName: APP, userId: 'u1', sessionId: 's' }))?.events,
    ).toHaveLength(1);
  });
});

describe('H. rollback on failure', () => {
  async function failingAppend(trigger: string) {
    const { service, storage } = open(tempDb());
    const s = await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's',
      state: { kept: 1 },
    });
    const snapshot = plain(s);
    storage.sqlite.exec(trigger);
    await expect(
      service.appendEvent({
        session: s,
        event: createEvent({
          invocationId: 'i',
          author: 'assistant',
          content: { role: 'model', parts: [{ text: 'answer' }] },
          actions: { stateDelta: { kept: 2, 'user:u': 1, 'app:a': 1 } },
        }),
      }),
    ).rejects.toThrow(/injected/);
    // The caller's session object is untouched, and so is the database.
    expect(plain(s)).toEqual(snapshot);
    expect(plain(await service.getSession({ appName: APP, userId: 'u1', sessionId: 's' }))).toEqual(
      snapshot,
    );
    expect(
      count(storage, 'adk_events') +
        count(storage, 'adk_user_state') +
        count(storage, 'adk_app_state'),
    ).toBe(0);
  }

  it('failure during the event insert', () =>
    failingAppend(
      "CREATE TRIGGER f BEFORE INSERT ON adk_events BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ));
  it('failure during the user-state update', () =>
    failingAppend(
      "CREATE TRIGGER f BEFORE INSERT ON adk_user_state BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ));
  it('failure during the session update', () =>
    failingAppend(
      "CREATE TRIGGER f BEFORE UPDATE ON adk_sessions BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ));

  it('a Runner turn whose model answer cannot be stored leaves only what was committed', async () => {
    echoCount();
    const { service, storage } = open(tempDb());
    await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    // Fail only the second insert (the model's answer); the user message commits.
    storage.sqlite.exec(
      "CREATE TRIGGER f BEFORE INSERT ON adk_events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    await expect(turn(runnerFor(service), 'u1', 's', 'hello')).rejects.toThrow(/injected/);
    const reloaded = await service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    expect(reloaded?.events.map(textOf)).toEqual(['hello']);
    expect(findIncompleteInvocations(reloaded?.events ?? [])).toHaveLength(1);
  });
});

describe('I. ordering and concurrent writers', () => {
  it('a second writer with a stale copy gets ADK StaleSessionError; nothing is overwritten', async () => {
    const path = tempDb();
    const a = open(path);
    const b = open(path); // a second connection, like a second process
    await a.service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const copyA = await a.service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const copyB = await b.service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    if (!copyA || !copyB) throw new Error('missing');
    const ev = (text: string, owner: string) =>
      createEvent({
        invocationId: 'i',
        author: 'user',
        content: { role: 'user', parts: [{ text }] },
        actions: { stateDelta: { owner } },
        timestamp: copyA.lastUpdateTime, // same millisecond for both writers
      });
    await a.service.appendEvent({ session: copyA, event: ev('from A', 'A') });
    const error = await b.service
      .appendEvent({ session: copyB, event: ev('from B', 'B') })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaleSessionError);
    expect(adkIsStaleSessionError(error)).toBe(true); // ADK recognises it
    expect(isStaleSessionError(new AdkStaleSessionError('x'))).toBe(true); // and vice versa
    expect(copyB.events).toEqual([]);
    const final = await a.service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    expect(final?.events.map(textOf)).toEqual(['from A']);
    expect(final?.state).toEqual({ owner: 'A' });
  });

  it('keeps append order even when timestamps are equal or go backwards', async () => {
    const { service } = open(tempDb());
    const s = await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    for (const [text, timestamp] of [
      ['first', 5000],
      ['second', 5000],
      ['third', 1000],
    ] as const) {
      await service.appendEvent({
        session: s,
        event: createEvent({
          invocationId: 'i',
          author: 'user',
          content: { parts: [{ text }] },
          timestamp,
        }),
      });
    }
    const reloaded = await service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    expect(reloaded?.events.map(textOf)).toEqual(['first', 'second', 'third']);
  });
});

describe('J. cancellation and partial events', () => {
  it('a streaming turn cancelled mid-answer stores no partial text and is not a completed answer', async () => {
    ollama.setChat((_body, res) =>
      streamLines(res, [chunk('The answer '), chunk('is '), chunk('42.'), chunk('', true)], 150),
    );
    const path = tempDb();
    const { service, storage } = open(path);
    await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const controller = new AbortController();
    const events = await turn(runnerFor(service), 'u1', 's', 'question', {
      stream: true,
      signal: controller.signal,
      onEvent: (e) => {
        if (e.partial) controller.abort();
      },
    });
    await ollama.clientAborted();
    expect(events.some((e) => e.partial && textOf(e).includes('The answer'))).toBe(true);
    expect(events.at(-1)?.errorCode).toBe('INVOCATION_ABORTED');
    storage.close();

    // After a restart, the stored history has the question, no partial text, and no completed answer.
    const reopened = open(path);
    const reloaded = await reopened.service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's',
    });
    const stored = reloaded?.events ?? [];
    // ADK's Runner stores the question and its own INVOCATION_ABORTED event.
    expect(stored.map((e) => [e.author, e.errorCode ?? null, textOf(e)])).toEqual([
      ['user', null, 'question'],
      ['assistant', 'INVOCATION_ABORTED', ''],
    ]);
    // Cancelled, so ended: not "incomplete", and not answered either.
    expect(findIncompleteInvocations(stored)).toEqual([]);
    expect(stored.some((e) => e.partial)).toBe(false);
    expect(stored.map(textOf).join(' ')).not.toContain('The answer');
    expect(finalResponseText(stored)).toBeUndefined();
    const result = summarizeInvocation(stored, new ToolOutcomeTracker());
    expect(result.status).toBe('cancelled');
    expect(result.modelText).toBeUndefined();
  });

  it('appendEvent ignores partial events', async () => {
    const { service, storage } = open(tempDb());
    const s = await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    await service.appendEvent({
      session: s,
      event: createEvent({
        invocationId: 'i',
        author: 'assistant',
        partial: true,
        content: { parts: [{ text: 'half' }] },
      }),
    });
    expect(s.events).toEqual([]);
    expect(count(storage, 'adk_events')).toBe(0);
  });
});

describe('K. tool calls survive a reload with their ids; outcomes are not inferred from history', () => {
  it('function-call and function-response ids match after reopen; a fresh tracker reports nothing as executed', async () => {
    ollama.setChat((body, res, call) =>
      reply(
        body,
        res,
        call % 2 === 1
          ? [toolCallChunk('call-7', 'calculator', { operation: 'multiply', a: 6, b: 7 }, true)]
          : [chunk('It is 42.', true)],
      ),
    );
    executed.mockClear();
    const path = tempDb();
    const first = open(path);
    await first.service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    const outcomes = new ToolOutcomeTracker();
    const events = await turn(
      runnerFor(first.service, { tools: true, outcomes }),
      'u1',
      's',
      'six times seven?',
    );
    expect(executed).toHaveBeenCalledTimes(1);
    expect(summarizeInvocation(events, outcomes).status).toBe('completed');
    first.storage.close();

    const second = open(path);
    const stored =
      (await second.service.getSession({ appName: APP, userId: 'u1', sessionId: 's' }))?.events ??
      [];
    const calls = stored.flatMap(
      (e) => e.content?.parts?.flatMap((p) => (p.functionCall ? [p.functionCall] : [])) ?? [],
    );
    const responses = stored.flatMap(
      (e) =>
        e.content?.parts?.flatMap((p) => (p.functionResponse ? [p.functionResponse] : [])) ?? [],
    );
    expect(calls).toEqual([
      { id: 'call-7', name: 'calculator', args: { operation: 'multiply', a: 6, b: 7 } },
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      id: 'call-7',
      name: 'calculator',
      response: { status: 'ok', data: { result: 42 } },
    });
    // The user message, then every non-partial event the Runner yielded, in order.
    expect(stored[0]?.author).toBe('user');
    expect(stored.slice(1).map((e) => e.id)).toEqual(
      events.filter((e) => !e.partial).map((e) => e.id),
    );
    expect(stored).toHaveLength(4); // user, call, response, answer

    // A stored function response is history, not evidence of execution in this process.
    const fromHistory = summarizeInvocation(stored, new ToolOutcomeTracker());
    expect(fromHistory.outcomes.every((o) => !o.executionStarted && !o.succeeded)).toBe(true);
    expect(fromHistory.status).not.toBe('completed');
    expect(fromHistory.modelText).toBeUndefined();
    expect(executed).toHaveBeenCalledTimes(1); // reloading never re-runs a tool
  });
});

describe('Crash recovery', () => {
  it('a crash right after an event was stored: the committed event survives, nothing else', async () => {
    echoCount();
    const path = tempDb();
    const crashed = open(path);
    const s = await crashed.service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    await crashed.service.appendEvent({
      session: s,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: { role: 'user', parts: [{ text: 'q' }] },
      }),
    });
    // No close(): the connection is abandoned as in a crash. A new process opens the file.
    const restarted = openStorage({ path });
    cleanups.unshift(() => restarted.close());
    const service = new SqliteSessionService({ repository: restarted.adkSessions });
    const reloaded = await service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    expect(reloaded?.events.map(textOf)).toEqual(['q']);
    // The interrupted invocation is visible as incomplete, never as answered.
    expect(findIncompleteInvocations(reloaded?.events ?? [])).toEqual(['inv-1']);
    expect(finalResponseText(reloaded?.events ?? [])).toBeUndefined();
  });

  it('recovery after an incomplete tool invocation: the dangling call is reported, not executed, and the session continues', async () => {
    const path = tempDb();
    const first = open(path);
    const s = await first.service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    await first.service.appendEvent({
      session: s,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: { role: 'user', parts: [{ text: '6*7?' }] },
      }),
    });
    // The process died after the model's tool call was stored and before the tool ran.
    await first.service.appendEvent({
      session: s,
      event: createEvent({
        invocationId: 'inv-1',
        author: 'assistant',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'calculator',
                args: { operation: 'multiply', a: 6, b: 7 },
              },
            },
          ],
        },
      }),
    });
    first.storage.close();

    executed.mockClear();
    echoCount();
    const second = open(path);
    const reloaded = await second.service.getSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's',
    });
    expect(findIncompleteInvocations(reloaded?.events ?? [])).toEqual(['inv-1']);
    const summary = summarizeInvocation(reloaded?.events ?? [], new ToolOutcomeTracker());
    expect(summary.outcomes).toEqual([
      expect.objectContaining({ callId: 'call-1', status: 'not_executed' }),
    ]);

    // The next turn runs; the old tool call is not executed on reload.
    const next = await turn(
      runnerFor(second.service, { tools: true }),
      'u1',
      's',
      'never mind, hello',
    );
    expect(executed).not.toHaveBeenCalled();
    expect(finalResponseText(next)).toMatch(/^answer \d+$/);
    const after = await second.service.getSession({ appName: APP, userId: 'u1', sessionId: 's' });
    expect(findIncompleteInvocations(after?.events ?? [])).toEqual(['inv-1']);
  });
});

describe('L. cross-user and cross-app access', () => {
  it('a session id alone never reaches another user’s or app’s session', async () => {
    echoCount();
    const { service } = open(tempDb());
    const alice = await service.createSession({
      appName: APP,
      userId: 'alice',
      sessionId: 'shared-id',
    });
    await turn(runnerFor(service), 'alice', 'shared-id', 'secret plan');

    expect(
      await service.getSession({ appName: APP, userId: 'bob', sessionId: 'shared-id' }),
    ).toBeUndefined();
    expect(
      await service.getSession({ appName: 'other', userId: 'alice', sessionId: 'shared-id' }),
    ).toBeUndefined();
    // A forged session object for another user cannot write into Alice's session.
    const forged: Session = { ...alice, userId: 'bob', events: [] };
    await expect(
      service.appendEvent({
        session: forged,
        event: createEvent({ invocationId: 'i', author: 'user' }),
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    // The Runner for Bob cannot open Alice's session either.
    await expect(turn(runnerFor(service), 'bob', 'shared-id', 'show me')).rejects.toThrow(
      /not found/i,
    );
    const stillAlice = await service.getSession({
      appName: APP,
      userId: 'alice',
      sessionId: 'shared-id',
    });
    expect(stillAlice?.events.map(textOf)).toEqual(['secret plan', 'answer 2']);
  });

  it('refuses malformed ids (paths, wildcards, whitespace)', async () => {
    const { service } = open(tempDb());
    for (const id of ['../x', 'a/b', '%', 'a b', 'x'.repeat(129)]) {
      await expect(
        service.createSession({ appName: APP, userId: 'u1', sessionId: id }),
      ).rejects.toMatchObject({
        code: 'invalid-input',
      });
      await expect(
        service.getSession({ appName: APP, userId: id, sessionId: 's' }),
      ).rejects.toMatchObject({
        code: 'invalid-input',
      });
    }
  });
});

describe('Limits', () => {
  it('refuses an oversized event without storing anything or changing the session', async () => {
    const { service, storage } = open(tempDb());
    const s = await service.createSession({ appName: APP, userId: 'u1', sessionId: 's' });
    await expect(
      service.appendEvent({
        session: s,
        event: createEvent({
          invocationId: 'i',
          author: 'user',
          content: { parts: [{ text: 'x'.repeat(1_100_000) }] },
        }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(s.events).toEqual([]);
    expect(count(storage, 'adk_events')).toBe(0);
  });
});

describe('M. existing Research data is unaffected', () => {
  it('ADK session activity changes no Research table and is not listed in the renderer-visible storage status', async () => {
    echoCount();
    const { service, storage } = open(tempDb());
    const task = storage.tasks.create({ title: 'Research', input: { question: 'q' } });
    storage.logs.append(task.id, { level: 'info', event: 'task.note', message: 'kept' });
    const researchTables = [
      'tasks',
      'task_steps',
      'task_logs',
      'sources',
      'source_contents',
      'reports',
      'approvals',
      'model_usage',
      'settings',
    ];
    const snapshot = () =>
      Object.fromEntries(
        researchTables.map((t) => [t, storage.sqlite.prepare(`select * from ${t}`).all()]),
      );
    const before = snapshot();

    await service.createSession({
      appName: APP,
      userId: 'u1',
      sessionId: 's',
      state: { 'app:x': 1 },
    });
    await turn(runnerFor(service), 'u1', 's', 'hello');
    await service.deleteSession({ appName: APP, userId: 'u1', sessionId: 's' });

    expect(snapshot()).toEqual(before);
    expect(TABLE_NAMES.some((t) => t.startsWith('adk_'))).toBe(false);
  });
});
