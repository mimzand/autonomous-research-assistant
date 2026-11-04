import { z } from 'zod';
import { type ChatApi } from './chat.js';
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
export interface RendererApi {
  getAppInfo(): Promise<AppInfo>;
  getModelHealth(): Promise<ModelHealth>;
  readonly chat: ChatApi;
}

/** Name of the global the preload script exposes in the renderer. */
export const RENDERER_API_KEY = 'api';
