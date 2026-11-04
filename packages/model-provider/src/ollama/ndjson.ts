import { ModelProviderError } from '../errors.js';

/**
 * Parses a newline-delimited JSON byte stream (Ollama's streaming format).
 * Handles lines split across chunks and a final line without a newline.
 * Calls `onData` for every received chunk so callers can reset idle timers.
 */
export async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
  onData: () => void = () => undefined,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onData();
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) yield parseLine(line);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseLine(buffer);
  } finally {
    // Cancels the underlying request if the consumer stopped early.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (cause) {
    throw new ModelProviderError(
      'invalid-response',
      `Model server sent a malformed stream line: ${truncate(line)}`,
      { cause },
    );
  }
}

export function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
