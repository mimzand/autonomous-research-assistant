import {
  AppInfoSchema,
  BackupResultSchema,
  ChatEventSchema,
  ChatStartResultSchema,
  ConnectionTestResultSchema,
  EffectiveModelConfigSchema,
  ExtractionResultSchema,
  IntegrityCheckResultSchema,
  IpcChannels,
  IpcEvents,
  ModelHealthSchema,
  ModelTestResultSchema,
  OllamaConnectionStateSchema,
  OllamaModelDetailsSchema,
  OllamaModelListSchema,
  OpenUrlResultSchema,
  PickFileResultSchema,
  RENDERER_API_KEY,
  ReportDetailsSchema,
  ReportListResultSchema,
  ResearchProgressEventSchema,
  ResearchToolsStatusSchema,
  SaveTestSourceResultSchema,
  SearchHealthSchema,
  SettingsChangedEventSchema,
  SettingsUpdateResultSchema,
  SettingsValidateResultSchema,
  SettingsViewSchema,
  SourceDetailsSchema,
  SourceListResultSchema,
  StorageStatusSchema,
  TaskActionResultSchema,
  TaskLogListSchema,
  TaskDetailsSchema,
  TaskListResultSchema,
  TaskStatusCountsSchema,
  ToolSearchResultSchema,
  type ChatApi,
  type ChatEvent,
  type KnowledgeApi,
  type OllamaApi,
  type RendererApi,
  type ReportsApi,
  type ResearchToolsApi,
  type SettingsApi,
  type StorageApi,
  type TasksApi,
} from '@rka/shared';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { z } from 'zod';

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
  startResearch: (request) => call(TaskActionResultSchema, IpcChannels.tasksStartResearch, request),
  pause: (id) => call(TaskActionResultSchema, IpcChannels.tasksPause, { id }),
  retry: (id) => call(TaskActionResultSchema, IpcChannels.tasksRetry, { id }),
  logs: (id, afterSeq = 0) => call(TaskLogListSchema, IpcChannels.tasksLogs, { id, afterSeq }),
  onProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = ResearchProgressEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IpcEvents.researchProgress, handler);
    return () => {
      ipcRenderer.removeListener(IpcEvents.researchProgress, handler);
    };
  },
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

const researchTools: ResearchToolsApi = {
  status: () => call(ResearchToolsStatusSchema, IpcChannels.researchStatus),
  checkSearch: () => call(SearchHealthSchema, IpcChannels.researchCheckSearch),
  search: (request) => call(ToolSearchResultSchema, IpcChannels.researchSearch, request),
  fetchUrl: (request) => call(ExtractionResultSchema, IpcChannels.researchFetch, request),
  pickFile: () => call(PickFileResultSchema, IpcChannels.researchPickFile),
  extractFile: (request) => call(ExtractionResultSchema, IpcChannels.researchExtractFile, request),
  saveSource: (resultId) =>
    call(SaveTestSourceResultSchema, IpcChannels.researchSaveSource, { resultId }),
  openUrl: (url) => call(OpenUrlResultSchema, IpcChannels.researchOpenUrl, { url }),
  cancel: async (requestId) => {
    await ipcRenderer.invoke(IpcChannels.researchCancel, { requestId });
  },
};

const settings: SettingsApi = {
  get: () => call(SettingsViewSchema, IpcChannels.settingsGet),
  validate: (patch) => call(SettingsValidateResultSchema, IpcChannels.settingsValidate, patch),
  update: (patch) => call(SettingsUpdateResultSchema, IpcChannels.settingsUpdate, patch),
  reset: (keys) =>
    call(SettingsUpdateResultSchema, IpcChannels.settingsReset, keys ? { keys } : {}),
  setSecret: (key, value) =>
    call(SettingsUpdateResultSchema, IpcChannels.settingsSetSecret, { key, value }),
  chooseBackupFolder: () =>
    call(
      z.union([SettingsUpdateResultSchema, z.object({ status: z.literal('cancelled') })]),
      IpcChannels.settingsChooseBackupFolder,
    ),
  testSearxng: (url) =>
    call(ConnectionTestResultSchema, IpcChannels.settingsTestSearxng, url ? { url } : {}),
  onChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      const parsed = SettingsChangedEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IpcEvents.settingsChanged, handler);
    return () => {
      ipcRenderer.removeListener(IpcEvents.settingsChanged, handler);
    };
  },
};

const ollama: OllamaApi = {
  testConnection: (url) =>
    call(ConnectionTestResultSchema, IpcChannels.ollamaTestConnection, url ? { url } : {}),
  connectionState: () => call(OllamaConnectionStateSchema, IpcChannels.ollamaConnectionState),
  connect: () => call(OllamaConnectionStateSchema, IpcChannels.ollamaConnect),
  disconnect: () => call(OllamaConnectionStateSchema, IpcChannels.ollamaDisconnect),
  listModels: () => call(OllamaModelListSchema, IpcChannels.ollamaListModels),
  showModel: (name) => call(OllamaModelDetailsSchema, IpcChannels.ollamaShowModel, { name }),
  testModel: (name, prompt) =>
    call(ModelTestResultSchema, IpcChannels.ollamaTestModel, { name, prompt }),
  effectiveConfig: () => call(EffectiveModelConfigSchema, IpcChannels.ollamaEffectiveConfig),
};

const api: RendererApi = {
  getAppInfo: () => call(AppInfoSchema, IpcChannels.appGetInfo),
  getModelHealth: () => call(ModelHealthSchema, IpcChannels.modelGetHealth),
  chat: Object.freeze(chat),
  tasks: Object.freeze(tasks),
  knowledge: Object.freeze(knowledge),
  reports: Object.freeze(reports),
  storage: Object.freeze(storage),
  researchTools: Object.freeze(researchTools),
  settings: Object.freeze(settings),
  ollama: Object.freeze(ollama),
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, Object.freeze(api));
