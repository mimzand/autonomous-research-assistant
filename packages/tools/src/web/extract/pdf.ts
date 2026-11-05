import { getDocumentProxy } from 'unpdf';
import { WebError } from '../http-client.js';
import { normalizeWhitespace } from './decode.js';

export interface PdfExtraction {
  readonly title: string | null;
  readonly author: string | null;
  readonly createdAt: string | null;
  readonly text: string;
  readonly totalPages: number;
  readonly extractedPages: number;
}

export interface PdfOptions {
  readonly signal?: AbortSignal;
  /** Stop after this many pages (default 300). */
  readonly maxPages?: number;
  /** Stop once this much text has been collected (default 2,000,000 chars). */
  readonly maxChars?: number;
}

export const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 && Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-');

/** `D:20240115093000+01'00'` -> ISO 8601, or null. */
export function parsePdfDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(value);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz] = m;
  const zone = !tz || tz === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.replace(/'/g, '').slice(3, 5)}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const infoString = (info: Record<string, unknown>, key: string) => {
  const value = info[key];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 1000) : null;
};

/**
 * Extracts text from a PDF with Mozilla pdf.js (via unpdf). The document is
 * parsed in memory only: scripting and XFA are off, fonts are not installed,
 * and the serverless pdf.js build bundled by unpdf contains no eval/Function
 * code path (font programs are interpreted, never compiled).
 */
export async function extractPdf(
  bytes: Uint8Array,
  options: PdfOptions = {},
): Promise<PdfExtraction> {
  const maxPages = options.maxPages ?? 300;
  const maxChars = options.maxChars ?? 2_000_000;
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0, // Errors only.
    });
  } catch (error) {
    throw new WebError('extraction-failed', `Could not read the PDF: ${errorText(error)}`);
  }

  try {
    const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
    const fields = (info ?? {}) as Record<string, unknown>;
    const pages: string[] = [];
    let chars = 0;
    const last = Math.min(pdf.numPages, maxPages);
    for (let n = 1; n <= last && chars < maxChars; n++) {
      options.signal?.throwIfAborted();
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str;
          if (item.hasEOL) text += '\n';
        }
      }
      page.cleanup();
      const clean = normalizeWhitespace(text);
      pages.push(clean);
      chars += clean.length;
    }
    return {
      title: infoString(fields, 'Title'),
      author: infoString(fields, 'Author'),
      createdAt: parsePdfDate(fields['CreationDate']),
      text: pages.filter(Boolean).join('\n\n'),
      totalPages: pdf.numPages,
      extractedPages: pages.length,
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new WebError('extraction-failed', `Could not extract PDF text: ${errorText(error)}`);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
