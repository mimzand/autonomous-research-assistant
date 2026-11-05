import { type ResearchError } from '@rka/shared';

/** Short, user-facing explanation for each research tool error code. */
const HINTS: Record<string, { title: string; hint: string }> = {
  'blocked-url': {
    title: 'URL refused',
    hint: 'Only public http(s) addresses can be fetched. Localhost, private networks, link-local and cloud metadata addresses are blocked, also after redirects.',
  },
  'blocked-address': {
    title: 'Address refused',
    hint: 'The host name resolves to a private or internal address, so the request was not sent.',
  },
  'invalid-redirect': {
    title: 'Redirect refused',
    hint: 'The site redirected to an address that is not allowed.',
  },
  'redirect-downgrade': {
    title: 'Insecure redirect',
    hint: 'The site redirected from https to http.',
  },
  'too-many-redirects': {
    title: 'Too many redirects',
    hint: 'The site redirected more than 5 times.',
  },
  'dns-failed': {
    title: 'Host not found',
    hint: 'Check the address and your internet connection.',
  },
  timeout: {
    title: 'Timed out',
    hint: 'The server did not answer in time (see the limits below).',
  },
  cancelled: { title: 'Cancelled', hint: 'The request was stopped.' },
  'too-large': {
    title: 'Too large',
    hint: 'The content is larger than the configured limit (WEB_MAX_DOWNLOAD_BYTES).',
  },
  'http-error': { title: 'HTTP error', hint: 'The server answered with an error status.' },
  'network-error': {
    title: 'Network error',
    hint: 'The connection failed (offline, refused or TLS problem).',
  },
  'unsupported-content': {
    title: 'Unsupported content',
    hint: 'Only HTML, PDF, DOCX and plain text can be extracted. Other types are never opened.',
  },
  'extraction-failed': { title: 'Extraction failed', hint: 'The document could not be read.' },
  'not-configured': {
    title: 'Search is off',
    hint: 'Set SEARXNG_URL in .env and restart the app.',
  },
  'no-selection': { title: 'No file selected', hint: 'Choose the file again.' },
  unreadable: { title: 'Cannot read file', hint: 'Check that the file exists and is not locked.' },
};

export function describeError(error: ResearchError): { title: string; hint: string } {
  return HINTS[error.code] ?? { title: 'Failed', hint: '' };
}

let counter = 0;
/** Unique id for a request, so it can be cancelled. */
export function newRequestId(): string {
  counter += 1;
  return `r${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** "3 results · 412 ms" */
export function resultSummary(count: number, durationMs: number): string {
  return `${count} result${count === 1 ? '' : 's'} · ${formatMs(durationMs)}`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Labels for metadata keys shown in the inspector. */
export const METADATA_LABELS: Record<string, string> = {
  description: 'Description',
  lang: 'Language',
  author: 'Author',
  publishedAt: 'Published',
  siteName: 'Site',
  declaredCanonicalUrl: 'Declared canonical URL',
  pages: 'Pages',
  extractedPages: 'Pages extracted',
};
