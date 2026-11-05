import { TextDecoder } from 'node:util';

/** Parses `type/subtype; charset=x` into its parts (lower-cased). */
export function parseContentType(header: string | null | undefined): {
  mimeType: string;
  charset?: string;
} {
  if (!header) return { mimeType: '' };
  const [type = '', ...params] = header.split(';');
  const charset = params
    .map((p) => p.trim().split('='))
    .find(([key]) => key?.trim().toLowerCase() === 'charset')?.[1];
  return {
    mimeType: type.trim().toLowerCase(),
    ...(charset && {
      charset: charset
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase(),
    }),
  };
}

function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label);
  } catch {
    return undefined; // Unknown label.
  }
}

/**
 * Decodes text with the WHATWG precedence: byte order mark, then the HTTP
 * charset, then (for HTML) a `<meta charset>` in the first 1024 bytes, then UTF-8.
 * Invalid sequences become U+FFFD; decoding never throws.
 */
export function decodeText(bytes: Uint8Array, httpCharset?: string, sniffHtmlMeta = false): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);

  let decoder = decoderFor(httpCharset);
  if (!decoder && sniffHtmlMeta) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    const meta =
      /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head) ??
      /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head);
    decoder = decoderFor(meta?.[1]);
  }
  return (decoder ?? new TextDecoder('utf-8')).decode(bytes);
}

/** Collapses runs of spaces, trims lines and limits blank lines to one. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\t\f\v ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncates to `maxChars` without splitting a surrogate pair. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
