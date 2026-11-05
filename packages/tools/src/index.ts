export {
  defineTool,
  type ToolContext,
  type ToolDefinition,
  type ToolPermissions,
  type ToolSummary,
} from './tool.js';
export {
  createToolRegistry,
  type ToolExecutionError,
  type ToolInputError,
  type ToolRegistry,
} from './registry.js';

// Web research
export { checkAddress, checkHostname, type AddressVerdict } from './web/ip-policy.js';
export { canonicalizeUrl, MAX_URL_LENGTH, parsePublicUrl, type UrlError } from './web/url.js';
export {
  createSafeHttpClient,
  isWebError,
  WebError,
  type HttpResponse,
  type ResolvedAddress,
  type Resolver,
  type SafeHttpClient,
  type SafeHttpClientOptions,
  type WebErrorCode,
} from './web/http-client.js';
export { extractHtml, type HtmlExtraction } from './web/extract/html.js';
export { extractPdf, type PdfExtraction } from './web/extract/pdf.js';
export { extractDocx, type DocxExtraction } from './web/extract/docx.js';
export {
  createWebFetcher,
  detectKind,
  type DocumentKind,
  type FetchedDocument,
  type WebFetcher,
} from './web/fetcher.js';
export {
  createSearxngProvider,
  type SearchQuery,
  type SearchResult,
  type SearxngConfig,
  type WebSearchProvider,
} from './web/search.js';
export {
  findDuplicate,
  textSha256,
  type DuplicateMatch,
  type SourceMetadata,
  type SourceStore,
  type SourceToSave,
  type StoredSourceRef,
} from './web/sources.js';
export { stripInvisible, UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapUntrusted } from './web/untrusted.js';
export {
  createFetchSourceTool,
  createWebSearchTool,
  createWebTools,
  EXCERPT_CHARS,
  FetchSourceOutputSchema,
  WebSearchOutputSchema,
  type WebToolDeps,
} from './web/tools.js';
export {
  createWebToolsFromConfig,
  loadWebConfig,
  type WebConfig,
  type WebEnv,
} from './web/config.js';
