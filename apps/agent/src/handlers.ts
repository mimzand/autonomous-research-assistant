import {
  type RequestMethodName,
  type RequestParams,
  type RequestResult,
} from '@rka/agent-protocol';
import { type DashboardService } from '@rka/agent-host';

export type RequestHandler<M extends RequestMethodName> = (
  params: RequestParams<M>,
) => RequestResult<M> | Promise<RequestResult<M>>;

/** Methods the server serves beyond `system.*`; anything else answers `not_implemented`. */
export type RequestHandlers = { readonly [M in RequestMethodName]?: RequestHandler<M> };

/**
 * Phase 3: Dashboard reads plus the persistence check, served by the host's
 * Dashboard service (which validates every payload and result again).
 * Research actions (Phase 5) and backup (Phase 6) are not served yet.
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
