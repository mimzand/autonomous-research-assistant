import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  CancelRequestSchema,
  ExtractionResultSchema,
  OpenUrlRequestSchema,
  OpenUrlResultSchema,
  PickFileResultSchema,
  ResearchToolsStatusSchema,
  SaveTestSourceRequestSchema,
  SaveTestSourceResultSchema,
  SearchHealthSchema,
  ToolExtractFileRequestSchema,
  ToolFetchRequestSchema,
  ToolSearchRequestSchema,
  ToolSearchResultSchema,
  type ExtractedSourceView,
  type ExtractionResult,
  type OpenUrlResult,
  type PickFileResult,
  type ResearchError,
  type ResearchToolsStatus,
  type SaveTestSourceResult,
  type SearchHealth,
  type ToolSearchResult,
} from '@rka/shared';
import { type Storage } from '@rka/storage';
import {
  extractLocalDocument,
  fileExtension,
  findDuplicate,
  isWebError,
  LOCAL_DOCUMENT_TYPES,
  parsePublicUrl,
  textSha256,
  toSourceToSave,
  type FetchedDocument,
  type SourceStore,
  type ToolRegistry,
  type WebConfig,
  type WebServices,
  WebSearchOutputSchema,
} from '@rka/tools';
import { type z } from 'zod';

/** Kind stored in the input of the task that collects playground sources. */
export const PLAYGROUND_TASK_KIND = 'research-tools-playground';
const PLAYGROUND_TASK_SETTING = 'research-tools.test-task-id';
/** Extracted text sent to the window is cut here; hashes and lengths cover the full text. */
export const MAX_DISPLAY_CHARS = 200_000;
const SELECTION_TTL_MS = 15 * 60_000;
const MAX_CACHED_RESULTS = 20;

export interface ResearchToolsDeps {
  readonly config: WebConfig;
  readonly services: WebServices;
  /** The agent's registry: web_search runs through the real tool contract. */
  readonly tools: ToolRegistry;
  readonly storage: Storage;
  readonly sourceStore: SourceStore;
  /** Native "Open file" dialog. Returns the chosen path, or null. */
  readonly chooseFile: () => Promise<string | null>;
  /** Opens a URL in the default browser. */
  readonly openExternal: (url: string) => Promise<void>;
  readonly now?: () => number;
}

interface Selection {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly expiresAt: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function toResearchError(error: unknown): ResearchError {
  if (isWebError(error)) return { code: error.code, message: error.message.slice(0, 2000) };
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: typeof code === 'string' ? code.slice(0, 60) : 'failed',
    message: message(error).slice(0, 2000),
  };
}

function metadataRecord(metadata: FetchedDocument['metadata']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}

/**
 * Backs the Research Tools page. Uses the same fetcher, search provider and
 * extractors as the agent; adds nothing that widens network or file access:
 * - fetch goes through the SSRF-protected client (public addresses only),
 * - files come only from the native dialog and are read in memory, never saved,
 * - only URLs that came from a search result or fetch can be opened.
 */
