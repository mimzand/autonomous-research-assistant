import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_MESSAGE_CHARS,
  ChatEventSchema,
  ChatHistorySchema,
  ChatStartRequestSchema,
  ChatStopRequestSchema,
} from './chat.js';

const id = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('ChatStartRequestSchema', () => {
  it('accepts the new user text only, trimmed', () => {
    expect(ChatStartRequestSchema.parse({ text: '  How are you?\n' })).toEqual({
      text: 'How are you?',
    });
  });

  it.each([
    ['blank text', { text: '   \n ' }],
    ['a messages array (the old shape)', { messages: [{ role: 'user', content: 'Hi' }] }],
    ['extra fields', { text: 'x', model: 'gpt-4' }],
    ['oversized text', { text: 'x'.repeat(CHAT_MAX_MESSAGE_CHARS + 1) }],
    ['not an object', 'hello'],
  ])('rejects %s', (_label, input) => {
    expect(ChatStartRequestSchema.safeParse(input).success).toBe(false);
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
