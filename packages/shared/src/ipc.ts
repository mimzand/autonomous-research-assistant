import { z } from 'zod';
import { type ChatApi } from './chat.js';
import {
  type BackupResult,
  type IntegrityCheckResult,
  type ReportDetails,
  type ReportListQuery,
  type ReportListResult,
  type SourceDetails,
  type SourceListQuery,
  type SourceListResult,
  type StorageStatus,
  type ResearchProgressEvent,
  type StartResearchRequest,
  type TaskLogList,
  type TaskActionResult,
  type TaskDetails,
  type TaskListQuery,
  type TaskListResult,
  type TaskStatusCounts,
} from './dashboard.js';
import { type ModelHealth } from './model.js';
import {
  type ExtractionResult,
  type OpenUrlResult,
  type PickFileResult,
  type ResearchToolsStatus,
  type SaveTestSourceResult,
  type SearchHealth,
  type ToolFetchRequest,
  type ToolSearchRequest,
  type ToolSearchResult,
} from './research-tools.js';

/**
 * IPC contract between the Electron main process and the preload bridge.
 * Channel names live here so main and preload can never drift apart.
 */
export const IpcChannels = {
  appGetInfo: 'app:get-info',
  modelGetHealth: 'model:get-health',
  chatStart: 'chat:start',
  chatStop: 'chat:stop',
  tasksCounts: 'tasks:counts',
  tasksList: 'tasks:list',
  tasksGet: 'tasks:get',
  tasksRunPersistenceCheck: 'tasks:run-persistence-check',
  tasksResume: 'tasks:resume',
  tasksCancel: 'tasks:cancel',
  tasksStartResearch: 'tasks:start-research',
  tasksPause: 'tasks:pause',
  tasksRetry: 'tasks:retry',
  tasksLogs: 'tasks:logs',
  sourcesList: 'sources:list',
  sourcesGet: 'sources:get',
  reportsList: 'reports:list',
  reportsGet: 'reports:get',
  storageStatus: 'storage:status',
  storageIntegrityCheck: 'storage:integrity-check',
  storageBackup: 'storage:backup',
  researchStatus: 'research:status',
  researchCheckSearch: 'research:check-search',
  researchSearch: 'research:search',
  researchFetch: 'research:fetch',
  researchPickFile: 'research:pick-file',
  researchExtractFile: 'research:extract-file',
  researchSaveSource: 'research:save-source',
  researchOpenUrl: 'research:open-url',
  researchCancel: 'research:cancel',
} as const;

/** Main → renderer push channels (not invokable). */
export const IpcEvents = {
  chatEvent: 'chat:event',
  researchProgress: 'research:progress',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  versions: z.object({
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
  }),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/**
 * The only surface the renderer can use. Exposed as `window.api` by the
 * preload script. Keep it narrow: no generic invoke, no Node.js objects.
 */
export interface TasksApi {
  counts(): Promise<TaskStatusCounts>;
  list(query: TaskListQuery): Promise<TaskListResult>;
  /** null if the task does not exist. */
  get(id: string): Promise<TaskDetails | null>;
  runPersistenceCheck(): Promise<TaskActionResult>;
  resume(id: string): Promise<TaskActionResult>;
  cancel(id: string): Promise<TaskActionResult>;
  /** Starts an autonomous research task for a goal (local model only). */
  startResearch(request: StartResearchRequest): Promise<TaskActionResult>;
  /** Pauses a running research task. */
  pause(id: string): Promise<TaskActionResult>;
  /** Runs the failed step(s) of a failed research task again. */
  retry(id: string): Promise<TaskActionResult>;
  /** Execution log of a task, oldest first; pass afterSeq to load only new entries. */
  logs(id: string, afterSeq?: number): Promise<TaskLogList>;
  /** Live progress of research tasks. Returns an unsubscribe function. */
  onProgress(listener: (event: ResearchProgressEvent) => void): () => void;
}

export interface KnowledgeApi {
  list(query: SourceListQuery): Promise<SourceListResult>;
  get(id: string): Promise<SourceDetails | null>;
}

export interface ReportsApi {
  list(query: ReportListQuery): Promise<ReportListResult>;
  get(id: string): Promise<ReportDetails | null>;
}

export interface StorageApi {
  status(): Promise<StorageStatus>;
  integrityCheck(): Promise<IntegrityCheckResult>;
  /** Opens a Save dialog (which confirms overwriting) and writes a verified backup. */
  backup(): Promise<BackupResult>;
}

/** Research Tools playground: runs the agent's research tools by hand. */
export interface ResearchToolsApi {
  status(): Promise<ResearchToolsStatus>;
  checkSearch(): Promise<SearchHealth>;
  search(request: ToolSearchRequest): Promise<ToolSearchResult>;
  /** Fetches a public URL through the SSRF-protected fetcher and extracts its text. */
  fetchUrl(request: ToolFetchRequest): Promise<ExtractionResult>;
  /** Opens a native file dialog (PDF/DOCX). The path stays in the main process. */
  pickFile(): Promise<PickFileResult>;
  extractFile(request: { requestId: string; token: string }): Promise<ExtractionResult>;
  /** Saves a fetched web page as a source of the "Research tools playground" task. */
  saveSource(resultId: string): Promise<SaveTestSourceResult>;
  /** Opens a URL from a search result or fetch in the default browser. */
  openUrl(url: string): Promise<OpenUrlResult>;
  cancel(requestId: string): Promise<void>;
}

export interface RendererApi {
  getAppInfo(): Promise<AppInfo>;
  getModelHealth(): Promise<ModelHealth>;
  readonly chat: ChatApi;
  readonly tasks: TasksApi;
  readonly knowledge: KnowledgeApi;
  readonly reports: ReportsApi;
  readonly storage: StorageApi;
  readonly researchTools: ResearchToolsApi;
}

/** Name of the global the preload script exposes in the renderer. */
export const RENDERER_API_KEY = 'api';
