import { basename } from 'node:path';
import { PongSchema } from '@rka/agent-protocol';
import {
  IntegrityCheckResultSchema,
  ModelHealthSchema,
  ReportDetailsSchema,
  ReportListResultSchema,
  SourceDetailsSchema,
  SourceListResultSchema,
  StartResearchRequestSchema,
  StorageStatusSchema,
  TaskActionResultSchema,
  TaskDetailsSchema,
  TaskListResultSchema,
  TaskLogListSchema,
  TaskStatusCountsSchema,
  TaskStatusSchema,
  type TaskActionResult,
} from '@rka/shared';
import { z } from 'zod';
import { type AgentLink } from '../agent-link.js';
import { ApiError, ErrorBodySchema } from '../errors.js';
import { COMMON_ERRORS, IdParams, route, type ApiRoute } from '../route.js';

const Limit = z.coerce.number().int().optional();
const Offset = z.coerce.number().int().optional();
const Search = z.string().max(200).optional();

const NotFound = { description: 'Not found', schema: ErrorBodySchema };
const Rejected = {
  description: 'The action is not possible in the current state',
  schema: ErrorBodySchema,
};

const found = <T>(value: T | null, what: string): T => {
  if (value === null) throw new ApiError(404, 'not_found', `${what} not found.`);
  return value;
};

/** `{ status: 'ok' }` as 200; `rejected` (e.g. pausing a finished task) as 409. */
const action = (c: { json: (v: unknown, s?: 200) => Response }, result: TaskActionResult) => {
  if (result.status === 'rejected') throw new ApiError(409, 'rejected', result.message);
  return c.json(result, 200);
};

