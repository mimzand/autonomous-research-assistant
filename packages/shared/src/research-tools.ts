import { z } from 'zod';

/*
 * Research Tools playground contract. The renderer never sends file paths and
 * never gets raw network access: it asks main to search, fetch a URL (through
 * the SSRF-protected fetcher) or extract a file the user picked in a native
 * dialog. Everything extracted is untrusted data.
 */

const Duration = z.int().nonnegative();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const RequestId = z.string().min(1).max(100);

export const DocumentKindSchema = z.enum(['html', 'pdf', 'docx', 'text']);

/** Error codes produced by the web tools (WebError) plus playground-specific ones. */
export const ResearchErrorSchema = z.object({
  code: z.string().max(60),
  message: z.string().max(2000),
});
export type ResearchError = z.infer<typeof ResearchErrorSchema>;

// --- Status ----------------------------------------------------------------------

export const ResearchToolsStatusSchema = z.object({
  search: z.object({
    configured: z.boolean(),
    provider: z.string().nullable(),
    /** Origin of the configured SearXNG instance (no path or query). */
    endpoint: z.string().nullable(),
  }),
  limits: z.object({
    fetchTimeoutMs: z.int().positive(),
    searchTimeoutMs: z.int().positive(),
    maxDownloadBytes: z.int().positive(),
    maxFileBytes: z.int().positive(),
    /** Extracted text sent to the window is cut here (full text is still hashed/stored). */
    maxDisplayChars: z.int().positive(),
  }),
  fileTypes: z.array(z.string()),
});
export type ResearchToolsStatus = z.infer<typeof ResearchToolsStatusSchema>;

export const SearchHealthSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    provider: z.string(),
    endpoint: z.string(),
    latencyMs: Duration,
  }),
  z.object({ status: z.literal('not-configured'), message: z.string() }),
  z.object({
    status: z.literal('unavailable'),
    endpoint: z.string(),
    error: ResearchErrorSchema,
  }),
]);
export type SearchHealth = z.infer<typeof SearchHealthSchema>;

// --- Search ----------------------------------------------------------------------

export const ToolSearchRequestSchema = z.strictObject({
  requestId: RequestId,
  query: z.string().trim().min(1).max(400),
  limit: z.int().min(1).max(10).default(10),
});
export type ToolSearchRequest = z.input<typeof ToolSearchRequestSchema>;

export const ToolSearchResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    provider: z.string(),
    durationMs: Duration,
    results: z.array(
      z.object({
        position: z.int().positive(),
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        publishedAt: z.string().nullable(),
      }),
    ),
  }),
  z.object({ status: z.literal('error'), durationMs: Duration, error: ResearchErrorSchema }),
]);
export type ToolSearchResult = z.infer<typeof ToolSearchResultSchema>;

// --- Extraction (web and file) ---------------------------------------------------------

/** One extracted document as shown in the playground. Untrusted content. */
export const ExtractedSourceViewSchema = z.object({
  /** Opaque id for "save as test source" (web results only). */
  resultId: z.string(),
  origin: z.enum(['web', 'file']),
  /** URL (web) or file name (file). */
  label: z.string(),
  kind: DocumentKindSchema,
  contentType: z.string(),
  title: z.string().nullable(),
  /** Downloaded / file size in bytes. */
  byteLength: z.int().nonnegative(),
  /** SHA-256 of the downloaded bytes or file. */
  sha256: Sha256,
  /** SHA-256 of the extracted text (UTF-8) - what duplicate detection compares. */
  textSha256: Sha256,
  /** Characters of extracted text (before display truncation). */
  textLength: z.int().nonnegative(),
  /** Text was cut by the extraction limits (pages/characters). */
  truncated: z.boolean(),
  /** Only the first maxDisplayChars characters are included. */
  displayTruncated: z.boolean(),
  text: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number()])),
  web: z
    .object({
      requestedUrl: z.string(),
      finalUrl: z.string(),
      canonicalUrl: z.string(),
      redirects: z.array(z.string()),
      httpStatus: z.int(),
    })
    .nullable(),
  timings: z.object({ downloadMs: Duration.nullable(), extractMs: Duration, totalMs: Duration }),
  /** Web results can be saved as sources; files cannot (sources need an http(s) URL). */
  canSave: z.boolean(),
});
export type ExtractedSourceView = z.infer<typeof ExtractedSourceViewSchema>;

export const ExtractionResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), source: ExtractedSourceViewSchema }),
  z.object({ status: z.literal('error'), durationMs: Duration, error: ResearchErrorSchema }),
]);
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export const ToolFetchRequestSchema = z.strictObject({
  requestId: RequestId,
  url: z.string().trim().min(1).max(2048),
});
export type ToolFetchRequest = z.input<typeof ToolFetchRequestSchema>;

// --- Local files ---------------------------------------------------------------------

export const PickedFileSchema = z.object({
  /** Opaque handle for the selection; the renderer never sees the path. */
  token: z.string(),
  name: z.string(),
  size: z.int().nonnegative(),
  kind: z.enum(['pdf', 'docx']).nullable(),
});
export type PickedFile = z.infer<typeof PickedFileSchema>;

export const PickFileResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('selected'), file: PickedFileSchema }),
  z.object({ status: z.literal('cancelled') }),
  z.object({
    status: z.literal('rejected'),
    name: z.string(),
    size: z.int().nonnegative(),
    error: ResearchErrorSchema,
  }),
]);
export type PickFileResult = z.infer<typeof PickFileResultSchema>;

export const ToolExtractFileRequestSchema = z.strictObject({
  requestId: RequestId,
  token: z.string().min(1).max(100),
});

// --- Save / open / cancel ---------------------------------------------------------------

export const SaveTestSourceRequestSchema = z.strictObject({ resultId: z.string().min(1).max(100) });

export const SaveTestSourceResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    sourceId: z.string(),
    taskId: z.string(),
    taskTitle: z.string(),
  }),
  z.object({
    status: z.literal('duplicate'),
    sourceId: z.string(),
    taskId: z.string(),
    taskTitle: z.string(),
    reason: z.enum(['same-url', 'same-content']),
  }),
  z.object({ status: z.literal('error'), error: ResearchErrorSchema }),
]);
export type SaveTestSourceResult = z.infer<typeof SaveTestSourceResultSchema>;

export const OpenUrlRequestSchema = z.strictObject({ url: z.string().min(1).max(2048) });
export const OpenUrlResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('opened') }),
  z.object({ status: z.literal('refused'), message: z.string() }),
]);
export type OpenUrlResult = z.infer<typeof OpenUrlResultSchema>;

export const CancelRequestSchema = z.strictObject({ requestId: RequestId });
