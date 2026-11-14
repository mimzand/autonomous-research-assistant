import { type AgentClient } from '@rka/agent-client';
import { parseRequest, type RequestMethodName } from '@rka/agent-protocol';
import { AppInfoSchema, IpcChannels, type AppInfo, type IpcChannel } from '@rka/shared';
import { createIpcGuard, type IpcMainLike } from './ipc.js';

/** Upper bound for one proxied call; an integrity check of a large database takes a while. */
export const SERVICE_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Renderer channels the agent service serves (Phase 3: Dashboard reads, the
 * persistence check, storage status and integrity). Payloads and results use the
 * same `@rka/shared` schemas through the protocol registry.
 */
export const SERVICE_ROUTES = {
  [IpcChannels.tasksCounts]: 'tasks.counts',
  [IpcChannels.tasksList]: 'tasks.list',
  [IpcChannels.tasksGet]: 'tasks.get',
  [IpcChannels.tasksLogs]: 'tasks.logs',
  [IpcChannels.tasksRunPersistenceCheck]: 'tasks.runPersistenceCheck',
  [IpcChannels.sourcesList]: 'sources.list',
  [IpcChannels.sourcesGet]: 'sources.get',
  [IpcChannels.reportsList]: 'reports.list',
  [IpcChannels.reportsGet]: 'reports.get',
  [IpcChannels.storageStatus]: 'storage.status',
  [IpcChannels.storageIntegrityCheck]: 'storage.integrityCheck',
} as const satisfies Partial<Record<IpcChannel, RequestMethodName>>;

export interface ServiceIpcDeps {
  readonly client: Pick<AgentClient, 'request'>;
  readonly getAppInfo: () => AppInfo;
  readonly isTrustedSender: (url: string) => boolean;
}

/**
 * AGENT_TRANSPORT=service: registers every renderer channel without any local
 * database. Routed channels go to the agent; the rest need the in-process agent
 * (Chat, Settings, Research Tools, research actions, backup) and fail with a clear
 * message until their phase moves them.
 */
export function registerServiceIpcHandlers(ipc: IpcMainLike, deps: ServiceIpcDeps): void {
  const guard = createIpcGuard(deps.isTrustedSender);
  const routes = new Map<string, RequestMethodName>(Object.entries(SERVICE_ROUTES));
  for (const channel of Object.values(IpcChannels)) {
    if (channel === IpcChannels.appGetInfo) {
      ipc.handle(
        channel,
        guard(() => AppInfoSchema.parse(deps.getAppInfo())),
      );
      continue;
    }
    const method = routes.get(channel);
    ipc.handle(
      channel,
      guard((_event, payload) =>
        method ? forward(deps.client, method, payload) : unavailable(channel),
      ),
    );
  }
}

/** Validates the renderer payload with the protocol schema, then asks the agent. */
async function forward(
  client: ServiceIpcDeps['client'],
  method: RequestMethodName,
  payload: unknown,
): Promise<unknown> {
  const parsed = parseRequest(
    { id: 'ipc', kind: 'req', method, payload: payload ?? {} },
    'toAgent',
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  return client.request(method, parsed.value.params as never, {
    timeoutMs: SERVICE_REQUEST_TIMEOUT_MS,
  });
}

function unavailable(channel: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${channel} is not available with AGENT_TRANSPORT=service yet. Unset AGENT_TRANSPORT to use it.`,
    ),
  );
}
