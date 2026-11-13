/**
 * Live durable-session test: the real ADK Runner, OllamaLlm, the configured
 * Ollama server and model, and SqliteSessionService on a temporary database
 * file (never the user's database). Run with `pnpm test:adk:ollama`. Never
 * pulls a model or changes the server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOllamaProvider,
  loadOllamaConfig,
  ollamaTransportOptionsFromEnv,
} from '@rka/model-provider';
import { openStorage } from '@rka/storage';
import { afterAll, describe, expect, it } from 'vitest';
import { type Event, LlmAgent } from '../adk.js';
import { createGuardedRunner } from '../guards.js';
import { OllamaLlm } from '../ollama/ollama-llm.js';
import { finalResponseText } from '../structured.js';
import { findIncompleteInvocations } from './history.js';
import { SqliteSessionService } from './sqlite-session-service.js';
/** Trusted ngrok tunnels from OLLAMA_NGROK_BYPASS_HOSTS (same rule as the app). */
const liveTransport = {
  ngrokBypassHosts: ollamaTransportOptionsFromEnv(process.env).ngrokBypassHosts,
};

const config = loadOllamaConfig(process.env);
const provider = createOllamaProvider(config, liveTransport);
const dir = mkdtempSync(join(tmpdir(), 'rka-adk-live-'));
const dbPath = join(dir, 'sessions.db');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const log = (label: string, value: unknown) =>
  console.info(`[sessions-live] ${label}: ${JSON.stringify(value)}`);

async function turn(service: SqliteSessionService, text: string): Promise<Event[]> {
  const runner = createGuardedRunner({
    appName: 'sessions-live',
    agent: new LlmAgent({
      name: 'assistant',
      model: new OllamaLlm({ provider }),
      instruction: 'You are a concise assistant. Answer in one short sentence.',
      generateContentConfig: { temperature: 0, seed: 42 },
    }),
    sessionService: service,
  });
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'local',
    sessionId: 'live-session',
    newMessage: { role: 'user', parts: [{ text }] },
  })) {
    events.push(event);
  }
  return events;
}

describe(`live durable ADK session at ${config.baseUrl} (${config.model})`, () => {
  it('create → one turn → close the database → reopen → reload → continue with the earlier context', async () => {
    // Process 1.
    const first = openStorage({ path: dbPath });
    const service1 = new SqliteSessionService({ repository: first.adkSessions });
    await service1.createSession({
      appName: 'sessions-live',
      userId: 'local',
      sessionId: 'live-session',
      state: { topic: 'code word', 'user:language': 'en' },
    });
    const turn1 = await turn(
      service1,
      'Remember this code word for later: PELICAN. Reply with just "OK".',
    );
    log('turn 1', {
      answer: finalResponseText(turn1),
      errors: turn1.map((e) => e.errorCode).filter(Boolean),
    });
    expect(finalResponseText(turn1)).toBeTruthy();
    first.close();

    // Process 2: a fresh connection to the same file.
    const second = openStorage({ path: dbPath });
    try {
      const service2 = new SqliteSessionService({ repository: second.adkSessions });
      const reloaded = await service2.getSession({
        appName: 'sessions-live',
        userId: 'local',
        sessionId: 'live-session',
      });
      expect(reloaded?.events.map((e) => e.author)).toEqual(['user', 'assistant']);
      expect(reloaded?.state).toMatchObject({ topic: 'code word', 'user:language': 'en' });
      expect(findIncompleteInvocations(reloaded?.events ?? [])).toEqual([]);

      const turn2 = await turn(service2, 'What was the code word I asked you to remember?');
      const answer = finalResponseText(turn2) ?? '';
      log('turn 2', { answer });
      expect(answer).toMatch(/pelican/i);

      const after = await service2.getSession({
        appName: 'sessions-live',
        userId: 'local',
        sessionId: 'live-session',
      });
      expect(after?.events.map((e) => e.author)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(after?.events.some((e) => e.partial)).toBe(false);
    } finally {
      second.close();
    }
  });
});
