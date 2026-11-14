import { type GenerateChunk } from '@rka/model-provider';
import { type ChatEvent } from '@rka/shared';
import { describe, expect, it, vi } from 'vitest';
import { ChatController, type ChatEventSink } from './chat.js';
import {
  AGENT_ENGINE_ENV,
  createChatEngineSelector,
  DEFAULT_AGENT_ENGINE,
  legacyChatEngine,
  parseAgentEngine,
  type ChatEngine,
} from './chat-engine.js';
import { isAllowedSetting } from './security.js';

// The fake yields provider chunks only, so it can also stand in for AgentRuntime.streamChat.
const engine = (
  name: ChatEngine['name'],
  text = name,
): ChatEngine & { calls: number; streamChat(): AsyncGenerator<GenerateChunk> } => {
  const e = {
    name,
    calls: 0,
    async *streamChat(): AsyncGenerator<GenerateChunk> {
      e.calls++;
      await Promise.resolve();
      yield { type: 'delta', content: text };
      yield {
        type: 'done',
        result: {
          model: 'm',
          content: text,
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalDurationMs: 1, loadDurationMs: 0 },
        },
      };
    },
  };
  return e;
};

describe('agent.engine flag', () => {
  it('defaults to legacy', () => {
    expect(DEFAULT_AGENT_ENGINE).toBe('legacy');
    expect(parseAgentEngine(undefined)).toEqual({ engine: 'legacy' });
    expect(parseAgentEngine('')).toEqual({ engine: 'legacy' });
    expect(parseAgentEngine('   ')).toEqual({ engine: 'legacy' });
  });

  it('accepts legacy and adk (trimmed, any case)', () => {
    expect(parseAgentEngine('adk')).toEqual({ engine: 'adk' });
    expect(parseAgentEngine(' ADK ')).toEqual({ engine: 'adk' });
    expect(parseAgentEngine('Legacy')).toEqual({ engine: 'legacy' });
  });

  it('fails safe: an unknown value selects legacy, with a bounded warning', () => {
    for (const raw of ['gemini', 'adk2', 'true', '1', 'x'.repeat(500)]) {
      const parsed = parseAgentEngine(raw);
      expect(parsed.engine).toBe('legacy');
      expect(parsed.warning).toMatch(/^Ignoring AGENT_ENGINE=/);
      expect(parsed.warning?.length).toBeLessThan(160);
    }
  });

  it('may be set in settings.env (only that key, not other AGENT_* keys)', () => {
    expect(isAllowedSetting(AGENT_ENGINE_ENV)).toBe(true);
    expect(isAllowedSetting('AGENT_ENGINE_X')).toBe(false);
    expect(isAllowedSetting('AGENT_OTHER')).toBe(false);
    expect(isAllowedSetting('agent_engine')).toBe(false);
  });

  it('the selector reads the flag on every call and logs changes once', () => {
    const legacy = engine('legacy');
    const adk = engine('adk');
    let flag: string | undefined;
    const log = vi.fn();
    const select = createChatEngineSelector({ legacy, adk, readFlag: () => flag, log });
    expect(select()).toBe(legacy);
    flag = 'adk';
    expect(select()).toBe(adk);
    expect(select()).toBe(adk);
    flag = 'nope';
    expect(select()).toBe(legacy);
    expect(log.mock.calls.map(([m]) => m as string)).toEqual([
      'Chat engine: legacy',
      'Chat engine: adk',
      expect.stringMatching(/^Ignoring AGENT_ENGINE="nope"/),
    ]);
  });
});

describe('ChatController engine selection', () => {
  const sink = (events: ChatEvent[]): ChatEventSink => ({
    id: 1,
    isDestroyed: () => false,
    send: (e) => events.push(e),
  });
  const runtime = { model: 'm', streamChat: vi.fn() };

  it('without a selector it uses the legacy runtime (unchanged behaviour)', async () => {
    const legacy = engine('legacy');
    const chat = new ChatController({ runtime: { model: 'm', streamChat: legacy.streamChat } });
    const events: ChatEvent[] = [];
    chat.start(sink(events), { messages: [{ role: 'user', content: 'Hi' }] });
    await chat.whenIdle();
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
    expect(legacy.calls).toBe(1);
  });

  it('captures the engine once, when the request starts', async () => {
    const legacy = engine('legacy');
    const adk = engine('adk');
    let current: ChatEngine = adk;
    const selectEngine = vi.fn(() => current);
    const chat = new ChatController({ runtime, selectEngine });
    const events: ChatEvent[] = [];
    chat.start(sink(events), { messages: [{ role: 'user', content: 'Hi' }] });
    current = legacy; // changed after start: does not affect the running request
    await chat.whenIdle();
    expect(selectEngine).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ type: 'delta', content: 'adk' });

    chat.start(sink(events), { messages: [{ role: 'user', content: 'Hi' }] });
    await chat.whenIdle();
    expect(events.at(-2)).toMatchObject({ type: 'delta', content: 'legacy' });
  });

  it('rejected requests (busy, invalid) never select an engine', async () => {
    const selectEngine = vi.fn(() => engine('adk'));
    const chat = new ChatController({ runtime, selectEngine });
    expect(chat.start(sink([]), { messages: [] })).toMatchObject({ status: 'rejected' });
    chat.start(sink([]), { messages: [{ role: 'user', content: 'Hi' }] });
    expect(chat.start(sink([]), { messages: [{ role: 'user', content: 'Hi' }] })).toMatchObject({
      code: 'busy',
    });
    await chat.whenIdle();
    expect(selectEngine).toHaveBeenCalledTimes(1);
  });

  it('legacyChatEngine delegates to AgentRuntime.streamChat with the signal', () => {
    const streamChat = vi.fn();
    const signal = new AbortController().signal;
    legacyChatEngine({ streamChat }).streamChat([{ role: 'user', content: 'x' }], { signal });
    expect(streamChat).toHaveBeenCalledWith([{ role: 'user', content: 'x' }], { signal });
  });
});
