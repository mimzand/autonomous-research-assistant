import { describe, expect, it } from 'vitest';
import { decodeEnvelope, encodeEnvelope, EnvelopeSchema, type Envelope } from './envelope.js';

const req = { id: 'r1', kind: 'req', method: 'system.ping', payload: {} };

describe('EnvelopeSchema', () => {
  it.each([
    req,
    { id: 'r1', kind: 'res', method: 'system.ping', payload: { agentTime: 'x' } },
    { id: 'e-9', kind: 'event', method: 'chat.event', payload: null },
    {
      id: 'r1',
      kind: 'error',
      method: 'system.ping',
      payload: { code: 'not_implemented', message: 'later' },
    },
  ])('accepts a $kind envelope', (envelope) => {
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it.each([
    ['unknown kind', { ...req, kind: 'notify' }],
    ['missing id', { kind: 'req', method: 'system.ping', payload: {} }],
    ['empty id', { ...req, id: '' }],
    ['id with spaces', { ...req, id: 'a b' }],
    ['id too long', { ...req, id: 'a'.repeat(65) }],
    ['numeric id', { ...req, id: 1 }],
    ['missing method', { id: 'r1', kind: 'req', payload: {} }],
    ['method without namespace', { ...req, method: 'ping' }],
    ['upper-case namespace', { ...req, method: 'System.ping' }],
    ['empty segment', { ...req, method: 'system..ping' }],
    ['method with spaces', { ...req, method: 'system.ping ' }],
    ['method too long', { ...req, method: `a.${'b'.repeat(63)}` }],
    ['extra key', { ...req, token: 'x' }],
    ['error with unknown code', { ...req, kind: 'error', payload: { code: 'nope', message: '' } }],
    ['error without payload', { id: 'r1', kind: 'error', method: 'system.ping' }],
    ['array', [req]],
    ['null', null],
  ])('rejects %s', (_label, envelope) => {
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(false);
  });
});

describe('decodeEnvelope', () => {
  it('parses a valid frame body', () => {
    const result = decodeEnvelope(JSON.stringify(req));
    expect(result).toEqual({ ok: true, value: req });
  });

  it('rejects text that is not JSON', () => {
    const result = decodeEnvelope('{"id":');
    expect(result).toEqual({
      ok: false,
      error: { code: 'bad_frame', message: 'Frame is not valid JSON.' },
    });
  });

  it('rejects JSON that is not an envelope, naming paths but not values', () => {
    const secret = 'SECRET-VALUE-should-not-leak';
    const result = decodeEnvelope(JSON.stringify({ ...req, id: secret, kind: secret }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bad_frame');
    expect(result.error.message).not.toContain(secret);
  });
});

describe('encodeEnvelope', () => {
  it('round-trips through decodeEnvelope', () => {
    const envelope: Envelope = {
      id: 'x1',
      kind: 'error',
      method: 'system.error',
      payload: { code: 'bad_frame', message: 'Frame is not valid JSON.' },
    };
    expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual({ ok: true, value: envelope });
  });

  it('refuses to serialise an invalid envelope', () => {
    expect(() => encodeEnvelope({ ...req, id: '' } as Envelope)).toThrow();
  });
});
