import {
  ChatConversationListSchema,
  ChatConversationRequestSchema,
  ChatHistorySchema,
  ChatStartRequestSchema,
  IpcChannels,
  type ChatEvent,
  type IpcChannel,
  type TaskActionResult,
  type TaskListQuery,
} from '@rka/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { MethodNameSchema, type RequestEnvelope } from './envelope.js';
import {
  isMethodName,
  parseEvent,
  parseRequest,
  parseResult,
  PROTOCOL_METHODS,
  type EventPayload,
  type MethodName,
  type ParsedRequest,
  type RequestParamsInput,
  type RequestResult,
  type ShellMethodName,
} from './methods.js';

const streamId = '7d3b2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const reqOf = (method: string, payload: unknown): RequestEnvelope => ({
  id: 'r1',
  kind: 'req',
  method,
  payload,
});

describe('PROTOCOL_METHODS', () => {
  const entries = Object.entries(PROTOCOL_METHODS);

  it('uses valid method names', () => {
    for (const [name] of entries) expect(MethodNameSchema.safeParse(name).success, name).toBe(true);
  });

  it('routes shell.* and ui.* to the shell and everything else to the agent', () => {
    for (const [name, def] of entries) {
      const toShell = /^(shell|ui)\./.test(name) || def.type === 'event';
      expect(def.direction, name).toBe(toShell ? 'toShell' : 'toAgent');
    }
  });

  it('only pushes events from the agent to the shell', () => {
    const events = entries.filter(([, def]) => def.type === 'event').map(([name]) => name);
    expect(events.sort()).toEqual(['chat.event', 'ui.researchProgress', 'ui.settingsChanged']);
  });

  it('reuses @rka/shared schemas instead of copies', () => {
    expect(PROTOCOL_METHODS['chat.start'].params).toBe(ChatStartRequestSchema);
    expect(PROTOCOL_METHODS['chat.history'].result).toBe(ChatHistorySchema);
    expect(PROTOCOL_METHODS['chat.history'].params).toBe(ChatConversationRequestSchema);
    expect(PROTOCOL_METHODS['chat.clear'].params).toBe(ChatConversationRequestSchema);
    expect(PROTOCOL_METHODS['chat.list'].result).toBe(ChatConversationListSchema);
  });

  it('covers every renderer IPC channel or marks it shell-only', () => {
    const mapping: Record<IpcChannel, MethodName | 'shell-only'> = {
      'app:get-info': 'shell-only',
      'model:get-health': 'model.health',
      'chat:start': 'chat.start',
      'chat:stop': 'chat.stop',
      'chat:list': 'chat.list',
      'chat:create': 'chat.create',
      'chat:history': 'chat.history',
      'chat:clear': 'chat.clear',
      'tasks:counts': 'tasks.counts',
      'tasks:list': 'tasks.list',
      'tasks:get': 'tasks.get',
      'tasks:run-persistence-check': 'tasks.runPersistenceCheck',
      'tasks:resume': 'tasks.resume',
      'tasks:cancel': 'tasks.cancel',
      'tasks:start-research': 'tasks.startResearch',
      'tasks:pause': 'tasks.pause',
      'tasks:retry': 'tasks.retry',
      'tasks:logs': 'tasks.logs',
      'sources:list': 'sources.list',
      'sources:get': 'sources.get',
      'reports:list': 'reports.list',
      'reports:get': 'reports.get',
      'storage:status': 'storage.status',
      'storage:integrity-check': 'storage.integrityCheck',
      'storage:backup': 'storage.backup',
      'research:status': 'researchTools.status',
      'research:check-search': 'researchTools.checkSearch',
      'research:search': 'researchTools.search',
      'research:fetch': 'researchTools.fetchUrl',
      'research:pick-file': 'researchTools.pickFile',
      'research:extract-file': 'researchTools.extractFile',
      'research:save-source': 'researchTools.saveSource',
      'research:open-url': 'researchTools.openUrl',
      'research:cancel': 'researchTools.cancel',
      'settings:get': 'settings.get',
      'settings:validate': 'settings.validate',
      'settings:update': 'settings.update',
      'settings:reset': 'settings.reset',
      'settings:set-secret': 'shell-only',
      'settings:choose-backup-folder': 'shell-only',
      'settings:test-searxng': 'settings.testSearxng',
      'ollama:test-connection': 'model.testConnection',
      'ollama:connection-state': 'model.connectionState',
      'ollama:connect': 'model.connect',
      'ollama:disconnect': 'model.disconnect',
      'ollama:list-models': 'model.listModels',
      'ollama:show-model': 'model.showModel',
      'ollama:test-model': 'model.testModel',
      'ollama:effective-config': 'model.effectiveConfig',
    };
    expect(Object.keys(mapping).sort()).toEqual(Object.values(IpcChannels).sort());
    for (const method of Object.values(mapping)) {
      if (method === 'shell-only') continue;
      expect(PROTOCOL_METHODS[method]).toMatchObject({ type: 'request', direction: 'toAgent' });
    }
  });
});

