import { type AgentClient } from '@rka/agent-client';
import { parseRequest, type RequestMethodName } from '@rka/agent-protocol';
import { AppInfoSchema, IpcChannels, type AppInfo, type IpcChannel } from '@rka/shared';
import { createIpcGuard, type IpcMainLike } from './ipc.js';
import { createServiceChat } from './service-chat.js';
import { type ServiceSettings } from './service-settings.js';

/** Upper bound for one proxied call; an integrity check of a large database takes a while. */
export const SERVICE_REQUEST_TIMEOUT_MS = 60_000;
/** Research Tools search, fetch and extract (network and document parsing). */
export const SERVICE_TOOLS_TIMEOUT_MS = 5 * 60_000;
/**
 * Calls that wait for a person in a shell dialog, then copy or read the file.
 * Longer than the agent's `SHELL_DIALOG_TIMEOUT_MS`, so the agent's answer arrives first.
 */
export const SERVICE_DIALOG_TIMEOUT_MS = 15 * 60_000;

const DIALOG_METHODS: ReadonlySet<RequestMethodName> = new Set([
  'storage.backup',
  'researchTools.pickFile',
  'settings.chooseBackupFolder',
]);

/** Settings calls that reach a server over the network (or run a model) before they answer. */
const NETWORK_METHODS: ReadonlySet<RequestMethodName> = new Set([
  'settings.testSearxng',
  'model.testConnection',
  'model.listModels',
  'model.showModel',
  'model.testModel',
]);

export function serviceTimeoutFor(method: RequestMethodName): number {
  if (DIALOG_METHODS.has(method)) return SERVICE_DIALOG_TIMEOUT_MS;
  if (method.startsWith('researchTools.') || NETWORK_METHODS.has(method)) {
    return SERVICE_TOOLS_TIMEOUT_MS;
  }
  return SERVICE_REQUEST_TIMEOUT_MS;
}

/**
 * Request/response channels the agent service serves: Dashboard reads, the
 * persistence check, storage status and integrity (Phase 3), model health for
 * the Chat page (Phase 4; registered as Phase 7 in the protocol, served early)
 * the research task lifecycle (Phase 5; progress arrives as
 * `ui.researchProgress`, see `startServiceShell`), and Research Tools plus backup
 * (Phase 6; their dialogs are reverse calls the shell answers, and picked paths
 * stay in the agent behind tokens), and Settings with the Ollama connection
 * (Phase 7; the agent applies changes live; `settings:set-secret` is encrypted
 * here first, see `service-settings.ts`). Payloads and results use the
 * same `@rka/shared` schemas through the protocol registry. Chat start/stop are
 * handled by `createServiceChat`.
 */
export const SERVICE_ROUTES = {
  [IpcChannels.modelGetHealth]: 'model.health',
  [IpcChannels.tasksCounts]: 'tasks.counts',
  [IpcChannels.tasksList]: 'tasks.list',
  [IpcChannels.tasksGet]: 'tasks.get',
  [IpcChannels.tasksLogs]: 'tasks.logs',
  [IpcChannels.tasksRunPersistenceCheck]: 'tasks.runPersistenceCheck',
  [IpcChannels.tasksStartResearch]: 'tasks.startResearch',
  [IpcChannels.tasksPause]: 'tasks.pause',
  [IpcChannels.tasksResume]: 'tasks.resume',
  [IpcChannels.tasksCancel]: 'tasks.cancel',
  [IpcChannels.tasksRetry]: 'tasks.retry',
  [IpcChannels.sourcesList]: 'sources.list',
  [IpcChannels.sourcesGet]: 'sources.get',
  [IpcChannels.reportsList]: 'reports.list',
  [IpcChannels.reportsGet]: 'reports.get',
  [IpcChannels.storageStatus]: 'storage.status',
  [IpcChannels.storageIntegrityCheck]: 'storage.integrityCheck',
  [IpcChannels.storageBackup]: 'storage.backup',
  [IpcChannels.researchStatus]: 'researchTools.status',
  [IpcChannels.researchCheckSearch]: 'researchTools.checkSearch',
  [IpcChannels.researchSearch]: 'researchTools.search',
  [IpcChannels.researchFetch]: 'researchTools.fetchUrl',
  [IpcChannels.researchPickFile]: 'researchTools.pickFile',
  [IpcChannels.researchExtractFile]: 'researchTools.extractFile',
  [IpcChannels.researchSaveSource]: 'researchTools.saveSource',
  [IpcChannels.researchOpenUrl]: 'researchTools.openUrl',
  [IpcChannels.researchCancel]: 'researchTools.cancel',
  [IpcChannels.settingsGet]: 'settings.get',
  [IpcChannels.settingsValidate]: 'settings.validate',
  [IpcChannels.settingsUpdate]: 'settings.update',
  [IpcChannels.settingsReset]: 'settings.reset',
  [IpcChannels.settingsChooseBackupFolder]: 'settings.chooseBackupFolder',
  [IpcChannels.settingsTestSearxng]: 'settings.testSearxng',
  [IpcChannels.ollamaTestConnection]: 'model.testConnection',
  [IpcChannels.ollamaConnectionState]: 'model.connectionState',
  [IpcChannels.ollamaConnect]: 'model.connect',
  [IpcChannels.ollamaDisconnect]: 'model.disconnect',
  [IpcChannels.ollamaListModels]: 'model.listModels',
  [IpcChannels.ollamaShowModel]: 'model.showModel',
  [IpcChannels.ollamaTestModel]: 'model.testModel',
  [IpcChannels.ollamaEffectiveConfig]: 'model.effectiveConfig',
} as const satisfies Partial<Record<IpcChannel, RequestMethodName>>;

