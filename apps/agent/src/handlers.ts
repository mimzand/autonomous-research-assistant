import {
  type ClientKind,
  type EventName,
  type EventPayload,
  type RequestMethodName,
  type RequestParams,
  type RequestParamsInput,
  type RequestResult,
  type ShellMethodName,
} from '@rka/agent-protocol';
import {
  type ChatController,
  type ChatEventSink,
  type DashboardService,
  type ResearchToolsService,
  type RuntimeConfig,
  type SettingsService,
} from '@rka/agent-host';
import { type AgentRuntime } from '@rka/agent-runtime';
import { type AgentSecretStore } from './secrets.js';
import { type SnapshotStore } from './snapshots.js';

/** One authenticated client connection, as seen by a handler. */
export interface AgentConnection {
  /** Unique per server run; used as the Chat sink id. */
  readonly id: number;
  /** What the client declared in `system.hello` (the desktop app is `shell`). */
  readonly kind: ClientKind;
  /** True once the socket has closed. */
  readonly closed: boolean;
  /** Pushes an event to this client. Invalid payloads are dropped (and logged), never sent. */
  emit<E extends EventName>(method: E, payload: EventPayload<E>): void;
  /**
   * Reverse call: asks this client to serve a `shell.*` request and waits for its
   * validated result. Rejects with `ShellCallError` on the client's error, after
   * `timeoutMs`, or as soon as the connection closes (never hangs).
   */
  call<M extends ShellMethodName>(
    method: M,
    params: RequestParamsInput<M>,
    options: { readonly timeoutMs: number },
  ): Promise<RequestResult<M>>;
}

export type RequestHandler<M extends RequestMethodName> = (
  params: RequestParams<M>,
  connection: AgentConnection,
) => RequestResult<M> | Promise<RequestResult<M>>;

/** Methods the server serves beyond `system.*`; anything else answers `not_implemented`. */
export type RequestHandlers = { readonly [M in RequestMethodName]?: RequestHandler<M> };

/**
 * Phase 3: Dashboard reads plus the persistence check, served by the host's
 * Dashboard service (which validates every payload and result again).
 * Research actions are `researchHandlers`; backup is in `researchToolsHandlers`.
 */
export function dashboardHandlers(dashboard: DashboardService) {
  return {
    'tasks.counts': () => dashboard.taskCounts(),
    'tasks.list': (params) => dashboard.listTasks(params),
    'tasks.get': (params) => dashboard.getTask(params),
    'tasks.logs': (params) => dashboard.taskLogs(params),
    'tasks.runPersistenceCheck': () => dashboard.runPersistenceCheck(),
    'sources.list': (params) => dashboard.listSources(params),
    'sources.get': (params) => dashboard.getSource(params),
    'reports.list': (params) => dashboard.listReports(params),
    'reports.get': (params) => dashboard.getReport(params),
    'storage.status': () => dashboard.storageStatus(),
    'storage.integrityCheck': () => dashboard.integrityCheck(),
  } satisfies RequestHandlers;
}

export type DashboardMethodName = keyof ReturnType<typeof dashboardHandlers>;

/**
 * Phase 5: the research task lifecycle, through the same Dashboard service the
 * in-process IPC uses, so the runtime's rules (goal and model checks, engine
 * pinning, which actions a status allows) are unchanged. Progress is not a reply:
 * it is broadcast as `ui.researchProgress` to every connected shell.
 */
export function researchHandlers(dashboard: DashboardService) {
  return {
    'tasks.startResearch': (params) => dashboard.startResearch(params),
    'tasks.pause': (params) => dashboard.pauseTask(params),
    'tasks.resume': (params) => dashboard.resumeTask(params),
    'tasks.cancel': (params) => dashboard.cancelTask(params),
    'tasks.retry': (params) => dashboard.retryTask(params),
  } satisfies RequestHandlers;
}

/**
 * Phase 6: Research Tools and backup. Their dialogs and `openExternal` are reverse
 * calls to the shell that made the request (see `shell-ports.ts`). Picked paths stay
 * in the agent behind tokens; the backup dialog (and its overwrite confirmation)
 * belongs to the shell.
 */
