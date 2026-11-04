import { type AgentRuntime } from '@rka/agent-runtime';
import { AppInfoSchema, IpcChannels, ModelHealthSchema, type AppInfo } from '@rka/shared';

/** Minimal shape of Electron's IpcMainInvokeEvent that we rely on. */
export interface InvokeEventLike {
  readonly senderFrame: { readonly url: string } | null;
}

/** Minimal shape of Electron's ipcMain, so handlers can be tested without Electron. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEventLike, ...args: unknown[]) => unknown): void;
}

export interface IpcDeps {
  readonly runtime: AgentRuntime;
  readonly getAppInfo: () => AppInfo;
  readonly isTrustedSender: (url: string) => boolean;
}

/**
 * Registers every IPC handler. Each handler rejects calls from frames that
 * are not our renderer, ignores renderer-supplied arguments it does not
 * expect, and validates its own response against the shared contract.
 */
export function registerIpcHandlers(ipc: IpcMainLike, deps: IpcDeps): void {
  const guard =
    <T>(handler: () => Promise<T> | T) =>
    async (event: InvokeEventLike): Promise<T> => {
      const url = event.senderFrame?.url;
      if (!url || !deps.isTrustedSender(url)) {
        throw new Error('Rejected IPC call from an untrusted sender.');
      }
      return handler();
    };

  ipc.handle(
    IpcChannels.appGetInfo,
    guard(() => AppInfoSchema.parse(deps.getAppInfo())),
  );

  ipc.handle(
    IpcChannels.modelGetHealth,
    guard(async () => ModelHealthSchema.parse(await deps.runtime.getModelHealth())),
  );
}