export interface ServiceIpcDeps {
  readonly client: Pick<AgentClient, 'request' | 'onEvent' | 'onClose'>;
  readonly getAppInfo: () => AppInfo;
  readonly isTrustedSender: (url: string) => boolean;
  /** Settings views get this shell's encryption availability; secrets are encrypted here. */
  readonly settings: ServiceSettings;
  readonly log?: Pick<Console, 'warn'>;
}

/**
 * AGENT_TRANSPORT=service: registers every renderer channel without any local
 * database. Routed channels and Chat go to the agent; `settings:set-secret` is
 * encrypted here and stored by the agent as ciphertext. A channel without a route
 * fails with a clear message (none is left after Phase 7).
 */
export function registerServiceIpcHandlers(ipc: IpcMainLike, deps: ServiceIpcDeps): void {
  const guard = createIpcGuard(deps.isTrustedSender);
  const routes = new Map<string, RequestMethodName>(Object.entries(SERVICE_ROUTES));
  const chat = createServiceChat({ client: deps.client, ...(deps.log && { log: deps.log }) });
  for (const channel of Object.values(IpcChannels)) {
    if (channel === IpcChannels.appGetInfo) {
      ipc.handle(
        channel,
        guard(() => AppInfoSchema.parse(deps.getAppInfo())),
      );
      continue;
    }
    if (channel === IpcChannels.chatStart) {
      ipc.handle(
        channel,
        guard(({ sender }, payload) => chat.start(sender, payload)),
      );
      continue;
    }
    if (channel === IpcChannels.settingsSetSecret) {
      ipc.handle(
        channel,
        guard((_event, payload) => deps.settings.setSecret(payload)),
      );
      continue;
    }
    if (channel === IpcChannels.chatStop) {
      ipc.handle(
        channel,
        guard((_event, payload) => chat.stop(payload)),
      );
      continue;
    }
    const method = routes.get(channel);
    ipc.handle(
      channel,
      guard((_event, payload) =>
        method ? forward(deps.client, deps.settings, method, payload) : unavailable(channel),
      ),
    );
  }
}

/** Validates the renderer payload with the protocol schema, then asks the agent. */
async function forward(
  client: ServiceIpcDeps['client'],
  settings: ServiceSettings,
  method: RequestMethodName,
  payload: unknown,
): Promise<unknown> {
  const parsed = parseRequest(
    { id: 'ipc', kind: 'req', method, payload: payload ?? {} },
    'toAgent',
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const result = await client.request(method, parsed.value.params as never, {
    timeoutMs: serviceTimeoutFor(method),
  });
  return settings.patchResult(method, result);
}

function unavailable(channel: string): Promise<never> {
  return Promise.reject(new Error(`${channel} is not served by the agent service.`));
}
