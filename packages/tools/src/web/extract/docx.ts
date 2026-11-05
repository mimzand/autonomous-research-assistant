import { unzipSync } from 'fflate/browser';
import { Parser } from 'htmlparser2';
import { WebError } from '../http-client.js';
import { normalizeWhitespace } from './decode.js';

export interface DocxExtraction {
  readonly title: string | null;
  readonly author: string | null;
  readonly createdAt: string | null;
  readonly text: string;
}

export interface DocxOptions {
  /** Maximum uncompressed size of a single part we read (default 50 MB). */
  readonly maxPartBytes?: number;
}

const DOCUMENT = 'word/document.xml';
const CORE = 'docProps/core.xml';

/** ZIP local file header. A DOCX is a ZIP package. */
export const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

function unzipParts(bytes: Uint8Array, maxPartBytes: number): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      // Only decompress the two parts we need; refuse oversized ones up front.
      filter: (file) => {
        if (file.name !== DOCUMENT && file.name !== CORE) return false;
        if (file.originalSize > maxPartBytes) {
          throw new WebError(
            'too-large',
            `${file.name} would decompress to ${file.originalSize} bytes (limit ${maxPartBytes}).`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof WebError) throw error;
    throw new WebError('extraction-failed', `Not a readable DOCX (ZIP) file: ${errorText(error)}`);
  }
}

/** Reads the visible body text of word/document.xml. */
function documentText(xml: string): string {
  const out: string[] = [];
  let inText = false;
  let skip = 0; // Inside deleted text, field codes, etc.
  const SKIP = new Set(['w:deltext', 'w:instrtext', 'w:delinstrtext', 'w:fldsimple-instr']);
  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP.has(name)) skip++;
        else if (name === 'w:t') inText = true;
        else if (name === 'w:tab') out.push('\t');
        else if (name === 'w:br' || name === 'w:cr') out.push('\n');
        else if (name === 'w:tc') out.push(' | ');
      },
      ontext(text) {
        if (inText && skip === 0) out.push(text);
      },
      onclosetag(name) {
        if (SKIP.has(name)) skip--;
        else if (name === 'w:t') inText = false;
        else if (name === 'w:p') out.push('\n');
        else if (name === 'w:tr') out.push('\n');
      },
    },
    // XML mode: no HTML rules, no DTD or external entity resolution.
    { xmlMode: true, decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(xml);
  parser.end();
  return normalizeWhitespace(out.join(''));
}

function coreProperties(xml: string | undefined) {
  const props: Record<string, string> = {};
  if (!xml) return props;
  let current: string | null = null;
  const parser = new Parser(
    {
      onopentag(name) {
        current = name;
      },
      ontext(text) {
        if (current) props[current] = (props[current] ?? '') + text;
      },
      onclosetag() {
        current = null;
      },
    },
    { xmlMode: true, decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(xml);
  parser.end();
  return props;
}

/**
 * Extracts text from a Word .docx file. Only the main document part and the
 * core properties are decompressed; macros, embedded objects and external
 * relationships are never read or followed.
 */
export function extractDocx(bytes: Uint8Array, options: DocxOptions = {}): DocxExtraction {
  const parts = unzipParts(bytes, options.maxPartBytes ?? 50 * 1024 * 1024);
  const doc = parts[DOCUMENT];
  if (!doc)
    throw new WebError('extraction-failed', 'Not a Word document (word/document.xml missing).');
  const decode = (b: Uint8Array | undefined) =>
    b ? new TextDecoder('utf-8').decode(b) : undefined;
  const core = coreProperties(decode(parts[CORE]));
  const field = (key: string) => core[key]?.trim().slice(0, 1000) || null;
  const created = field('dcterms:created');
  return {
    title: field('dc:title'),
    author: field('dc:creator'),
    createdAt:
      created && !Number.isNaN(Date.parse(created)) ? new Date(created).toISOString() : null,
    text: documentText(decode(doc) ?? ''),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
