import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_MESSAGE_CHARS,
  ChatEventSchema,
  ChatConversationListSchema,
  ChatConversationRequestSchema,
  ChatHistorySchema,
  ChatStartRequestSchema,
  ChatStopRequestSchema,
} from './chat.js';

const id = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('ChatStartRequestSchema', () => {
  it('accepts the conversation id and the new user text, trimmed', () => {
    expect(
      ChatStartRequestSchema.parse({ conversationId: 'c1', text: '  How are you?\n' }),
    ).toEqual({
      conversationId: 'c1',
      text: 'How are you?',
    });
  });

  it.each([
    ['blank text', { conversationId: 'c1', text: '   \n ' }],
    ['no conversation id', { text: 'Hi' }],
    ['an empty conversation id', { conversationId: '', text: 'Hi' }],
    ['a messages array (the old shape)', { messages: [{ role: 'user', content: 'Hi' }] }],
    ['extra fields', { conversationId: 'c1', text: 'x', model: 'gpt-4' }],
    ['oversized text', { conversationId: 'c1', text: 'x'.repeat(CHAT_MAX_MESSAGE_CHARS + 1) }],
    ['not an object', 'hello'],
  ])('rejects %s', (_label, input) => {
    expect(ChatStartRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('conversation list and requests', () => {
  it('lists id, title and updatedAt only', () => {
    const item = { id: 'c1', title: 'New chat', updatedAt: '2026-11-21T10:00:00.000Z' };
    expect(ChatConversationListSchema.safeParse({ conversations: [item] }).success).toBe(true);
    expect(
      ChatConversationListSchema.safeParse({ conversations: [{ ...item, messages: [] }] }).success,
    ).toBe(false);
  });

  it('requires a conversation id for history and clear', () => {
    expect(ChatConversationRequestSchema.safeParse({ conversationId: 'c1' }).success).toBe(true);
    expect(ChatConversationRequestSchema.safeParse({}).success).toBe(false);
    expect(
      ChatConversationRequestSchema.safeParse({ conversationId: 'x'.repeat(101) }).success,
    ).toBe(false);
  });
});

describe('ChatHistorySchema', () => {
  it('accepts stored bubbles with optional stats and rejects unknown statuses', () => {
    const bubble = {
      role: 'assistant',
      content: '',
      status: 'error',
      model: null,
      promptTokens: null,
      completionTokens: null,
    };
    expect(ChatHistorySchema.safeParse({ messages: [bubble] }).success).toBe(true);
    expect(
      ChatHistorySchema.safeParse({ messages: [{ ...bubble, status: 'streaming' }] }).success,
    ).toBe(false);
    expect(ChatHistorySchema.safeParse({ messages: [{ ...bubble, role: 'system' }] }).success).toBe(
      false,
    );
  });
});

describe('ChatStopRequestSchema', () => {
  it('requires a UUID stream id', () => {
    expect(ChatStopRequestSchema.safeParse({ streamId: id }).success).toBe(true);
    expect(ChatStopRequestSchema.safeParse({ streamId: '../../etc' }).success).toBe(false);
  });
});

describe('ChatEventSchema', () => {
  it('accepts each event type', () => {
    for (const event of [
      { type: 'delta', streamId: id, content: 'Hel' },
      {
        type: 'done',
        streamId: id,
        model: 'qwen3:8b',
        finishReason: 'stop',
        completionTokens: 12,
        totalDurationMs: 800,
      },
      { type: 'error', streamId: id, code: 'unavailable', message: 'down' },
      { type: 'cancelled', streamId: id },
    ]) {
      expect(ChatEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('rejects unknown event types and error codes', () => {
    expect(ChatEventSchema.safeParse({ type: 'eval', streamId: id }).success).toBe(false);
    expect(
      ChatEventSchema.safeParse({ type: 'error', streamId: id, code: 'x', message: '' }).success,
    ).toBe(false);
  });
});

describe('ChatEventSchema: tool events (Phase 8.2)', () => {
  const base = {
    type: 'tool',
    streamId: '11111111-1111-4111-8111-111111111111',
    callId: 'call_1',
    name: 'web_search',
    query: 'lighthouse',
    status: 'completed',
    reason: null,
    resultCount: 5,
  };

  it('accepts a valid tool event', () => {
    expect(ChatEventSchema.parse(base)).toEqual(base);
  });

  it('rejects unknown fields, unsafe names, long queries, unknown statuses and raw error text', () => {
    for (const patch of [
      { message: 'ECONNREFUSED C:\\Users\\alice' }, // no free-text error field
      { name: 'web search; rm -rf' },
      { name: '' },
      { query: 'x'.repeat(401) },
      { status: 'approved' },
      { reason: 'ECONNREFUSED' },
      { resultCount: 11 },
      { resultCount: -1 },
      { callId: '' },
    ]) {
      expect(ChatEventSchema.safeParse({ ...base, ...patch }).success, JSON.stringify(patch)).toBe(
        false,
      );
    }
  });
});
