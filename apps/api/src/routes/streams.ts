import { type ParsedEvent } from '@rka/agent-protocol';
import {
  ChatEventSchema,
  ChatStartRequestSchema,
  type ChatEvent,
  type ResearchProgressEvent,
} from '@rka/shared';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import { type AgentLink } from '../agent-link.js';
import { ApiError, ErrorBodySchema } from '../errors.js';
import { COMMON_ERRORS, route, type ApiRoute } from '../route.js';

export const SSE_KEEPALIVE_MS = 15_000;
const TERMINAL: ReadonlySet<ChatEvent['type']> = new Set(['done', 'error', 'cancelled']);

/**
 * A queue of server-sent events with a keepalive comment, ended by the producer, the
 * client going away, or the agent connection closing.
 */
async function pump<T>(
  stream: SSEStreamingApi,
  subscribe: (push: (item: T) => void, end: (reason?: string) => void) => () => void,
  write: (item: T) => Promise<boolean>,
): Promise<void> {
  const queue: T[] = [];
  let ended: string | null | undefined;
  let wake: (() => void) | undefined;
  const signal = () => {
    wake?.();
    wake = undefined;
  };
  const unsubscribe = subscribe(
    (item) => {
      queue.push(item);
      signal();
    },
    (reason) => {
      ended = reason ?? null;
      signal();
    },
  );
  const keepalive = setInterval(
    () => void stream.write(': keepalive\n\n').catch(() => undefined),
    SSE_KEEPALIVE_MS,
  );
  stream.onAbort(() => {
    ended ??= null;
    signal();
  });
  try {
    for (;;) {
      while (queue.length > 0) {
        const item = queue.shift() as T;
        if (!(await write(item))) return;
      }
      if (ended !== undefined) {
        if (ended) await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: ended }) });
        return;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    clearInterval(keepalive);
    unsubscribe();
  }
}

const SseResponse = (what: string) => ({
  description: what,
  contentType: 'text/event-stream',
});

export function streamRoutes(agent: AgentLink): ApiRoute[] {
  return [
    route({
      method: 'post',
      path: '/chat',
      tag: 'Chat',
      summary: 'Start a Chat reply and stream it (server-sent events)',
      description:
        'Responds with text/event-stream. First event `started` ({streamId, model}), then one ' +
        'event per chat.event, named by its type: `delta` ({content}), `tool`, and a final `done`, ' +
        '`error` or `cancelled`. Closing the connection stops the reply. To stop it from ' +
        'elsewhere: POST /chat/{streamId}/stop. One reply at a time (409 while busy).',
      body: ChatStartRequestSchema,
      responses: {
        200: SseResponse('The reply as server-sent events'),
        409: { description: 'Another reply is running', schema: ErrorBodySchema },
        ...COMMON_ERRORS,
      },
      async handle({ c, body }) {
        // Subscribe before starting: the first deltas may arrive before chat.start answers.
        const early: ChatEvent[] = [];
        let forward: ((event: ChatEvent) => void) | undefined;
        const offEvents = agent.onEvent((event: ParsedEvent) => {
          if (event.method !== 'chat.event') return;
          if (forward) forward(event.payload);
          else early.push(event.payload);
        });
        let started;
        try {
          started = await agent.request('chat.start', body);
        } catch (error) {
          offEvents();
          throw error;
        }
        if (started.status === 'rejected') {
          offEvents();
          const status = started.code === 'busy' ? 409 : 400;
          throw new ApiError(status, started.code, started.message);
        }
        const { streamId, model } = started;
        return streamSSE(c, async (stream) => {
          await stream.writeSSE({ event: 'started', data: JSON.stringify({ streamId, model }) });
          let finished = false;
          stream.onAbort(() => {
            if (!finished) void agent.request('chat.stop', { streamId }).catch(() => undefined);
          });
          await pump<ChatEvent>(
            stream,
            (push, end) => {
              forward = (event) => {
                if (event.streamId === streamId) push(event);
              };
              for (const event of early.splice(0)) forward(event);
              const offDisconnect = agent.onDisconnect(() => end('agent_disconnected'));
              return () => {
                offEvents();
                offDisconnect();
              };
            },
            async (event) => {
              const { streamId: _id, type, ...data } = ChatEventSchema.parse(event);
              await stream.writeSSE({ event: type, data: JSON.stringify(data) });
              if (TERMINAL.has(type)) {
                finished = true;
                return false;
              }
              return true;
            },
          );
        });
      },
    }),
    route({
      method: 'post',
      path: '/chat/{streamId}/stop',
      tag: 'Chat',
      summary: 'Stop a running Chat reply',
      params: z.object({ streamId: z.string().min(1).max(100) }),
      responses: { 204: { description: 'Stop requested' }, ...COMMON_ERRORS },
      async handle({ c, params }) {
        await agent.request('chat.stop', { streamId: params.streamId });
        return c.body(null, 204);
      },
    }),
    route({
      method: 'get',
      path: '/events/research',
      tag: 'Research',
      summary: 'Research progress (server-sent events)',
      description:
        'Responds with text/event-stream: one `progress` event per ui.researchProgress ' +
        '(task status, step started/completed/failed, source added). Optional taskId filter. ' +
        'Ends with an `error` event if the agent connection closes.',
      query: z.object({ taskId: z.string().min(1).max(100).optional() }),
      responses: { 200: SseResponse('Progress events'), ...COMMON_ERRORS },
      async handle({ c, query }) {
        await agent.ensure(); // 503 before the stream opens when the agent is down
        return streamSSE(c, (stream) =>
          pump<ResearchProgressEvent>(
            stream,
            (push, end) => {
              const offEvents = agent.onEvent((event) => {
                if (event.method !== 'ui.researchProgress') return;
                if (!query.taskId || event.payload.taskId === query.taskId) push(event.payload);
              });
              const offDisconnect = agent.onDisconnect(() => end('agent_disconnected'));
              return () => {
                offEvents();
                offDisconnect();
              };
            },
            async (event) => {
              await stream.writeSSE({ event: 'progress', data: JSON.stringify(event) });
              return true;
            },
          ),
        );
      },
    }),
  ];
}
