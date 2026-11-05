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
  type TaskActionResult,
  type TaskDetails,
  type TaskListQuery,
  type TaskListResult,
  type TaskStatusCounts,
} from './dashboard.js';
import { type ModelHealth } from './model.js';

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
  sourcesList: 'sources:list',
  sourcesGet: 'sources:get',
  reportsList: 'reports:list',
  reportsGet: 'reports:get',
  storageStatus: 'storage:status',
  storageIntegrityCheck: 'storage:integrity-check',
  storageBackup: 'storage:backup',
} as const;

/** Main → renderer push channels (not invokable). */
export const IpcEvents = {
  chatEvent: 'chat:event',
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

export interface RendererApi {
  getAppInfo(): Promise<AppInfo>;
  getModelHealth(): Promise<ModelHealth>;
  readonly chat: ChatApi;
  readonly tasks: TasksApi;
  readonly knowledge: KnowledgeApi;
  readonly reports: ReportsApi;
  readonly storage: StorageApi;
}

/** Name of the global the preload script exposes in the renderer. */
export const RENDERER_API_KEY = 'api';
