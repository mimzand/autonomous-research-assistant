import { type AgentClient } from '@rka/agent-client';
import {
  ChatStartRequestSchema,
  ChatStartResultSchema,
  ChatStopRequestSchema,
  IpcEvents,
  type ChatEvent,
  type ChatStartResult,
} from '@rka/shared';
import { type SenderLike } from './ipc.js';

/** Starting a reply only needs the agent to accept it; the stream itself arrives as events. */
export const SERVICE_CHAT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Events for a stream id the shell does not know yet are held while a start is in
 * flight: the agent's first events can be decoded before the `chat.start` reply's
 * continuation runs. Bounded so a misbehaving agent cannot grow it.
 */
const MAX_EARLY_EVENTS = 256;

export const AGENT_DISCONNECTED_MESSAGE =
  'The agent service disconnected. Restart the app to use Chat.';

export interface ServiceChatDeps {
  readonly client: Pick<AgentClient, 'request' | 'onEvent' | 'onClose'>;
  readonly log?: Pick<Console, 'warn'>;
}

export interface ServiceChat {
  start(sender: SenderLike, payload: unknown): Promise<ChatStartResult>;
  stop(payload: unknown): Promise<void>;
}

const isTerminal = (event: ChatEvent) =>
  event.type === 'done' || event.type === 'error' || event.type === 'cancelled';

/**
 * AGENT_TRANSPORT=service: Chat runs in the agent's ChatController. This keeps
 * the in-process semantics on the shell side: events go to the window that
 * started the stream (`webContents.send(chat:event)`), closing that window stops
 * its stream, and a lost agent ends open streams with an `unavailable` error.
 */
export function createServiceChat(deps: ServiceChatDeps): ServiceChat {
  const { client } = deps;
  const log = deps.log ?? console;
  const streams = new Map<string, SenderLike>();
  const watchedSenders = new Set<number>();
  const early: ChatEvent[] = [];
  let pendingStarts = 0;
  let disconnected = false;

  const stopRemote = (streamId: string) => {
    if (disconnected) return;
    client
      .request('chat.stop', { streamId }, { timeoutMs: SERVICE_CHAT_REQUEST_TIMEOUT_MS })
      .catch((error: unknown) =>
        log.warn(`Could not stop chat stream ${streamId}: ${(error as Error).message}`),
      );
  };

  const deliver = (event: ChatEvent) => {
    const sender = streams.get(event.streamId);
    if (!sender) {
      if (pendingStarts > 0 && early.length < MAX_EARLY_EVENTS) early.push(event);
      return;
    }
    if (isTerminal(event)) streams.delete(event.streamId);
    if (sender.isDestroyed()) {
      streams.delete(event.streamId);
      if (!isTerminal(event)) stopRemote(event.streamId);
      return;
    }
    sender.send(IpcEvents.chatEvent, event);
  };

  client.onEvent((event) => {
    if (event.method === 'chat.event') deliver(event.payload);
  });

  client.onClose(() => {
    disconnected = true;
    early.length = 0;
    for (const [streamId, sender] of streams) {
      if (sender.isDestroyed()) continue;
      const event: ChatEvent = {
        type: 'error',
        streamId,
        code: 'unavailable',
        message: AGENT_DISCONNECTED_MESSAGE,
      };
      sender.send(IpcEvents.chatEvent, event);
    }
    streams.clear();
  });

  const watch = (sender: SenderLike) => {
    if (watchedSenders.has(sender.id)) return;
    watchedSenders.add(sender.id);
    // Closing the window cancels its generation (as stopForSink does in-process).
    sender.once('destroyed', () => {
      watchedSenders.delete(sender.id);
      for (const [streamId, owner] of streams) {
        if (owner !== sender) continue;
        streams.delete(streamId);
        stopRemote(streamId);
      }
    });
  };

  return {
    async start(sender, payload) {
      const parsed = ChatStartRequestSchema.safeParse(payload);
      if (!parsed.success) {
        // Same rejection the in-process ChatController returns.
        return {
          status: 'rejected',
          code: 'invalid-request',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        };
      }
      watch(sender);
      pendingStarts++;
      try {
        const result = ChatStartResultSchema.parse(
          await client.request('chat.start', parsed.data, {
            timeoutMs: SERVICE_CHAT_REQUEST_TIMEOUT_MS,
          }),
        );
        if (result.status === 'started') {
          streams.set(result.streamId, sender);
          const held = early.filter((e) => e.streamId === result.streamId);
          for (const event of held) early.splice(early.indexOf(event), 1);
          for (const event of held) deliver(event);
          if (sender.isDestroyed() && streams.has(result.streamId)) {
            streams.delete(result.streamId);
            stopRemote(result.streamId);
          }
        }
        return result;
      } finally {
        pendingStarts--;
        if (pendingStarts === 0) early.length = 0;
      }
    },

    async stop(payload) {
      const { streamId } = ChatStopRequestSchema.parse(payload);
      await client.request(
        'chat.stop',
        { streamId },
        { timeoutMs: SERVICE_CHAT_REQUEST_TIMEOUT_MS },
      );
    },
  };
}
