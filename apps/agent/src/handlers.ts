import {
  type EventName,
  type EventPayload,
  type RequestMethodName,
  type RequestParams,
  type RequestResult,
} from '@rka/agent-protocol';
import { type ChatController, type ChatEventSink, type DashboardService } from '@rka/agent-host';
import { type AgentRuntime } from '@rka/agent-runtime';

/** One authenticated client connection, as seen by a handler. */
export interface AgentConnection {
  /** Unique per server run; used as the Chat sink id. */
  readonly id: number;
  /** True once the socket has closed. */
  readonly closed: boolean;
  /** Pushes an event to this client. Invalid payloads are dropped (and logged), never sent. */
  emit<E extends EventName>(method: E, payload: EventPayload<E>): void;
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
 * Research actions are `researchHandlers`; backup (Phase 6) is not served yet.
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