export function coreRoutes(agent: AgentLink): ApiRoute[] {
  return [
    // --- Phase 1: health and the agent connection ---------------------------------------
    route({
      method: 'get',
      path: '/health',
      tag: 'System',
      summary: 'API liveness and whether the agent service is reachable',
      auth: false,
      responses: {
        200: {
          description: 'The API is running',
          schema: z.object({
            status: z.literal('ok'),
            agent: z.enum(['connected', 'unavailable']),
          }),
        },
      },
      async handle({ c }) {
        const reachable = await agent.ensure().then(
          () => true,
          () => false,
        );
        return c.json({ status: 'ok', agent: reachable ? 'connected' : 'unavailable' });
      },
    }),
    route({
      method: 'get',
      path: '/agent/ping',
      tag: 'System',
      summary: 'Authenticated round trip to the agent service (system.ping)',
      responses: {
        200: {
          description: 'The agent answered',
          schema: z.object({
            agent: z.object({ pid: z.int(), version: z.string(), protocol: z.int() }),
            agentTime: PongSchema.shape.agentTime,
            roundTripMs: z.int(),
          }),
        },
        ...COMMON_ERRORS,
      },
      async handle({ c }) {
        const info = await agent.ensure();
        const started = performance.now();
        const pong = await agent.request('system.ping', {});
        return c.json({
          agent: info,
          agentTime: pong.agentTime,
          roundTripMs: Math.round(performance.now() - started),
        });
      },
    }),

    // --- Phase 2: dashboard surface ------------------------------------------------------
    route({
      method: 'get',
      path: '/model/health',
      tag: 'Model',
      summary: 'Ollama reachability and whether the configured model is installed',
      responses: {
        200: { description: 'Model health', schema: ModelHealthSchema },
        ...COMMON_ERRORS,
      },
      handle: async ({ c }) => c.json(await agent.request('model.health', {})),
    }),
    route({
      method: 'get',
      path: '/tasks/counts',
      tag: 'Tasks',
      summary: 'Number of tasks per status',
      responses: {
        200: { description: 'Counts', schema: TaskStatusCountsSchema },
        ...COMMON_ERRORS,
      },
      handle: async ({ c }) => c.json(await agent.request('tasks.counts', {})),
    }),
    route({
      method: 'get',
      path: '/tasks',
      tag: 'Tasks',
      summary: 'List tasks (newest first)',
      query: z.object({
        status: z
          .union([TaskStatusSchema, z.array(TaskStatusSchema)])
          .optional()
          .describe('Repeat to filter by several statuses'),
        search: Search,
        limit: Limit,
        offset: Offset,
      }),
      responses: {
        200: { description: 'A page of tasks', schema: TaskListResultSchema },
        ...COMMON_ERRORS,
      },
      handle: async ({ c, query }) => {
        const { status, ...rest } = query;
        const statuses =
          status === undefined ? undefined : Array.isArray(status) ? status : [status];
        return c.json(
          await agent.request('tasks.list', { ...rest, ...(statuses && { status: statuses }) }),
        );
      },
    }),
    route({
      method: 'get',
      path: '/tasks/{id}',
      tag: 'Tasks',
      summary: 'One task with its steps, research details and recovery state',
      params: IdParams,
      responses: {
        200: { description: 'The task', schema: TaskDetailsSchema },
        404: NotFound,
        ...COMMON_ERRORS,
      },
      handle: async ({ c, params }) =>
        c.json(found(await agent.request('tasks.get', { id: params.id }), 'Task')),
    }),
    route({
      method: 'get',
      path: '/tasks/{id}/logs',
      tag: 'Tasks',
      summary: 'Execution log of a task (incremental with afterSeq)',
      params: IdParams,
      query: z.object({ afterSeq: z.coerce.number().int().optional() }),
      responses: {
        200: { description: 'Log entries', schema: TaskLogListSchema },
        ...COMMON_ERRORS,
      },
      handle: async ({ c, params, query }) =>
        c.json(await agent.request('tasks.logs', { id: params.id, ...query })),
    }),

    // --- Phase 2: research actions -------------------------------------------------------
    route({
      method: 'post',
      path: '/tasks/research',
      tag: 'Research',
      summary: 'Start an autonomous research task',
      description: 'Progress is pushed on GET /events/research.',
      body: StartResearchRequestSchema,
      responses: {
        200: { description: 'Started', schema: TaskActionResultSchema },
        409: Rejected,
        ...COMMON_ERRORS,
      },
      handle: async ({ c, body }) => action(c, await agent.request('tasks.startResearch', body)),
    }),
    ...(['pause', 'resume', 'cancel', 'retry'] as const).map((verb) =>
      route({
        method: 'post',
        path: `/tasks/{id}/${verb}`,
        tag: 'Research',
        summary: `${verb[0]?.toUpperCase()}${verb.slice(1)} a research task`,
        params: IdParams,
        responses: {
          200: { description: 'Done', schema: TaskActionResultSchema },
          409: Rejected,
          ...COMMON_ERRORS,
        },
        handle: async ({ c, params }) =>
          action(c, await agent.request(`tasks.${verb}`, { id: params.id })),
      }),
    ),

    // --- Phase 2: sources, reports, storage ----------------------------------------------
    route({
      method: 'get',
      path: '/sources',
      tag: 'Knowledge base',
      summary: 'List saved sources',
      query: z.object({
        taskId: z.string().max(100).optional(),
        search: Search,
        content: z.enum(['all', 'extracted', 'missing']).optional(),
        limit: Limit,
        offset: Offset,
      }),
      responses: {
        200: { description: 'A page of sources', schema: SourceListResultSchema },
        ...COMMON_ERRORS,
      },
      handle: async ({ c, query }) => c.json(await agent.request('sources.list', query)),
    }),
    route({
      method: 'get',
      path: '/sources/{id}',
      tag: 'Knowledge base',
      summary: 'One source with its extracted text and evidence',
      params: IdParams,
      responses: {
        200: { description: 'The source', schema: SourceDetailsSchema },
        404: NotFound,
        ...COMMON_ERRORS,
      },
      handle: async ({ c, params }) =>
        c.json(found(await agent.request('sources.get', { id: params.id }), 'Source')),
    }),
    route({
      method: 'get',
      path: '/reports',
      tag: 'Knowledge base',
      summary: 'List reports',
      query: z.object({
        taskId: z.string().max(100).optional(),
        search: Search,
        limit: Limit,
        offset: Offset,
      }),
      responses: {
        200: { description: 'A page of reports', schema: ReportListResultSchema },
        ...COMMON_ERRORS,
      },
      handle: async ({ c, query }) => c.json(await agent.request('reports.list', query)),
    }),
    route({
      method: 'get',
      path: '/reports/{id}',
      tag: 'Knowledge base',
      summary: 'One report with its citations',
      params: IdParams,
      responses: {
        200: { description: 'The report', schema: ReportDetailsSchema },
        404: NotFound,
        ...COMMON_ERRORS,
      },
      handle: async ({ c, params }) =>
        c.json(found(await agent.request('reports.get', { id: params.id }), 'Report')),
    }),
    route({
      method: 'get',
      path: '/storage/status',
      tag: 'Storage',
      summary: 'Database size, file name and row counts',
      description:
        "`path` is the database file name only (the agent's local folder is not exposed).",
      responses: { 200: { description: 'Status', schema: StorageStatusSchema }, ...COMMON_ERRORS },
      handle: async ({ c }) => {
        const status = await agent.request('storage.status', {});
        return c.json({ ...status, path: basename(status.path) });
      },
    }),
    route({
      method: 'post',
      path: '/storage/integrity-check',
      tag: 'Storage',
      summary: 'Run SQLite integrity_check on the agent database',
      responses: {
        200: { description: 'Result', schema: IntegrityCheckResultSchema },
        ...COMMON_ERRORS,
      },
      handle: async ({ c }) =>
        c.json(await agent.request('storage.integrityCheck', {}, { timeoutMs: 5 * 60_000 })),
    }),
  ];
}
