import { CHAT_MAX_MESSAGES } from '@rka/shared';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../testing.js';

const user = (content: string) => ({ role: 'user' as const, content, status: 'complete' as const });

describe('conversation repository', () => {
  it('creates the conversation with the first user message and appends in seq order', () => {
    const storage = memoryStorage();
    expect(storage.conversations.current()).toBeUndefined();

    const first = storage.conversations.append(
      user(`   ${'Tell me about heat pumps. '.repeat(6)}   `),
    );
    expect(first.message.seq).toBe(1);
    expect(first.conversation.title).toBe(
      'Tell me about heat pumps. '.repeat(6).trim().slice(0, 80),
    );
    expect(first.conversation.title).toHaveLength(80);
    expect(first.conversation.model).toBeNull();

    const id = first.conversation.id;
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
    storage.conversations.append({ ...user('And the cost?') });
    storage.conversations.append({
      conversationId: id,
      role: 'assistant',
      content: '',
      status: 'error',
    });

    expect(storage.conversations.current()?.id).toBe(id);
    const raw = `   ${'Tell me about heat pumps. '.repeat(6)}   `;
    expect(
      storage.conversations.listMessages(id).map((m) => [m.seq, m.role, m.status, m.content]),
    ).toEqual([
      [1, 'user', 'complete', raw], // stored as given; only the title is trimmed
      [2, 'assistant', 'complete', 'They move heat.'],
      [3, 'user', 'complete', 'And the cost?'],
      [4, 'assistant', 'error', ''],
    ]);
  });

  it('refuses to start a conversation with an assistant or empty message', () => {
    const storage = memoryStorage();
    expect(() =>
      storage.conversations.append({ role: 'assistant', content: 'x', status: 'complete' }),
    ).toThrow(/starts with a non-empty user message/);
    expect(() => storage.conversations.append(user('   '))).toThrow();
    expect(storage.conversations.current()).toBeUndefined();
  });

  it('deletes the conversation and its messages (cascade); a deleted id is not found', () => {
    const storage = memoryStorage();
    const { conversation } = storage.conversations.append(user('Hi'));
    storage.conversations.append({ ...user('Again') });
    expect(storage.conversations.delete(conversation.id)).toBe(true);
    expect(storage.conversations.delete(conversation.id)).toBe(false);
    expect(storage.conversations.current()).toBeUndefined();
    expect(storage.sqlite.prepare('select count(*) as n from conversation_messages').get()).toEqual(
      { n: 0 },
    );
    expect(() =>
      storage.conversations.append({
        conversationId: conversation.id,
        role: 'assistant',
        content: 'late',
        status: 'complete',
      }),
    ).toThrow(expect.objectContaining({ code: 'not-found' }));
    // The next user message starts a new conversation.
    const next = storage.conversations.append(user('New start'));
    expect(next.conversation.id).not.toBe(conversation.id);
    expect(next.message.seq).toBe(1);
  });

  it(`refuses message ${CHAT_MAX_MESSAGES + 1} without dropping older ones`, () => {
    const storage = memoryStorage();
    const { conversation } = storage.conversations.append(user('m1'));
    for (let i = 2; i <= CHAT_MAX_MESSAGES; i++) storage.conversations.append(user(`m${i}`));
    expect(() => storage.conversations.append(user('one too many'))).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    const messages = storage.conversations.listMessages(conversation.id);
    expect(messages).toHaveLength(CHAT_MAX_MESSAGES);
    expect(messages[0]?.content).toBe('m1');
    expect(messages.at(-1)?.seq).toBe(CHAT_MAX_MESSAGES);
  });

  it('enforces role and status in the database too', () => {
    const storage = memoryStorage();
    const { conversation } = storage.conversations.append(user('Hi'));
    expect(() =>
      storage.sqlite
        .prepare(
          "insert into conversation_messages (id, conversation_id, seq, role, content, status, created_at, updated_at) values ('x', ?, 2, 'system', 'x', 'complete', 'now', 'now')",
        )
        .run(conversation.id),
    ).toThrow(/CHECK/);
    expect(() =>
      storage.sqlite
        .prepare(
          "insert into conversation_messages (id, conversation_id, seq, role, content, status, created_at, updated_at) values ('y', ?, 1, 'user', 'dup', 'complete', 'now', 'now')",
        )
        .run(conversation.id),
    ).toThrow(/UNIQUE/);
  });
});
