import {
  AppInfoSchema,
  BackupResultSchema,
  ChatEventSchema,
  ChatStartResultSchema,
  IntegrityCheckResultSchema,
  IpcChannels,
  IpcEvents,
  ModelHealthSchema,
  RENDERER_API_KEY,
  ReportDetailsSchema,
  ReportListResultSchema,
  SourceDetailsSchema,
  SourceListResultSchema,
  StorageStatusSchema,
  TaskActionResultSchema,
  TaskDetailsSchema,
  TaskListResultSchema,
  TaskStatusCountsSchema,
  type ChatApi,
  type ChatEvent,
  type KnowledgeApi,
  type RendererApi,
  type ReportsApi,
  type StorageApi,
  type TasksApi,
} from '@rka/shared';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { type z } from 'zod';

/**
 * The renderer's only bridge to the main process. It exposes a fixed set of
 * typed functions - never ipcRenderer itself, never the IPC event object,
 * and never Node.js objects. Everything from main is validated again here.
 */

/** invoke + validate the response against the shared contract. */
async function call<S extends z.ZodType>(
  schema: S,
  channel: string,
  payload?: unknown,
): Promise<z.output<S>> {
  return schema.parse(await ipcRenderer.invoke(channel, payload)) as z.output<S>;
}

const chat: ChatApi = {
  start: async (request) => call(ChatStartResultSchema, IpcChannels.chatStart, request),

  stop: async (streamId: string) => {
    await ipcRenderer.invoke(IpcChannels.chatStop, { streamId });
  },

  onEvent: (listener: (event: ChatEvent) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = ChatEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
      else console.error('Dropped malformed chat event from main process.');
    };
    ipcRenderer.on(IpcEvents.chatEvent, handler);
    return () => {
      ipcRenderer.removeListener(IpcEvents.chatEvent, handler);
    };
  },
};

const tasks: TasksApi = {
  counts: () => call(TaskStatusCountsSchema, IpcChannels.tasksCounts),
  list: (query) => call(TaskListResultSchema, IpcChannels.tasksList, query),
  get: (id) => call(TaskDetailsSchema.nullable(), IpcChannels.tasksGet, { id }),
  runPersistenceCheck: () => call(TaskActionResultSchema, IpcChannels.tasksRunPersistenceCheck),
  resume: (id) => call(TaskActionResultSchema, IpcChannels.tasksResume, { id }),
  cancel: (id) => call(TaskActionResultSchema, IpcChannels.tasksCancel, { id }),
};

const knowledge: KnowledgeApi = {
  list: (query) => call(SourceListResultSchema, IpcChannels.sourcesList, query),
  get: (id) => call(SourceDetailsSchema.nullable(), IpcChannels.sourcesGet, { id }),
};

const reports: ReportsApi = {
  list: (query) => call(ReportListResultSchema, IpcChannels.reportsList, query),
  get: (id) => call(ReportDetailsSchema.nullable(), IpcChannels.reportsGet, { id }),
};

const storage: StorageApi = {
  status: () => call(StorageStatusSchema, IpcChannels.storageStatus),
  integrityCheck: () => call(IntegrityCheckResultSchema, IpcChannels.storageIntegrityCheck),
  backup: () => call(BackupResultSchema, IpcChannels.storageBackup),
};

const api: RendererApi = {
  getAppInfo: () => call(AppInfoSchema, IpcChannels.appGetInfo),
  getModelHealth: () => call(ModelHealthSchema, IpcChannels.modelGetHealth),
  chat: Object.freeze(chat),
  tasks: Object.freeze(tasks),
  knowledge: Object.freeze(knowledge),
  reports: Object.freeze(reports),
  storage: Object.freeze(storage),
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, Object.freeze(api));
