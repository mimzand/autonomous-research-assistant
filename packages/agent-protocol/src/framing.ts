import { err, type Result } from '@rka/shared';
import {
  decodeEnvelope,
  encodeEnvelope,
  FRAME_HEADER_BYTES,
  MAX_FRAME_BYTES,
  type Envelope,
} from './envelope.js';
import { protocolError, type ProtocolError } from './errors.js';

// Web-standard globals (Node, Electron, browsers). Declared locally because this
// package compiles without DOM or Node typings.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean },
) => { decode(input: Uint8Array): string };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Serialises one envelope into a frame: 4-byte big-endian length + UTF-8 JSON. */
export function encodeFrame(envelope: Envelope, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array {
  const body = utf8Encoder.encode(encodeEnvelope(envelope));
  if (body.byteLength > maxFrameBytes) {
    throw new RangeError(
      `Envelope of ${body.byteLength} bytes exceeds the ${maxFrameBytes}-byte frame limit.`,
    );
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Incremental decoder for a byte stream of frames. `push` returns one result per
 * complete frame, in order. The first error (oversized header, invalid UTF-8,
 * invalid envelope) is the last result: the decoder then ignores all further input,
 * and the receiver must close the connection.
 */
export class FrameDecoder {
  /** Largest accepted frame body. A server may keep it small until the handshake. */
  maxFrameBytes: number;
  #chunks: Uint8Array[] = [];
  #buffered = 0;
  #bodyLength: number | null = null;
  #failed = false;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  get failed(): boolean {
    return this.#failed;
  }

  push(chunk: Uint8Array): Result<Envelope, ProtocolError>[] {
    if (this.#failed) return [];
    if (chunk.byteLength > 0) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.byteLength;
    }
    const results: Result<Envelope, ProtocolError>[] = [];
    for (;;) {
      if (this.#bodyLength === null) {
        if (this.#buffered < FRAME_HEADER_BYTES) break;
        const header = this.#take(FRAME_HEADER_BYTES);
        const length = new DataView(header.buffer, header.byteOffset, FRAME_HEADER_BYTES).getUint32(
          0,
          false,
        );
        if (length > this.maxFrameBytes) {
          results.push(this.#fail(`Frame of ${length} bytes exceeds the size limit.`));
          break;
        }
        this.#bodyLength = length;
      }
      if (this.#buffered < this.#bodyLength) break;
      const body = this.#take(this.#bodyLength);
      this.#bodyLength = null;
      let text: string;
      try {
        text = utf8Decoder.decode(body);
      } catch {
        results.push(this.#fail('Frame is not valid UTF-8.'));
        break;
      }
      const result = decodeEnvelope(text);
      results.push(result);
      if (!result.ok) {
        this.#failed = true;
        this.#chunks = [];
        break;
      }
    }
    return results;
  }

  #fail(message: string): Result<never, ProtocolError> {
    this.#failed = true;
    this.#chunks = [];
    return err(protocolError('bad_frame', message));
  }

  /** Removes and returns the first `n` buffered bytes (n <= #buffered). */
  #take(n: number): Uint8Array {
    this.#buffered -= n;
    const first = this.#chunks[0];
    if (first && first.byteLength >= n) {
      if (first.byteLength === n) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.#chunks[0];
      if (!chunk) throw new Error('FrameDecoder buffer underrun.');
      const used = Math.min(chunk.byteLength, n - offset);
      out.set(chunk.subarray(0, used), offset);
      offset += used;
      if (used === chunk.byteLength) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(used);
    }
    return out;
  }
}