export function researchToolsHandlers(
  researchTools: ResearchToolsService,
  dashboard: Pick<DashboardService, 'backup'>,
  snapshots: SnapshotStore,
) {
  return {
    'researchTools.status': () => researchTools.status(),
    'researchTools.checkSearch': () => researchTools.checkSearch(),
    'researchTools.search': (params) => researchTools.search(params),
    'researchTools.fetchUrl': (params) => researchTools.fetch(params),
    'researchTools.pickFile': () => researchTools.pickFile(),
    'researchTools.extractFile': (params) => researchTools.extractFile(params),
    // Agent Web API: no shell dialogs. The file's bytes instead of a picked path, and
    // the backup as a downloadable snapshot instead of a save dialog.
    'researchTools.extractUpload': (params) => researchTools.extractUpload(params),
    'storage.createSnapshot': () => snapshots.create(),
    'storage.readSnapshot': (params) => snapshots.read(params),
    'researchTools.saveSource': (params) => researchTools.saveSource(params),
    'researchTools.openUrl': (params) => researchTools.openUrl(params),
    'researchTools.cancel': (params) => {
      researchTools.cancel(params);
      return null;
    },
    'storage.backup': () => dashboard.backup(),
  } satisfies RequestHandlers;
}

/** A connection as a Chat sink: events go back as `chat.event` pushes to that client. */
export function connectionChatSink(connection: AgentConnection): ChatEventSink {
  return {
    id: connection.id,
    isDestroyed: () => connection.closed,
    send: (event) => connection.emit('chat.event', event),
  };
}

/**
 * Phase 4: Chat over the protocol. The host's ChatController keeps its rules: one
 * generation at a time (`busy`), stop by stream id, and a stream whose client is
 * gone is aborted. `model.health` lets the Chat page show the model state.
 */
export function chatHandlers(
  chat: Pick<ChatController, 'start' | 'stop'>,
  runtime: Pick<AgentRuntime, 'getModelHealth'>,
) {
  return {
    'chat.start': (params, connection) => chat.start(connectionChatSink(connection), params),
    'chat.stop': (params) => {
      chat.stop(params);
      return null;
    },
    'model.health': () => runtime.getModelHealth(),
  } satisfies RequestHandlers;
}

/**
 * Phase 7: Settings and the Ollama connection, through the same SettingsService
 * the in-process app uses (it validates every payload and result). Changes are
 * applied live to the agent's Ollama provider and web services and broadcast as
 * `ui.settingsChanged`. A secret arrives as ciphertext the shell encrypted; the
 * agent stores it and asks the shell to decrypt it (`secrets.ts`).
 * `settings.chooseBackupFolder` asks the requesting shell for the folder.
 */
export function settingsHandlers(
  settings: SettingsService,
  config: Pick<RuntimeConfig, 'secretChanged'>,
  secrets: Pick<AgentSecretStore, 'store'>,
) {
  return {
    'settings.get': () => settings.get(),
    'settings.validate': (params) => settings.validate(params),
    'settings.update': (params) => settings.update(params),
    'settings.reset': (params) => settings.reset(params),
    'settings.testSearxng': (params) => settings.testSearxng(params),
    'settings.chooseBackupFolder': () => settings.chooseBackupFolder(),
    'settings.storeSecret': async ({ key, ciphertext }) => {
      try {
        await secrets.store(key, ciphertext);
      } catch (error) {
        return {
          status: 'failed' as const,
          message: `The secret was not saved: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return config.secretChanged(key);
    },
    'model.testConnection': (params) => settings.ollamaTestConnection(params),
    'model.connectionState': () => settings.ollamaConnectionState(),
    'model.connect': () => settings.ollamaConnect(),
    'model.disconnect': () => settings.ollamaDisconnect(),
    'model.listModels': () => settings.ollamaListModels(),
    'model.showModel': (params) => settings.ollamaShowModel(params),
    'model.testModel': (params) => settings.ollamaTestModel(params),
    'model.effectiveConfig': () => settings.ollamaEffectiveConfig(),
  } satisfies RequestHandlers;
}

/**
 * Before the first request a desktop shell makes, the agent asks it to decrypt the
 * stored secrets (the Ollama token), so they are in memory before Chat, Research
 * or a health check needs them. Waiting for the first request (not the handshake)
 * guarantees the shell has registered its reverse-call handlers. Other clients
 * (`cli`, `test`) are never asked for secrets.
 */
export function withShellSecrets(
  handlers: RequestHandlers,
  secrets: Pick<AgentSecretStore, 'ready'>,
): RequestHandlers {
  const wrapped: Record<string, RequestHandler<RequestMethodName>> = {};
  for (const [method, handler] of Object.entries(handlers) as [
    RequestMethodName,
    RequestHandler<RequestMethodName>,
  ][]) {
    wrapped[method] = async (params, connection) => {
      if (connection.kind === 'shell') await secrets.ready(connection.id);
      return handler(params, connection);
    };
  }
  return wrapped as RequestHandlers;
}
