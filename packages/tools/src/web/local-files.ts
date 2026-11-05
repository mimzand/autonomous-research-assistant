import { createHash } from 'node:crypto';
import { isZip } from './extract/docx.js';
import { isPdf } from './extract/pdf.js';
import { extractDocument, type ExtractedDocument } from './fetcher.js';
import { WebError } from './http-client.js';

/** Local file types that can be extracted. The user picks the file; tools never take paths. */
export const LOCAL_DOCUMENT_TYPES = {
  pdf: { extensions: ['pdf'], label: 'PDF', contentType: 'application/pdf' },
  docx: {
    extensions: ['docx'],
    label: 'Word document',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
} as const;
export type LocalDocumentKind = keyof typeof LOCAL_DOCUMENT_TYPES;

export const fileExtension = (fileName: string) => {
  const match = /\.([^./\\]+)$/.exec(fileName);
  return match?.[1]?.toLowerCase() ?? '';
};

/**
 * Accepts only .pdf and .docx files whose contents match the extension
 * (PDF header / ZIP signature). A renamed executable or archive is refused.
 */
export function detectLocalKind(fileName: string, bytes: Uint8Array): LocalDocumentKind {
  const ext = fileExtension(fileName);
  if (ext === 'pdf') {
    if (!isPdf(bytes))
      throw new WebError('unsupported-content', 'The file is named .pdf but is not a PDF.');
    return 'pdf';
  }
  if (ext === 'docx') {
    if (!isZip(bytes)) {
      throw new WebError(
        'unsupported-content',
        'The file is named .docx but is not a Word document.',
      );
    }
    return 'docx';
  }
  throw new WebError(
    'unsupported-content',
    `Unsupported file type "${ext ? `.${ext}` : 'none'}". Only PDF and DOCX files can be extracted.`,
  );
}

export interface LocalExtraction extends ExtractedDocument {
  readonly contentType: string;
  readonly byteLength: number;
  /** SHA-256 of the file bytes. */
  readonly sha256: string;
}

/** Extracts text from the bytes of a user-selected file, in memory. */
export async function extractLocalDocument(
  fileName: string,
  bytes: Uint8Array,
  options: { maxBytes: number; maxTextChars?: number; signal?: AbortSignal },
): Promise<LocalExtraction> {
  if (bytes.length > options.maxBytes) {
    throw new WebError(
      'too-large',
      `The file is ${bytes.length} bytes (limit ${options.maxBytes}).`,
    );
  }
  const kind = detectLocalKind(fileName, bytes);
  const extracted = await extractDocument(kind, bytes, {
    ...(options.maxTextChars !== undefined && { maxTextChars: options.maxTextChars }),
    ...(options.signal && { signal: options.signal }),
  });
  return {
    ...extracted,
    contentType: LOCAL_DOCUMENT_TYPES[kind].contentType,
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
