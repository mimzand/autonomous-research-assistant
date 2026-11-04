import {
  AppInfoSchema,
  IpcChannels,
  ModelHealthSchema,
  RENDERER_API_KEY,
  type RendererApi,
} from '@rka/shared';
import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's only bridge to the main process. It exposes a fixed set of
 * typed functions - never ipcRenderer itself, and never Node.js objects.
 * Responses are validated again here before reaching the renderer.
 */
const api: RendererApi = {
  getAppInfo: async () => AppInfoSchema.parse(await ipcRenderer.invoke(IpcChannels.appGetInfo)),
  getModelHealth: async () =>
    ModelHealthSchema.parse(await ipcRenderer.invoke(IpcChannels.modelGetHealth)),
};

contextBridge.exposeInMainWorld(RENDERER_API_KEY, Object.freeze(api));
