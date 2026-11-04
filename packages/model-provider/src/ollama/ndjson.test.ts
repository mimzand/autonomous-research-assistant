import { describe, expect, it } from 'vitest';
import { ModelProviderError } from '../errors.js';
import { parseNdjson } from './ndjson.js';

function streamOf(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of parseNdjson(stream)) out.push(value);
  return out;
}

describe('parseNdjson', () => {
  it('parses one object per line', async () => {
    expect(await collect(streamOf(['{"a":1}\n{"a":2}\n']))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('joins lines split across chunks and skips blank lines', async () => {
    expect(await collect(streamOf(['{"a"', ':1}\n\n{"b":', '2}\n']))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles a final line without a trailing newline', async () => {
    expect(await collect(streamOf(['{"a":1}\n{"a":2}']))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('handles multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"t":"سلام"}\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual([{ t: 'سلام' }]);
  });

  it('rejects malformed lines as invalid-response', async () => {
    await expect(collect(streamOf(['{"a":1}\nnot json\n']))).rejects.toMatchObject({
      code: 'invalid-response',
    });
    await expect(collect(streamOf(['oops\n']))).rejects.toBeInstanceOf(ModelProviderError);
  });

  it('reports every received chunk', async () => {
    let calls = 0;
    for await (const _ of parseNdjson(streamOf(['{"a":1}\n', '{"a":2}\n']), () => calls++)) {
      // drain
    }
    expect(calls).toBe(2);
  });
});