export function createResearchToolsService(deps: ResearchToolsDeps) {
  const now = deps.now ?? (() => Date.now());
  const { config, services, storage, sourceStore } = deps;
  const maxFileBytes = config.maxDownloadBytes;

  const running = new Map<string, AbortController>();
  const selections = new Map<string, Selection>();
  const webResults = new Map<string, FetchedDocument>();
  const openable = new Set<string>();

  function parse<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
    return schema.parse(payload) as z.output<S>;
  }

  /** Runs `work` with an AbortController registered under `requestId`. */
  async function track<T>(
    requestId: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    running.get(requestId)?.abort();
    const controller = new AbortController();
    running.set(requestId, controller);
    try {
      return await work(controller.signal);
    } finally {
      if (running.get(requestId) === controller) running.delete(requestId);
    }
  }

  function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
    map.set(key, value);
    while (map.size > max) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  function view(
    origin: 'web' | 'file',
    label: string,
    doc: {
      kind: ExtractedSourceView['kind'];
      contentType: string;
      title: string | null;
      byteLength: number;
      sha256: string;
      text: string;
      truncated: boolean;
      metadata: FetchedDocument['metadata'];
    },
    extra: Pick<ExtractedSourceView, 'web' | 'timings'>,
  ): ExtractedSourceView {
    const resultId = randomUUID();
    return {
      resultId,
      origin,
      label,
      kind: doc.kind,
      contentType: doc.contentType,
      title: doc.title,
      byteLength: doc.byteLength,
      sha256: doc.sha256,
      textSha256: textSha256(doc.text),
      textLength: doc.text.length,
      truncated: doc.truncated,
      displayTruncated: doc.text.length > MAX_DISPLAY_CHARS,
      text: doc.text.slice(0, MAX_DISPLAY_CHARS),
      metadata: metadataRecord(doc.metadata),
      canSave: origin === 'web',
      ...extra,
    };
  }

  function ensurePlaygroundTask(): { id: string; title: string } {
    const knownId = storage.settings.get<z.ZodType<string>>(PLAYGROUND_TASK_SETTING);
    const known = typeof knownId === 'string' ? storage.tasks.get(knownId) : undefined;
    if (known) return { id: known.id, title: known.title };
    const task = storage.transaction((repos) => {
      const created = repos.tasks.create({
        title: 'Research tools playground',
        input: {
          kind: PLAYGROUND_TASK_KIND,
          note: 'Sources saved by hand from the Research Tools page.',
        },
      });
      repos.tasks.start(created.id);
      return repos.tasks.complete(created.id, { kind: PLAYGROUND_TASK_KIND });
    });
    storage.settings.set(PLAYGROUND_TASK_SETTING, task.id);
    return { id: task.id, title: task.title };
  }

  return {
    status(): ResearchToolsStatus {
      return ResearchToolsStatusSchema.parse({
        search: {
          configured: Boolean(services.searchProvider),
          provider: services.searchProvider?.id ?? null,
          endpoint: config.searxngUrl ? new URL(config.searxngUrl).origin : null,
        },
        limits: {
          fetchTimeoutMs: config.fetchTimeoutMs,
          searchTimeoutMs: config.searchTimeoutMs,
          maxDownloadBytes: config.maxDownloadBytes,
          maxFileBytes,
          maxDisplayChars: MAX_DISPLAY_CHARS,
        },
        fileTypes: Object.values(LOCAL_DOCUMENT_TYPES).flatMap((t) => [...t.extensions]),
      });
    },

    async checkSearch(): Promise<SearchHealth> {
      const provider = services.searchProvider;
      if (!provider || !config.searxngUrl) {
        return SearchHealthSchema.parse({
          status: 'not-configured',
          message: 'Set SEARXNG_URL (e.g. http://127.0.0.1:8080) and restart the app.',
        });
      }
      try {
        const health = await provider.checkHealth({ signal: AbortSignal.timeout(5000) });
        return SearchHealthSchema.parse({ status: 'ready', ...health });
      } catch (error) {
        return SearchHealthSchema.parse({
          status: 'unavailable',
          endpoint: new URL(config.searxngUrl).origin,
          error: toResearchError(error),
        });
      }
    },

    async search(payload: unknown): Promise<ToolSearchResult> {
      const request = parse(ToolSearchRequestSchema, payload);
      const started = now();
      if (!deps.tools.get('web_search')) {
        return ToolSearchResultSchema.parse({
          status: 'error',
          durationMs: 0,
          error: {
            code: 'not-configured',
            message:
              'Web search is off. Set SEARXNG_URL to a SearXNG instance and restart the app.',
          },
        });
      }
      const result = await track(request.requestId, (signal) =>
        deps.tools.execute(
          'web_search',
          { query: request.query, limit: request.limit },
          { signal },
        ),
      );
      const durationMs = Math.max(0, Math.round(now() - started));
      if (!result.ok) {
        const e = result.error;
        const code =
          e.kind === 'failed' && e.code
            ? e.code
            : e.kind === 'invalid-input'
              ? 'invalid-input'
              : e.kind;
        const text = 'message' in e ? e.message : 'issues' in e ? e.issues.join('; ') : e.kind;
        return ToolSearchResultSchema.parse({
          status: 'error',
          durationMs,
          error: { code, message: text },
        });
      }
      const output = WebSearchOutputSchema.parse(result.value);
      for (const r of output.results) openable.add(r.url);
      return ToolSearchResultSchema.parse({
        status: 'ok',
        provider: output.provider,
        durationMs,
        results: output.results.map((r, i) => ({ position: i + 1, ...r })),
      });
    },

    async fetch(payload: unknown): Promise<ExtractionResult> {
      const request = parse(ToolFetchRequestSchema, payload);
      const started = now();
      try {
        const doc = await track(request.requestId, (signal) =>
          deps.services.fetcher.fetch(request.url, { signal }),
        );
        const source = view('web', doc.finalUrl, doc, {
          web: {
            requestedUrl: doc.requestedUrl,
            finalUrl: doc.finalUrl,
            canonicalUrl: doc.canonicalUrl,
            redirects: [...doc.redirects],
            httpStatus: doc.status,
          },
          timings: {
            downloadMs: doc.timings.downloadMs,
            extractMs: doc.timings.extractMs,
            totalMs: Math.max(0, Math.round(now() - started)),
          },
        });
        remember(webResults, source.resultId, doc, MAX_CACHED_RESULTS);
        openable.add(doc.finalUrl);
        openable.add(doc.requestedUrl);
        return ExtractionResultSchema.parse({ status: 'ok', source });
      } catch (error) {
        return ExtractionResultSchema.parse({
          status: 'error',
          durationMs: Math.max(0, Math.round(now() - started)),
          error: toResearchError(error),
        });
      }
    },

    async pickFile(): Promise<PickFileResult> {
      const path = await deps.chooseFile();
      if (!path) return { status: 'cancelled' };
      const name = basename(path);
      let size: number;
      try {
        const handle = await open(path, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Not a regular file.');
          size = stat.size;
        } finally {
          await handle.close();
        }
      } catch (error) {
        return PickFileResultSchema.parse({
          status: 'rejected',
          name,
          size: 0,
          error: { code: 'unreadable', message: `Cannot read the file: ${message(error)}` },
        });
      }
      const ext = fileExtension(name);
      const kind = ext === 'pdf' || ext === 'docx' ? ext : null;
      if (!kind) {
        return PickFileResultSchema.parse({
          status: 'rejected',
          name,
          size,
          error: {
            code: 'unsupported-content',
            message: `Unsupported file type "${ext ? `.${ext}` : 'none'}". Choose a PDF or DOCX file.`,
          },
        });
      }
      if (size > maxFileBytes) {
        return PickFileResultSchema.parse({
          status: 'rejected',
          name,
          size,
          error: {
            code: 'too-large',
            message: `The file is ${size} bytes; the limit is ${maxFileBytes} bytes (WEB_MAX_DOWNLOAD_BYTES).`,
          },
        });
      }
      const token = randomUUID();
      for (const [key, value] of selections) {
        if (value.expiresAt < now()) selections.delete(key);
      }
      remember(selections, token, { path, name, size, expiresAt: now() + SELECTION_TTL_MS }, 10);
      return PickFileResultSchema.parse({ status: 'selected', file: { token, name, size, kind } });
    },

    async extractFile(payload: unknown): Promise<ExtractionResult> {
      const request = parse(ToolExtractFileRequestSchema, payload);
      const started = now();
      const elapsed = () => Math.max(0, Math.round(now() - started));
      const selection = selections.get(request.token);
      if (!selection || selection.expiresAt < now()) {
        return ExtractionResultSchema.parse({
          status: 'error',
          durationMs: 0,
          error: { code: 'no-selection', message: 'Choose the file again (selection expired).' },
        });
      }
      try {
        const source = await track(request.requestId, async (signal) => {
          // Read at most limit + 1 bytes: the file may have grown since it was chosen.
          const handle = await open(selection.path, 'r');
          let bytes: Buffer;
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error('Not a regular file.');
            const buffer = Buffer.alloc(Math.min(stat.size, maxFileBytes + 1));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            bytes = buffer.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
          const readMs = elapsed();
          const doc = await extractLocalDocument(selection.name, bytes, {
            maxBytes: maxFileBytes,
            signal,
          });
          return view('file', selection.name, doc, {
            web: null,
            timings: {
              downloadMs: null,
              extractMs: Math.max(0, elapsed() - readMs),
              totalMs: elapsed(),
            },
          });
        });
        return ExtractionResultSchema.parse({ status: 'ok', source });
      } catch (error) {
        return ExtractionResultSchema.parse({
          status: 'error',
          durationMs: elapsed(),
          error: toResearchError(error),
        });
      }
    },

    saveSource(payload: unknown): SaveTestSourceResult {
      const { resultId } = parse(SaveTestSourceRequestSchema, payload);
      const doc = webResults.get(resultId);
      if (!doc) {
        return SaveTestSourceResultSchema.parse({
          status: 'error',
          error: {
            code: 'not-found',
            message: 'Only fetched web pages can be saved. Fetch the page again and retry.',
          },
        });
      }
      if (!doc.text.trim()) {
        return SaveTestSourceResultSchema.parse({
          status: 'error',
          error: { code: 'extraction-failed', message: 'The page has no extracted text to save.' },
        });
      }
      try {
        const task = ensurePlaygroundTask();
        const duplicate = findDuplicate(sourceStore, task.id, {
          urls: [doc.finalUrl, doc.requestedUrl, ...doc.redirects],
          text: doc.text,
        });
        if (duplicate) {
          return SaveTestSourceResultSchema.parse({
            status: 'duplicate',
            sourceId: duplicate.source.id,
            taskId: task.id,
            taskTitle: task.title,
            reason: duplicate.reason,
          });
        }
        const saved = sourceStore.save(task.id, toSourceToSave(doc));
        return SaveTestSourceResultSchema.parse({
          status: 'saved',
          sourceId: saved.id,
          taskId: task.id,
          taskTitle: task.title,
        });
      } catch (error) {
        return SaveTestSourceResultSchema.parse({ status: 'error', error: toResearchError(error) });
      }
    },

    async openUrl(payload: unknown): Promise<OpenUrlResult> {
      const { url } = parse(OpenUrlRequestSchema, payload);
      const checked = parsePublicUrl(url);
      if (!openable.has(url) || !checked.ok) {
        return OpenUrlResultSchema.parse({
          status: 'refused',
          message: checked.ok
            ? 'Only URLs from a search result or fetch can be opened.'
            : checked.error.message,
        });
      }
      await deps.openExternal(checked.value.href);
      return { status: 'opened' };
    },

    cancel(payload: unknown): void {
      const { requestId } = parse(CancelRequestSchema, payload);
      running.get(requestId)?.abort();
    },
  };
}

export type ResearchToolsService = ReturnType<typeof createResearchToolsService>;
