import {
  AppInfoSchema,
  ChatEventSchema,
  ChatStartResultSchema,
  IpcChannels,
  IpcEvents,
  ModelHealthSchema,
  RENDERER_API_KEY,
  type ChatApi,
  type ChatEvent,
  type RendererApi,
} from '@rka/shared';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * The renderer's only bridge to the main process. It exposes a fixed set of
 * typed functions - never ipcRenderer itself, never the IPC event object,
 * and never Node.js objects. Everything from main is validated again here.
 */
const chat: ChatApi = {
  start: async (request) =>
    ChatStartResultSchema.parse(await ipcRenderer.invoke(IpcChannels.chatStart, request)),

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

const api: RendererApi = {
  getAppInfo: async () => AppInfoSchema.parse(await ipcRenderer.invoke(IpcChannels.appGetInfo)),
  getModelHealth: async () =>
    ModelHealthSchema.parse(await ipcRenderer.invoke(IpcChannels.modelGetHealth)),

  chat: Object.freeze(chat),
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, Object.freeze(api));
