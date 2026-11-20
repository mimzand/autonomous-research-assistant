import { describe, expect, it } from 'vitest';
import { type Envelope } from './envelope.js';
import {
  AgentStateFileSchema,
  HelloAckSchema,
  HelloRequestSchema,
  parseHello,
  PROTOCOL_VERSION,
} from './handshake.js';

const token = 'A'.repeat(20) + '_-' + 'z9'.repeat(11); // 44 base64url chars
const hello = {
  protocol: 'rka-agent',
  version: PROTOCOL_VERSION,
  token,
  client: { kind: 'shell', version: '0.0.0' },
};
const helloEnvelope = (payload: unknown): Envelope => ({
  id: 'h1',
  kind: 'req',
  method: 'system.hello',
  payload,
});

describe('HelloRequestSchema', () => {
  it('accepts a well-formed hello', () => {
    expect(HelloRequestSchema.parse(hello)).toEqual(hello);
  });

  it.each([
    ['wrong protocol', { ...hello, protocol: 'other' }],
    ['missing token', { ...hello, token: undefined }],
    ['short token', { ...hello, token: 'a'.repeat(42) }],
    ['long token', { ...hello, token: 'a'.repeat(129) }],
    ['token with invalid characters', { ...hello, token: `${'a'.repeat(42)}=` }],
    ['fractional version', { ...hello, version: 1.5 }],
    ['zero version', { ...hello, version: 0 }],
    ['unknown client kind', { ...hello, client: { kind: 'renderer', version: '1' } }],
    ['extra key', { ...hello, admin: true }],
  ])('rejects %s', (_label, value) => {
    expect(HelloRequestSchema.safeParse(value).success).toBe(false);
  });
});

describe('HelloAckSchema', () => {
  const ack = {
    protocol: 'rka-agent',
    version: PROTOCOL_VERSION,
    sessionId: '7d3b2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    agent: { pid: 1234, version: '0.0.0', startedAt: '2026-11-14T11:37:00.000Z' },
  };

  it('accepts a well-formed ack', () => {
    expect(HelloAckSchema.parse(ack)).toEqual(ack);
  });

  it.each([
    ['other version', { ...ack, version: PROTOCOL_VERSION + 1 }],
    ['non-uuid session', { ...ack, sessionId: 'abc' }],
    ['echoed token', { ...ack, token }],
    ['bad startedAt', { ...ack, agent: { ...ack.agent, startedAt: 'yesterday' } }],
  ])('rejects %s', (_label, value) => {
    expect(HelloAckSchema.safeParse(value).success).toBe(false);
  });
});

describe('parseHello', () => {
  it('returns the request id and hello', () => {
    expect(parseHello(helloEnvelope(hello))).toEqual({ ok: true, value: { id: 'h1', hello } });
  });

  it('rejects a first message that is not system.hello', () => {
    const result = parseHello({ id: 'p1', kind: 'req', method: 'system.ping', payload: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });

  it('rejects a hello sent as an event', () => {
    const result = parseHello({ ...helloEnvelope(hello), kind: 'event' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });

  it('rejects a malformed hello without echoing its content', () => {
    const leaked = 'SECRET=TOKEN=VALUE=' + 'x'.repeat(30);
    const result = parseHello(helloEnvelope({ ...hello, token: leaked }));
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    if (!result.ok) expect(result.error.message).not.toContain('SECRET');
  });

  it('reports an unsupported protocol version distinctly', () => {
    const result = parseHello(helloEnvelope({ ...hello, version: PROTOCOL_VERSION + 1 }));
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported_version' } });
  });
});

describe('AgentStateFileSchema', () => {
  const state = {
    protocol: 'rka-agent',
    version: PROTOCOL_VERSION,
    host: '127.0.0.1',
    port: 49_152,
    token,
    pid: 4321,
    startedAt: '2026-11-14T11:37:00.000Z',
  };

  it('accepts a loopback state file', () => {
    expect(AgentStateFileSchema.parse(state)).toEqual(state);
  });

  it.each([
    ['all interfaces', { ...state, host: '0.0.0.0' }],
    ['hostname', { ...state, host: 'localhost' }],
    ['LAN address', { ...state, host: '192.168.1.10' }],
    ['port 0', { ...state, port: 0 }],
    ['port out of range', { ...state, port: 70_000 }],
    ['weak token', { ...state, token: 'short' }],
  ])('rejects %s', (_label, value) => {
    expect(AgentStateFileSchema.safeParse(value).success).toBe(false);
  });
});