describe('method types', () => {
  it('derive params, results and payloads from the shared schemas', () => {
    expectTypeOf<RequestParamsInput<'tasks.list'>>().toEqualTypeOf<TaskListQuery>();
    expectTypeOf<RequestResult<'tasks.pause'>>().toEqualTypeOf<TaskActionResult>();
    expectTypeOf<EventPayload<'chat.event'>>().toEqualTypeOf<ChatEvent>();
    expectTypeOf<RequestResult<'shell.chooseFile'>>().toEqualTypeOf<{ path: string | null }>();
    expectTypeOf<ShellMethodName>().toEqualTypeOf<
      | 'shell.chooseBackupPath'
      | 'shell.chooseFile'
      | 'shell.chooseFolder'
      | 'shell.openExternal'
      | 'shell.getSecret'
      | 'shell.encryptionAvailable'
    >();
  });

  it('narrows a parsed request by method', () => {
    expectTypeOf<Extract<ParsedRequest, { method: 'system.ping' }>['params']>().toEqualTypeOf<{
      nonce?: string | undefined;
    }>();
  });
});

describe('isMethodName', () => {
  it('ignores prototype keys', () => {
    expect(isMethodName('system.ping')).toBe(true);
    expect(isMethodName('constructor')).toBe(false);
    expect(isMethodName('toString')).toBe(false);
  });
});

describe('parseRequest', () => {
  it('accepts system.ping on the agent', () => {
    expect(parseRequest(reqOf('system.ping', { nonce: 'n1' }), 'toAgent')).toEqual({
      ok: true,
      value: { id: 'r1', method: 'system.ping', params: { nonce: 'n1' } },
    });
  });

  it('applies shared schema defaults', () => {
    const result = parseRequest(reqOf('tasks.list', {}), 'toAgent');
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown method', () => {
    expect(parseRequest(reqOf('system.exec', {}), 'toAgent')).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    });
  });

  it('rejects requests in the wrong direction', () => {
    expect(parseRequest(reqOf('shell.chooseFile', {}), 'toAgent')).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    });
    expect(parseRequest(reqOf('chat.start', {}), 'toShell')).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    });
    expect(parseRequest(reqOf('shell.chooseFile', {}), 'toShell').ok).toBe(true);
  });

  it('rejects an event name used as a request', () => {
    expect(parseRequest(reqOf('chat.event', {}), 'toShell')).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    });
  });

  it('rejects invalid params without echoing values', () => {
    const secret = 'SECRET-should-not-leak';
    const result = parseRequest(
      reqOf('chat.start', { text: secret, messages: [{ role: 'assistant', content: secret }] }),
      'toAgent',
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    if (!result.ok) expect(result.error.message).not.toContain(secret);
  });

  it('requires {} for methods without params', () => {
    expect(parseRequest(reqOf('tasks.counts', {}), 'toAgent').ok).toBe(true);
    expect(parseRequest(reqOf('tasks.counts', null), 'toAgent').ok).toBe(false);
    expect(parseRequest(reqOf('tasks.counts', { extra: 1 }), 'toAgent').ok).toBe(false);
  });

  it('shell.getSecret carries a known key and its base64 ciphertext, nothing else (Phase 7)', () => {
    const ok = (payload: unknown) => parseRequest(reqOf('shell.getSecret', payload), 'toShell').ok;
    expect(ok({ key: 'ollama.authToken', ciphertext: 'djEwAAAA+/9=' })).toBe(true);
    expect(ok({ key: 'anything', ciphertext: 'djEwAAAA' })).toBe(false);
    expect(ok({ key: 'ollama.authToken' })).toBe(false);
    expect(ok({ key: 'ollama.authToken', ciphertext: 'not base64!' })).toBe(false);
    expect(ok({ key: 'ollama.authToken', ciphertext: 'djEw', value: 'plain' })).toBe(false);
  });

  it('settings.storeSecret takes ciphertext (or null), never a plaintext value', () => {
    const ok = (payload: unknown) =>
      parseRequest(reqOf('settings.storeSecret', payload), 'toAgent').ok;
    expect(ok({ key: 'ollama.authToken', ciphertext: 'djEwAAAA' })).toBe(true);
    expect(ok({ key: 'ollama.authToken', ciphertext: null })).toBe(true);
    expect(ok({ key: 'ollama.authToken', value: 'secret-token' })).toBe(false);
    expect(ok({ key: 'ollama.authToken', ciphertext: 'secret token' })).toBe(false);
    expect(ok({ key: 'other', ciphertext: null })).toBe(false);
  });
});

describe('parseResult', () => {
  it('validates a pong', () => {
    const pong = { nonce: 'n1', agentTime: '2026-11-14T11:37:00.000Z' };
    expect(parseResult('system.ping', pong)).toEqual({ ok: true, value: pong });
    expect(parseResult('system.ping', { agentTime: 'now' }).ok).toBe(false);
  });

  it('allows null for nullable and void results', () => {
    expect(parseResult('tasks.get', null).ok).toBe(true);
    expect(parseResult('chat.stop', null).ok).toBe(true);
    expect(parseResult('chat.stop', {}).ok).toBe(false);
  });
});

describe('parseEvent', () => {
  const eventOf = (method: string, payload: unknown) =>
    ({ id: 'e1', kind: 'event', method, payload }) as const;

  it('accepts a chat delta on the shell', () => {
    const payload = { type: 'delta', streamId, content: 'Hi' };
    expect(parseEvent(eventOf('chat.event', payload), 'toShell')).toEqual({
      ok: true,
      value: { id: 'e1', method: 'chat.event', payload },
    });
  });

  it('rejects events in the wrong direction or with bad payloads', () => {
    const payload = { type: 'delta', streamId, content: 'Hi' };
    expect(parseEvent(eventOf('chat.event', payload), 'toAgent')).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    });
    expect(parseEvent(eventOf('chat.event', { type: 'delta' }), 'toShell')).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(parseEvent(eventOf('system.ping', {}), 'toShell')).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
    });
  });
});
