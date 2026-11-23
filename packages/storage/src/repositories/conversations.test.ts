import { CHAT_MAX_MESSAGES } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../testing.js';
import { NEW_CONVERSATION_TITLE } from './conversations.js';

const user = (conversationId: string, content: string) => ({
  conversationId,
  role: 'user' as const,
  content,
  status: 'complete' as const,
});

describe('conversation repository', () => {
  it('creates an empty "New chat"; the first user message becomes the title; seq order', () => {
    const storage = memoryStorage();
    expect(storage.conversations.list()).toEqual([]);
    const created = storage.conversations.create();
    expect(created).toMatchObject({
      title: NEW_CONVERSATION_TITLE,
      model: null,
      summary: null,
      summarizedThroughSeq: null,
    });
    expect(storage.conversations.listMessages(created.id)).toEqual([]);
    const id = created.id;

    const raw = `   ${'Tell me about heat pumps. '.repeat(6)}   `;
    const first = storage.conversations.append(user(id, raw));
    expect(first.message.seq).toBe(1);
    expect(first.conversation.title).toBe(
      'Tell me about heat pumps. '.repeat(6).trim().slice(0, 80),
    );
    expect(first.conversation.title).toHaveLength(80);

    const reply = storage.conversations.append({
      conversationId: id,
      role: 'assistant',
      content: 'They move heat.',
      status: 'complete',
      model: 'qwen3:8b',
      promptTokens: 12,
      completionTokens: 4,
    });
    expect(reply.message).toMatchObject({ seq: 2, model: 'qwen3:8b', promptTokens: 12 });
    expect(reply.conversation.model).toBe('qwen3:8b');
    // Later user messages leave the title alone.
    expect(storage.conversations.append(user(id, 'And the cost?')).conversation.title).toBe(
      first.conversation.title,
    );
    storage.conversations.append({
      conversationId: id,
      role: 'assistant',
      content: '',
      status: 'error',
    });

    expect(
      storage.conversations.listMessages(id).map((m) => [m.seq, m.role, m.status, m.content]),
    ).toEqual([
      [1, 'user', 'complete', raw], // stored as given; only the title is trimmed
      [2, 'assistant', 'complete', 'They move heat.'],
      [3, 'user', 'complete', 'And the cost?'],
      [4, 'assistant', 'error', ''],
    ]);
  });

  it('keeps "New chat" when the first message is not a non-empty user message', () => {
    const storage = memoryStorage();
    const { id } = storage.conversations.create();
    storage.conversations.append({
      conversationId: id,
      role: 'assistant',
      content: 'x',
      status: 'complete',
    });
    storage.conversations.append(user(id, '   '));
    expect(storage.conversations.get(id)?.title).toBe(NEW_CONVERSATION_TITLE);
    storage.conversations.append(user(id, 'Real question'));
    expect(storage.conversations.get(id)?.title).toBe('Real question');
  });

  it('lists conversations newest-updated first, without message bodies', () => {
    const storage = memoryStorage(); // its clock ticks one second per call
    const a = storage.conversations.create();
    const b = storage.conversations.create();
    expect(storage.conversations.list().map((c) => c.id)).toEqual([b.id, a.id]);
    storage.conversations.append(user(a.id, 'Bump A'));
    expect(storage.conversations.list().map((c) => [c.id, c.title])).toEqual([
      [a.id, 'Bump A'],
      [b.id, NEW_CONVERSATION_TITLE],
    ]);
  });

  it('appends only to an existing conversation', () => {
    const storage = memoryStorage();
    expect(() => storage.conversations.append(user('missing', 'Hi'))).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(storage.conversations.list()).toEqual([]);
  });

  it('deletes one conversation and its messages (cascade); others stay', () => {
    const storage = memoryStorage();
    const a = storage.conversations.create();
    const b = storage.conversations.create();
    storage.conversations.append(user(a.id, 'Hi A'));
    storage.conversations.append(user(b.id, 'Hi B'));
    storage.conversations.setSummary({ conversationId: b.id, summary: 'B so far', throughSeq: 1 });
    expect(storage.conversations.delete(a.id)).toBe(true);
    expect(storage.conversations.delete(a.id)).toBe(false);
    expect(storage.conversations.list().map((c) => c.id)).toEqual([b.id]);
    expect(storage.conversations.listMessages(b.id).map((m) => m.content)).toEqual(['Hi B']);
    expect(storage.conversations.get(b.id)?.summary).toBe('B so far');
    expect(
      storage.sqlite
        .prepare('select count(*) as n from conversation_messages where conversation_id = ?')
        .get(a.id),
    ).toEqual({ n: 0 });
    expect(() =>
      storage.conversations.append({
        conversationId: a.id,
        role: 'assistant',
        content: 'late',
        status: 'complete',
      }),
    ).toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('stores the summary with its cursor, which only moves forward', () => {
    const storage = memoryStorage();
    const { id, updatedAt } = storage.conversations.create();
    expect(
      storage.conversations.setSummary({ conversationId: id, summary: ' S1 ', throughSeq: 2 }),
    ).toBe(true);
    expect(storage.conversations.get(id)).toMatchObject({
      summary: 'S1',
      summarizedThroughSeq: 2,
      updatedAt,
    });
    expect(
      storage.conversations.setSummary({ conversationId: id, summary: 'older', throughSeq: 2 }),
    ).toBe(false);
    expect(
      storage.conversations.setSummary({ conversationId: id, summary: 'older', throughSeq: 1 }),
    ).toBe(false);
    expect(
      storage.conversations.setSummary({ conversationId: id, summary: 'S2', throughSeq: 4 }),
    ).toBe(true);
    expect(storage.conversations.get(id)).toMatchObject({ summary: 'S2', summarizedThroughSeq: 4 });
    expect(
      storage.conversations.setSummary({ conversationId: 'gone', summary: 'x', throughSeq: 9 }),
    ).toBe(false);
    // Invalid summaries never reach the database.
    expect(() =>
      storage.conversations.setSummary({ conversationId: id, summary: '  ', throughSeq: 5 }),
    ).toThrow();
    expect(() =>
      storage.conversations.setSummary({
        conversationId: id,
        summary: 'x'.repeat(1501),
        throughSeq: 5,
      }),
    ).toThrow();
    expect(() =>
      storage.conversations.setSummary({ conversationId: id, summary: 'x', throughSeq: 0 }),
    ).toThrow();
    expect(storage.conversations.get(id)).toMatchObject({ summary: 'S2', summarizedThroughSeq: 4 });
  });

  it(`refuses message ${CHAT_MAX_MESSAGES + 1} without dropping older ones`, () => {
    const storage = memoryStorage();
    const { id } = storage.conversations.create();
    for (let i = 1; i <= CHAT_MAX_MESSAGES; i++) storage.conversations.append(user(id, `m${i}`));
    expect(() => storage.conversations.append(user(id, 'one too many'))).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    const messages = storage.conversations.listMessages(id);
    expect(messages).toHaveLength(CHAT_MAX_MESSAGES);
    expect(messages[0]?.content).toBe('m1');
    expect(messages.at(-1)?.seq).toBe(CHAT_MAX_MESSAGES);
  });

  it('enforces role and status in the database too', () => {
    const storage = memoryStorage();
    const { id } = storage.conversations.create();
    storage.conversations.append(user(id, 'Hi'));
    expect(() =>
      storage.sqlite
        .prepare(
          "insert into conversation_messages (id, conversation_id, seq, role, content, status, created_at, updated_at) values ('x', ?, 2, 'system', 'x', 'complete', 'now', 'now')",
        )
        .run(id),
    ).toThrow(/CHECK/);
    expect(() =>
      storage.sqlite
        .prepare(
          "insert into conversation_messages (id, conversation_id, seq, role, content, status, created_at, updated_at) values ('y', ?, 1, 'user', 'dup', 'complete', 'now', 'now')",
        )
        .run(id),
    ).toThrow(/UNIQUE/);
  });
});
