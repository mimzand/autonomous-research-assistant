import { type GenerateChunk } from '@rka/model-provider';
import { describe, expect, it, vi } from 'vitest';
import {
  createChatEngineSelector,
  DEFAULT_AGENT_ENGINE,
  legacyChatEngine,
  parseAgentEngine,
  type ChatEngine,
} from './chat-engine.js';

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

describe('legacyChatEngine', () => {
  it('delegates to AgentRuntime.streamChat with the signal', () => {
    const streamChat = vi.fn();
    const signal = new AbortController().signal;
    legacyChatEngine({ streamChat }).streamChat([{ role: 'user', content: 'x' }], { signal });
    expect(streamChat).toHaveBeenCalledWith([{ role: 'user', content: 'x' }], { signal });
  });
});
