import { createHash } from 'node:crypto';
import { type FetchedDocument } from './fetcher.js';
import { canonicalizeUrl } from './url.js';

export interface StoredSourceRef {
  readonly id: string;
  readonly url: string;
  readonly title: string | null;
}

/** Metadata stored with a source. Plain JSON. */
export interface SourceMetadata {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly redirects: readonly string[];
  readonly httpStatus: number;
  readonly kind: FetchedDocument['kind'];
  readonly contentType: string;
  readonly byteLength: number;
  /** SHA-256 of the downloaded bytes (the stored text has its own hash). */
  readonly rawSha256: string;
  readonly truncated: boolean;
  readonly description?: string;
  readonly lang?: string;
  readonly author?: string;
  readonly publishedAt?: string;
  readonly siteName?: string;
  readonly declaredCanonicalUrl?: string;
  readonly pages?: number;
  readonly extractedPages?: number;
}

export interface SourceToSave {
  /** Canonical URL; unique per task. */
  readonly url: string;
  readonly title: string | null;
  readonly retrievedAt: string;
  readonly metadata: SourceMetadata;
  readonly contentType: string;
  readonly text: string;
}

/**
 * Where collected sources are kept. Implemented by the agent runtime on top
 * of SQLite; the tools package only depends on this interface.
 */
export interface SourceStore {
  /** Source recorded for the task under this canonical URL. */
  findByUrl(taskId: string, canonicalUrl: string): StoredSourceRef | undefined;
  /** Source of the task whose stored text has this SHA-256 (UTF-8). */
  findByContentHash(taskId: string, textSha256: string): StoredSourceRef | undefined;
  /** Saves the source and its text atomically. */
  save(taskId: string, source: SourceToSave): StoredSourceRef;
}

export const textSha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface DuplicateMatch {
  readonly source: StoredSourceRef;
  readonly reason: 'same-url' | 'same-content';
}

/**
 * Finds an existing source for the same page:
 * 1. same canonical URL (requested, any redirect hop, or final), or
 * 2. same extracted text (e.g. http/https or mirror URLs of one document).
 */
export function findDuplicate(
  store: SourceStore,
  taskId: string,
  candidate: { readonly urls: readonly string[]; readonly text?: string },
): DuplicateMatch | null {
  const seen = new Set<string>();
  for (const url of candidate.urls) {
    let canonical: string;
    try {
      canonical = canonicalizeUrl(url);
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const source = store.findByUrl(taskId, canonical);
    if (source) return { source, reason: 'same-url' };
  }
  if (candidate.text) {
    const source = store.findByContentHash(taskId, textSha256(candidate.text));
    if (source) return { source, reason: 'same-content' };
  }
  return null;
}

export function toSourceToSave(doc: FetchedDocument): SourceToSave {
  return {
    url: doc.canonicalUrl,
    title: doc.title,
    retrievedAt: doc.retrievedAt,
    contentType: 'text/plain',
    text: doc.text,
    metadata: {
      requestedUrl: doc.requestedUrl,
      finalUrl: doc.finalUrl,
      redirects: doc.redirects,
      httpStatus: doc.status,
      kind: doc.kind,
      contentType: doc.contentType,
      byteLength: doc.byteLength,
      rawSha256: doc.sha256,
      truncated: doc.truncated,
      ...doc.metadata,
    },
  };
}
