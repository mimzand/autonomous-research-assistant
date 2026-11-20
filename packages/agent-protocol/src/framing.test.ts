import { describe, expect, it } from 'vitest';
import { FRAME_HEADER_BYTES, MAX_FRAME_BYTES, type Envelope } from './envelope.js';
import { encodeFrame, FrameDecoder } from './framing.js';

const ping: Envelope = { id: 'r1', kind: 'req', method: 'system.ping', payload: { nonce: 'é✓' } };
const pong: Envelope = { id: 'r1', kind: 'res', method: 'system.ping', payload: null };

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const header = (length: number) => {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES);
  new DataView(bytes.buffer).setUint32(0, length, false);
  return bytes;
};

describe('encodeFrame', () => {
  it('writes a big-endian byte length followed by the UTF-8 body', () => {
    const frame = encodeFrame(ping);
    const length = new DataView(frame.buffer).getUint32(0, false);
    expect(length).toBe(frame.byteLength - FRAME_HEADER_BYTES);
    // Multi-byte characters: byte length is larger than the string length.
    expect(length).toBeGreaterThan(JSON.stringify(ping).length);
  });

  it('refuses envelopes over the limit and invalid envelopes', () => {
    expect(() => encodeFrame(ping, 10)).toThrow(RangeError);
    expect(() => encodeFrame({ ...ping, id: '' })).toThrow();
  });
});

describe('FrameDecoder', () => {
  it('decodes several frames delivered in one chunk', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(concat(encodeFrame(ping), encodeFrame(pong)))).toEqual([
      { ok: true, value: ping },
      { ok: true, value: pong },
    ]);
  });

  it('decodes a frame delivered one byte at a time', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(ping);
    const results = [];
    for (let i = 0; i < frame.byteLength; i++) {
      results.push(...decoder.push(frame.subarray(i, i + 1)));
      if (i < frame.byteLength - 1) expect(results).toEqual([]);
    }
    expect(results).toEqual([{ ok: true, value: ping }]);
  });

  it('decodes frames split across chunk boundaries', () => {
    const decoder = new FrameDecoder();
    const bytes = concat(encodeFrame(ping), encodeFrame(pong));
    const cut = FRAME_HEADER_BYTES + 3;
    expect(decoder.push(bytes.subarray(0, cut))).toEqual([]);
    expect(decoder.push(bytes.subarray(cut, bytes.byteLength - 2))).toEqual([
      { ok: true, value: ping },
    ]);
    expect(decoder.push(bytes.subarray(bytes.byteLength - 2))).toEqual([{ ok: true, value: pong }]);
  });

  it('rejects an oversized header without waiting for the body, then ignores input', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(header(MAX_FRAME_BYTES + 1))).toMatchObject([
      { ok: false, error: { code: 'bad_frame' } },
    ]);
    expect(decoder.failed).toBe(true);
    expect(decoder.push(encodeFrame(ping))).toEqual([]);
  });

  it('treats an HTTP request as an oversized frame', () => {
    const http = new Uint8Array([...'GET / HTTP/1.1\r\n\r\n'].map((c) => c.charCodeAt(0)));
    expect(new FrameDecoder().push(http)).toMatchObject([
      { ok: false, error: { code: 'bad_frame' } },
    ]);
  });

  it('enforces a lowered limit and accepts larger frames once raised', () => {
    const decoder = new FrameDecoder(8);
    expect(decoder.push(encodeFrame(ping))).toMatchObject([{ ok: false }]);
    const raised = new FrameDecoder(8);
    raised.maxFrameBytes = MAX_FRAME_BYTES;
    expect(raised.push(encodeFrame(ping))).toEqual([{ ok: true, value: ping }]);
  });

  it('rejects invalid UTF-8', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(concat(header(1), new Uint8Array([0xff])))).toEqual([
      { ok: false, error: { code: 'bad_frame', message: 'Frame is not valid UTF-8.' } },
    ]);
  });

  it('rejects an empty or non-envelope body and stops after the first error', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(concat(header(0), encodeFrame(ping)))).toMatchObject([
      { ok: false, error: { code: 'bad_frame' } },
    ]);
    expect(decoder.failed).toBe(true);
  });

  it('keeps earlier frames when a later one in the same chunk is bad', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(concat(encodeFrame(ping), header(0)))).toMatchObject([
      { ok: true, value: ping },
      { ok: false, error: { code: 'bad_frame' } },
    ]);
  });
});
