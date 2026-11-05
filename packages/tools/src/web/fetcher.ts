import { createHash } from 'node:crypto';
import { type SafeHttpClient, WebError } from './http-client.js';
import { decodeText, parseContentType, truncate } from './extract/decode.js';
import { extractDocx, isZip } from './extract/docx.js';
import { extractHtml } from './extract/html.js';
import { extractPdf, isPdf } from './extract/pdf.js';
import { canonicalizeUrl, parsePublicUrl } from './url.js';

export type DocumentKind = 'html' | 'pdf' | 'docx' | 'text';

/** A fetched page reduced to text. Everything in it is untrusted web content. */
export interface FetchedDocument {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  /** Canonical form of finalUrl (see canonicalizeUrl), used for duplicate detection. */
  readonly canonicalUrl: string;
  readonly redirects: readonly string[];
  readonly status: number;
  readonly kind: DocumentKind;
  /** Media type as served (without parameters). */
  readonly contentType: string;
  readonly byteLength: number;
  /** SHA-256 of the downloaded bytes. */
  readonly sha256: string;
  readonly retrievedAt: string;
  readonly title: string | null;
  readonly text: string;
  readonly truncated: boolean;
  readonly metadata: {
    readonly description?: string;
    readonly lang?: string;
    readonly author?: string;
    readonly publishedAt?: string;
    readonly siteName?: string;
    /** `<link rel=canonical>` declared by the page (informational only; not trusted). */
    readonly declaredCanonicalUrl?: string;
    readonly pages?: number;
    readonly extractedPages?: number;
  };
}

export interface WebFetcher {
  fetch(url: string, options?: { signal?: AbortSignal }): Promise<FetchedDocument>;
}

export interface WebFetcherOptions {
  /** Maximum characters of extracted text kept (default 1,000,000). */
  readonly maxTextChars?: number;
  /** Maximum PDF pages read (default 300). */
  readonly maxPdfPages?: number;
  readonly now?: () => Date;
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown', 'text/csv']);
/** Generic types that require sniffing the bytes. */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const ACCEPT = [
  'text/html',
  'application/xhtml+xml;q=0.9',
  'application/pdf;q=0.9',
  `${DOCX_TYPE};q=0.8`,
  'text/plain;q=0.8',
  '*/*;q=0.1',
].join(', ');

/**
 * Decides how to read a response. The served type wins, except that generic
 * types are sniffed, and a PDF/DOCX type must match its magic bytes. Anything
 * else (images, executables, archives, scripts, JSON ...) is refused.
 */
export function detectKind(mimeType: string, bytes: Uint8Array): DocumentKind {
  if (mimeType === 'application/pdf' || mimeType === 'application/x-pdf') {
    if (!isPdf(bytes)) throw new WebError('unsupported-content', 'Served as PDF but is not a PDF.');
    return 'pdf';
  }
  if (mimeType === DOCX_TYPE) {
    if (!isZip(bytes)) throw new WebError('unsupported-content', 'Served as DOCX but is not one.');
    return 'docx';
  }
  if (HTML_TYPES.has(mimeType)) return 'html';
  if (TEXT_TYPES.has(mimeType)) return 'text';
  if (GENERIC_TYPES.has(mimeType)) {
    if (isPdf(bytes)) return 'pdf';
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  }
  throw new WebError(
    'unsupported-content',
    `Unsupported content type "${mimeType || 'unknown'}". Only HTML, PDF, DOCX and plain text are read.`,
  );
}

/**
 * Fetches a URL through the SSRF-safe client and extracts its text. Nothing is
 * written to disk and nothing downloaded is ever executed or opened by another
 * program; all parsing happens in memory.
 */
export function createWebFetcher(
  http: SafeHttpClient,
  options: WebFetcherOptions = {},
): WebFetcher {
  const maxTextChars = options.maxTextChars ?? 1_000_000;
  const now = options.now ?? (() => new Date());

  return {
    async fetch(rawUrl, fetchOptions = {}) {
      const checked = parsePublicUrl(rawUrl);
      if (!checked.ok) throw new WebError('blocked-url', checked.error.message);

      const res = await http.get(checked.value.href, {
        accept: ACCEPT,
        ...(fetchOptions.signal && { signal: fetchOptions.signal }),
      });
      const { mimeType, charset } = parseContentType(res.contentType);
      const kind = detectKind(mimeType, res.body);

      let title: string | null = null;
      let text: string;
      let metadata: FetchedDocument['metadata'] = {};
      if (kind === 'html') {
        const html = extractHtml(decodeText(res.body, charset, true), res.finalUrl);
        title = html.title;
        text = html.text;
        metadata = {
          ...(html.description && { description: html.description }),
          ...(html.lang && { lang: html.lang }),
          ...(html.author && { author: html.author }),
          ...(html.publishedAt && { publishedAt: html.publishedAt }),
          ...(html.siteName && { siteName: html.siteName }),
          ...(html.canonicalUrl && { declaredCanonicalUrl: html.canonicalUrl }),
        };
      } else if (kind === 'pdf') {
        const pdf = await extractPdf(res.body, {
          maxPages: options.maxPdfPages ?? 300,
          maxChars: maxTextChars,
          ...(fetchOptions.signal && { signal: fetchOptions.signal }),
        });
        title = pdf.title;
        text = pdf.text;
        metadata = {
          ...(pdf.author && { author: pdf.author }),
          ...(pdf.createdAt && { publishedAt: pdf.createdAt }),
          pages: pdf.totalPages,
          extractedPages: pdf.extractedPages,
        };
      } else if (kind === 'docx') {
        const docx = extractDocx(res.body);
        title = docx.title;
        text = docx.text;
        metadata = {
          ...(docx.author && { author: docx.author }),
          ...(docx.createdAt && { publishedAt: docx.createdAt }),
        };
      } else {
        text = decodeText(res.body, charset).replace(/\r\n?/g, '\n').trim();
      }

      const limited = truncate(text, maxTextChars);
      return {
        requestedUrl: res.requestedUrl,
        finalUrl: res.finalUrl,
        canonicalUrl: canonicalizeUrl(res.finalUrl),
        redirects: res.redirects,
        status: res.status,
        kind,
        contentType: mimeType || 'application/octet-stream',
        byteLength: res.body.length,
        sha256: createHash('sha256').update(res.body).digest('hex'),
        retrievedAt: now().toISOString(),
        title,
        text: limited.text,
        truncated: limited.truncated || (metadata.extractedPages ?? 0) < (metadata.pages ?? 0),
        metadata,
      };
    },
  };
}
