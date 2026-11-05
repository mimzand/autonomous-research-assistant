import { type AgentRuntime } from '@rka/agent-runtime';
import {
  AppInfoSchema,
  ChatStartResultSchema,
  IpcChannels,
  IpcEvents,
  ModelHealthSchema,
  type AppInfo,
} from '@rka/shared';
import { type ChatController } from './chat.js';
import { type DashboardService } from './dashboard.js';
import { type ResearchToolsService } from './research-tools.js';

/** Minimal shape of Electron's WebContents that we rely on. */
export interface SenderLike {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: 'destroyed', listener: () => void): unknown;
}

/** Minimal shape of Electron's IpcMainInvokeEvent that we rely on. */
export interface InvokeEventLike {
  readonly senderFrame: { readonly url: string } | null;
  readonly sender: SenderLike;
}

/** Minimal shape of Electron's ipcMain, so handlers can be tested without Electron. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: InvokeEventLike, ...args: unknown[]) => unknown): void;
}

export interface IpcDeps {
  readonly runtime: AgentRuntime;
  readonly chat: ChatController;
  readonly dashboard: DashboardService;
  readonly researchTools: ResearchToolsService;
  readonly getAppInfo: () => AppInfo;
  readonly isTrustedSender: (url: string) => boolean;
}

/**
 * Registers every IPC handler. Each handler rejects calls from frames that
 * are not our renderer, validates renderer-supplied arguments, and
 * validates its own response against the shared contract.
 */
export function registerIpcHandlers(ipc: IpcMainLike, deps: IpcDeps): void {
  const guard =
    <T>(handler: (event: InvokeEventLike, payload: unknown) => Promise<T> | T) =>
    async (event: InvokeEventLike, ...args: unknown[]): Promise<T> => {
      const url = event.senderFrame?.url;
      if (!url || !deps.isTrustedSender(url)) {
        throw new Error('Rejected IPC call from an untrusted sender.');
      }
      return handler(event, args[0]);
    };

  const watchedSenders = new Set<number>();

  ipc.handle(
    IpcChannels.appGetInfo,
    guard(() => AppInfoSchema.parse(deps.getAppInfo())),
  );

  ipc.handle(
    IpcChannels.modelGetHealth,
    guard(async () => ModelHealthSchema.parse(await deps.runtime.getModelHealth())),
  );

  ipc.handle(
    IpcChannels.chatStart,
    guard(({ sender }, payload) => {
      if (!watchedSenders.has(sender.id)) {
        watchedSenders.add(sender.id);
        // Closing the window cancels its generation.
        sender.once('destroyed', () => {
          watchedSenders.delete(sender.id);
          deps.chat.stopForSink(sender.id);
        });
      }
      const result = deps.chat.start(
        {
          id: sender.id,
          isDestroyed: () => sender.isDestroyed(),
          send: (chatEvent) => sender.send(IpcEvents.chatEvent, chatEvent),
        },
        payload,
      );
      return ChatStartResultSchema.parse(result);
    }),
  );

  ipc.handle(
    IpcChannels.chatStop,
    guard((_event, payload) => {
      deps.chat.stop(payload);
    }),
  );

  // Dashboard: read-only SQLite queries plus explicit task/storage actions.
  // Each service method validates its payload and its response.
  const { dashboard } = deps;
  const routes: Record<string, (payload: unknown) => unknown> = {
    [IpcChannels.tasksCounts]: () => dashboard.taskCounts(),
    [IpcChannels.tasksList]: (p) => dashboard.listTasks(p),
    [IpcChannels.tasksGet]: (p) => dashboard.getTask(p),
    [IpcChannels.tasksRunPersistenceCheck]: () => dashboard.runPersistenceCheck(),
    [IpcChannels.tasksResume]: (p) => dashboard.resumeTask(p),
    [IpcChannels.tasksCancel]: (p) => dashboard.cancelTask(p),
    [IpcChannels.tasksStartResearch]: (p) => dashboard.startResearch(p),
    [IpcChannels.tasksPause]: (p) => dashboard.pauseTask(p),
    [IpcChannels.sourcesList]: (p) => dashboard.listSources(p),
    [IpcChannels.sourcesGet]: (p) => dashboard.getSource(p),
    [IpcChannels.reportsList]: (p) => dashboard.listReports(p),
    [IpcChannels.reportsGet]: (p) => dashboard.getReport(p),
    [IpcChannels.storageStatus]: () => dashboard.storageStatus(),
    [IpcChannels.storageIntegrityCheck]: () => dashboard.integrityCheck(),
    [IpcChannels.storageBackup]: () => dashboard.backup(),
  };
  // Research Tools playground: fixed operations only (no generic fetch). Each
  // method validates its payload with Zod and its response against the contract.
  const { researchTools } = deps;
  Object.assign(routes, {
    [IpcChannels.researchStatus]: () => researchTools.status(),
    [IpcChannels.researchCheckSearch]: () => researchTools.checkSearch(),
    [IpcChannels.researchSearch]: (p: unknown) => researchTools.search(p),
    [IpcChannels.researchFetch]: (p: unknown) => researchTools.fetch(p),
    [IpcChannels.researchPickFile]: () => researchTools.pickFile(),
    [IpcChannels.researchExtractFile]: (p: unknown) => researchTools.extractFile(p),
    [IpcChannels.researchSaveSource]: (p: unknown) => researchTools.saveSource(p),
    [IpcChannels.researchOpenUrl]: (p: unknown) => researchTools.openUrl(p),
    [IpcChannels.researchCancel]: (p: unknown) => researchTools.cancel(p),
  });
  for (const [channel, handler] of Object.entries(routes)) {
    ipc.handle(
      channel,
      guard((_event, payload) => handler(payload)),
    );
  }
}
