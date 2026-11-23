import { type ChatEvent, type ChatToolEvent, type SettingsView } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { webSearchAvailability } from '../lib/settings';
import { createChatSession } from './session';
import { applyToolEvent, toolStepLabel, toolStepStatusText, type UiToolStep } from './tool-steps';

const STREAM = '11111111-1111-4111-8111-111111111111';

const tool = (
  callId: string,
  status: ChatToolEvent['status'],
  extra: Partial<ChatToolEvent> = {},
) =>
  ({
    type: 'tool',
    streamId: STREAM,
    callId,
    name: 'web_search',
    query: 'lighthouse',
    status,
    reason: null,
    resultCount: null,
    ...extra,
  }) satisfies ChatToolEvent;

function fakeApi() {
  let listener: ((event: ChatEvent) => void) | undefined;
  return {
    api: {
      start: vi.fn(async () => ({ status: 'started' as const, streamId: STREAM, model: 'm' })),
      stop: vi.fn(async () => undefined),
      list: vi.fn(async () => ({
        conversations: [{ id: 'c1', title: 'New chat', updatedAt: '2026-11-21T10:00:00.000Z' }],
      })),
      create: vi.fn(async () => ({ conversationId: 'c2' })),
      history: vi.fn(async () => ({ messages: [] })),
      clear: vi.fn(async () => undefined),
      onEvent: (fn: (event: ChatEvent) => void) => {
        listener = fn;
        return () => (listener = undefined);
      },
    },
    emit: (event: ChatEvent) => listener?.(event),
  };
}

describe('Chat web-search steps (Phase 8.2)', () => {
  it('shows each search in order, updates it by call id and never moves a finished step back', () => {
    const steps: UiToolStep[] = [];
    applyToolEvent(steps, tool('a', 'running'));
    applyToolEvent(steps, tool('a', 'completed', { resultCount: 5 }));
    applyToolEvent(steps, tool('a', 'running')); // stale or replayed: ignored
    applyToolEvent(steps, tool('b', 'skipped', { reason: 'limit-reached', query: 'second' }));
    expect(steps.map((s) => [s.callId, s.status, toolStepStatusText(s)])).toEqual([
      ['a', 'completed', '5 results'],
      ['b', 'skipped', 'Not run: search limit for this message reached'],
    ]);
    expect(toolStepLabel({ name: steps[0]?.name ?? '' })).toBe('Web search');
    expect(toolStepLabel({ name: 'run_shell' })).toBe('Tool run_shell');
  });

  it('uses fixed texts for every outcome (never raw error messages)', () => {
    const step = (status: UiToolStep['status'], reason: UiToolStep['reason'], resultCount = null) =>
      toolStepStatusText({
        callId: 'x',
        name: 'web_search',
        query: null,
        status,
        reason,
        resultCount,
      });
    expect(step('running', null)).toBe('Searching…');
    expect(step('failed', 'unavailable')).toBe('Failed: web search is unavailable');
    expect(step('failed', 'timeout')).toBe('Failed: took too long');
    expect(step('cancelled', 'cancelled')).toBe('Stopped');
    expect(step('skipped', 'not-allowed')).toBe('Not run: this tool is not available');
    expect(
      toolStepStatusText({
        callId: 'x',
        name: 'web_search',
        query: null,
        status: 'completed',
        reason: null,
        resultCount: 1,
      }),
    ).toBe('1 result');
  });

  it('attaches steps to the streaming reply, before its text, and settles them on stop', async () => {
    const { api, emit } = fakeApi();
    const chat = createChatSession(api, { model: () => 'm' });
    await chat.whenLoaded;
    chat.draft.value = 'When was it built?';
    await chat.send();
    emit(tool('a', 'running'));
    emit(tool('a', 'completed', { resultCount: 3 }));
    emit(tool('b', 'running', { query: 'more' }));
    emit({ type: 'cancelled', streamId: STREAM });
    const reply = chat.messages.value[1];
    expect(reply?.tools.map((t) => [t.callId, t.status])).toEqual([
      ['a', 'completed'],
      ['b', 'cancelled'],
    ]);
    expect(reply?.status).toBe('cancelled');
    // Steps are not sent back as context: only the text is.
    expect(chat.messages.value[0]?.tools).toEqual([]);
  });

  it('marks running steps as failed when the reply fails', async () => {
    const { api, emit } = fakeApi();
    const chat = createChatSession(api, { model: () => 'm' });
    await chat.whenLoaded;
    chat.draft.value = 'q';
    await chat.send();
    emit(tool('a', 'running'));
    emit({ type: 'error', streamId: STREAM, code: 'timeout', message: 'took too long' });
    expect(chat.messages.value[1]?.tools[0]?.status).toBe('failed');
  });
});

describe('Web search setting availability', () => {
  const values = (patch: Partial<SettingsView['values']>) =>
    ({
      'chat.webSearch': false,
      'searxng.url': 'http://127.0.0.1:8080',
      'engine.chat': 'legacy',
      ...patch,
    }) as SettingsView['values'];

  it('is off by default and explains every inactive state', () => {
    expect(webSearchAvailability(values({}))).toMatchObject({ active: false, tone: 'muted' });
    expect(
      webSearchAvailability(values({ 'chat.webSearch': true, 'searxng.url': null })),
    ).toMatchObject({
      active: false,
      tone: 'warn',
      text: expect.stringMatching(/SearXNG URL/),
    });
    expect(
      webSearchAvailability(values({ 'chat.webSearch': true, 'engine.chat': 'adk' })),
    ).toMatchObject({ active: true, text: expect.stringMatching(/Legacy and Google ADK/) });
  });

  it('discloses where queries go when active', () => {
    const state = webSearchAvailability(
      values({ 'chat.webSearch': true, 'searxng.url': 'https://search.example.com/searx?x=1' }),
    );
    expect(state).toMatchObject({ active: true, tone: 'ok' });
    expect(state.text).toContain('https://search.example.com');
    expect(state.text).toMatch(/search engines it uses/);
  });
});
