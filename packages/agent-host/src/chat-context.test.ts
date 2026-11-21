import { describe, expect, it } from 'vitest';
import {
  CHAT_CONTEXT_TURNS,
  chatContext,
  PREFACE_QUESTION_CHARS,
  type StoredChatTurn,
} from './chat-context.js';

const MARKER = 'ZEBRA-ASSISTANT-MARKER';
const LONG_QUESTION = `What are the long-term maintenance costs of an air source heat pump in a cold climate, including defrosting?`;

/** Ten qualifying turns (5 exchanges) plus one error reply in the middle. */
function transcript(): StoredChatTurn[] {
  const rows: StoredChatTurn[] = [];
  for (let i = 1; i <= 5; i++) {
    rows.push({
      role: 'user',
      content: i === 1 ? LONG_QUESTION : `Question ${i}`,
      status: 'complete',
    });
    rows.push({
      role: 'assistant',
      content: i === 1 ? `Answer 1 with ${MARKER} (see https://example.org/source)` : `Answer ${i}`,
      status: i === 3 ? 'cancelled' : 'complete',
    });
    if (i === 2) {
      // A failed retry of question 2: shown in the transcript, never sent.
      rows.push({ role: 'user', content: 'Question 2 again', status: 'complete' });
      rows.push({ role: 'assistant', content: 'partial before the error', status: 'error' });
    }
  }
  return rows;
}

describe('chatContext', () => {
  it('keeps the last 8 qualifying turns and summarises the omitted ones without their answers', () => {
    const rows = transcript().filter((r) => r.content !== 'Question 2 again');
    const qualifying = rows.filter((r) => r.status !== 'error');
    expect(qualifying).toHaveLength(10);

    const { turns, preface } = chatContext(rows);
    expect(CHAT_CONTEXT_TURNS).toBe(8);
    expect(turns).toHaveLength(8);
    expect(turns).toEqual(qualifying.slice(2).map(({ role, content }) => ({ role, content })));
    expect(JSON.stringify(turns)).not.toContain(MARKER);
    expect(JSON.stringify(turns)).not.toContain('partial before the error');

    expect(preface).toBe(
      `Earlier turns omitted: 2. Omitted questions:\n- ${LONG_QUESTION.slice(0, PREFACE_QUESTION_CHARS)}.`,
    );
    expect(LONG_QUESTION.length).toBeGreaterThan(PREFACE_QUESTION_CHARS);
    expect(preface).not.toContain(MARKER);
    expect(preface).not.toContain('https://');
  });

  it('leaves error replies out of the context but in the input transcript', () => {
    const rows = transcript();
    expect(rows.some((r) => r.status === 'error')).toBe(true);
    const { turns, preface } = chatContext(rows);
    expect(turns).toHaveLength(8);
    expect(turns.some((t) => t.content === 'partial before the error')).toBe(false);
    // 11 qualifying turns (the retried question counts; its error reply does not): 3 omitted.
    expect(preface).toMatch(/^Earlier turns omitted: 3\. Omitted questions:\n- What are/);
    expect(preface).toContain('\n- Question 2.');
  });

  it('has no preface with 8 or fewer qualifying turns', () => {
    const rows = transcript()
      .filter((r) => r.status !== 'error')
      .slice(0, 8);
    expect(chatContext(rows)).toEqual({
      turns: rows.map(({ role, content }) => ({ role, content })),
    });
    expect(chatContext([])).toEqual({ turns: [] });
  });

  it('drops blank turns and keeps cancelled replies with text', () => {
    const rows: StoredChatTurn[] = [
      { role: 'user', content: 'Hi', status: 'complete' },
      { role: 'assistant', content: '   ', status: 'cancelled' },
      { role: 'assistant', content: 'Half an answer', status: 'cancelled' },
      { role: 'user', content: 'Go on', status: 'complete' },
    ];
    expect(chatContext(rows).turns.map((t) => t.content)).toEqual([
      'Hi',
      'Half an answer',
      'Go on',
    ]);
  });

  it('quotes each omitted question on one line', () => {
    const rows: StoredChatTurn[] = [
      { role: 'user', content: 'First\nline two', status: 'complete' },
      { role: 'assistant', content: 'A', status: 'complete' },
      { role: 'user', content: 'Now', status: 'complete' },
    ];
    expect(chatContext(rows, 1)).toEqual({
      turns: [{ role: 'user', content: 'Now' }],
      preface: 'Earlier turns omitted: 2. Omitted questions:\n- First line two.',
    });
  });
});
