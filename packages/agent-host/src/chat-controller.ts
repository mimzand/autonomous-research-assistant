import { randomUUID } from 'node:crypto';
import { type AgentRuntime } from '@rka/agent-runtime';
import { isModelProviderError } from '@rka/model-provider';
import {
  CHAT_MAX_MESSAGES,
  ChatEventSchema,
  ChatHistorySchema,
  ChatStartRequestSchema,
  ChatStopRequestSchema,
  type ChatErrorCode,
  type ChatEvent,
  type ChatHistory,
  type ChatStartResult,
} from '@rka/shared';
import { isStorageError, type ConversationRepository } from '@rka/storage';
import { chatContext, type ChatContext } from './chat-context.js';
import { type ChatEngine, legacyChatEngine } from './chat-engine.js';

/**
 * Where a stream's events go: one renderer. The Electron adapter (a webContents
 * wrapper) is created at the IPC boundary in apps/desktop/src/main/ipc.ts.
 */
export interface ChatEventSink {
  readonly id: number;
  isDestroyed(): boolean;
  send(event: ChatEvent): void;
}

/** Token usage of one finished chat reply. */
export interface ChatUsage {
  readonly model: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalDurationMs: number | null;
  readonly loadDurationMs: number | null;
}

export interface ChatControllerDeps {
  readonly runtime: Pick<AgentRuntime, 'model' | 'streamChat'>;
  /** Called once per completed reply (e.g. to persist model usage). Must not throw. */
  readonly onUsage?: (usage: ChatUsage) => void;
  /**
   * Chooses the engine for a new request (feature flag `agent.engine`).
   * Called once per request, when it starts; defaults to the legacy engine.
   */
  readonly selectEngine?: () => ChatEngine;
  /** Injected for tests. */
  readonly newId?: () => string;
  /** The stored transcript (SQLite, one conversation): what Chat remembers. */
  readonly conversations: ConversationRepository;
}

interface ActiveStream {
  readonly streamId: string;
  readonly sinkId: number;
  readonly controller: AbortController;
  readonly finished: Promise<void>;
  /** The conversation this reply belongs to (its finish is dropped if it was deleted). */
  readonly conversationId: string;
}

/** How a reply ended, as stored. */
interface StoredReply {
  readonly status: 'complete' | 'cancelled' | 'error';
  readonly model?: string;
  readonly promptTokens?: number | null;
  readonly completionTokens?: number | null;
}

/**
 * Runs chat generations for the renderer (in the agent service, or in-process in
 * development): the renderer only sends validated requests and receives validated
 * events. One generation at a time (single local model, single GPU).
 *
 * The transcript is stored here: an accepted message is a row before streaming
 * starts, and the reply is a row when it ends (done, cancelled with text, or error).
 * The model receives only the last turns of that transcript (chat-context.ts).
 */
export class ChatController {
  private active: ActiveStream | undefined;
  private readonly newId: () => string;

  constructor(private readonly deps: ChatControllerDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  get activeStreamId(): string | undefined {
    return this.active?.streamId;
  }

  start(sink: ChatEventSink, payload: unknown): ChatStartResult {
    const parsed = ChatStartRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        status: 'rejected',
        code: 'invalid-request',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }
    if (this.active) {
      return {
        status: 'rejected',
        code: 'busy',
        message: 'A response is already being generated. Stop it or wait for it to finish.',
      };
    }
    const { conversations } = this.deps;
    const existing = conversations.current();
    // Room for this message and its reply; older messages are never dropped.
    if (existing && conversations.listMessages(existing.id).length > CHAT_MAX_MESSAGES - 2) {
      return {
        status: 'rejected',
        code: 'invalid-request',
        message: `The conversation is full (${CHAT_MAX_MESSAGES} messages). Clear the chat to continue.`,
      };
    }

    // Stored before streaming begins; the model's context comes from the stored rows.
    const { conversation } = conversations.append({
      role: 'user',
      content: parsed.data.text,
      status: 'complete',
    });
    const context = chatContext(conversations.listMessages(conversation.id));

    // The engine is fixed for this request: a later flag change affects only new requests.
    const engine = this.deps.selectEngine?.() ?? legacyChatEngine(this.deps.runtime);
    const streamId = this.newId();
    const controller = new AbortController();
    const finished = this.run(engine, sink, streamId, context, conversation.id, controller);
    this.active = {
      streamId,
      sinkId: sink.id,
      controller,
      finished,
      conversationId: conversation.id,
    };
    return { status: 'started', streamId, model: this.deps.runtime.model };
  }

  /** The stored transcript, oldest first (empty when there is none). */
  history(): ChatHistory {
    const { conversations } = this.deps;
    const conversation = conversations.current();
    if (!conversation) return { messages: [] };
    return ChatHistorySchema.parse({
      messages: conversations.listMessages(conversation.id).map((m) => ({
        role: m.role,
        content: m.content,
        status: m.status,
        model: m.model,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
      })),
    });
  }

  /**
   * Stops the active reply (if any), deletes the stored conversation, and resolves
   * once that reply has finished. Its late finish finds the conversation gone and
   * stores nothing; the next message starts a new conversation.
   */
  async clear(): Promise<void> {
    const active = this.active;
    active?.controller.abort();
    const ids = new Set([this.deps.conversations.current()?.id, active?.conversationId]);
    for (const id of ids) if (id) this.deps.conversations.delete(id);
    await active?.finished;
  }

  /** Cancels a stream. Unknown or finished stream ids are ignored. Throws on malformed input. */
  stop(payload: unknown): void {
    const { streamId } = ChatStopRequestSchema.parse(payload);
    if (this.active?.streamId === streamId) this.active.controller.abort();
  }

  /** Cancels whatever a closed window was generating. */
  stopForSink(sinkId: number): void {
    if (this.active?.sinkId === sinkId) this.active.controller.abort();
  }

  /** Resolves when the current stream (if any) has finished. For tests and shutdown. */
  async whenIdle(): Promise<void> {
    await this.active?.finished;
  }

  private reportUsage(usage: ChatUsage): void {
    try {
      this.deps.onUsage?.(usage);
    } catch (error) {
      // Recording usage must never break the conversation.
      console.error('Failed to record model usage:', error);
    }
  }

  /**
   * Stores the reply that just ended, unless its conversation was deleted (Clear)
   * in the meantime. Storing must never break the conversation on screen.
   */
  private storeReply(conversationId: string, content: string, reply: StoredReply): void {
    const { conversations } = this.deps;
    try {
      if (!conversations.get(conversationId)) return;
      conversations.append({
        conversationId,
        role: 'assistant',
        content,
        status: reply.status,
        ...(reply.model !== undefined && { model: reply.model }),
        ...(reply.promptTokens !== undefined && { promptTokens: reply.promptTokens }),
        ...(reply.completionTokens !== undefined && {
          completionTokens: reply.completionTokens,
        }),
      });
    } catch (error) {
      if (isStorageError(error) && error.code === 'not-found') return;
      console.error('Failed to store the chat reply:', error);
    }
  }

  private async run(
    engine: ChatEngine,
    sink: ChatEventSink,
    streamId: string,
    context: ChatContext,
    conversationId: string,
    controller: AbortController,
  ): Promise<void> {
    // Let start() return (and register `active`) before the first event.
    await Promise.resolve();

    const emit = (event: ChatEvent): void => {
      if (sink.isDestroyed()) {
        controller.abort();
        return;
      }
      sink.send(ChatEventSchema.parse(event));
    };
    /** The reply text so far (what the bubble shows). Tool steps are not stored. */
    let text = '';

    try {
      for await (const chunk of engine.streamChat(context.turns, {
        signal: controller.signal,
        ...(context.preface !== undefined && { preface: context.preface }),
      })) {
        if (chunk.type === 'delta') {
          text += chunk.content;
          if (chunk.content) emit({ type: 'delta', streamId, content: chunk.content });
        } else if (chunk.type === 'tool') {
          // A web-search step (Legacy Chat with web search): shown in the timeline.
          emit({
            type: 'tool',
            streamId,
            callId: chunk.callId,
            name: chunk.name,
            query: chunk.query,
            status: chunk.status,
            reason: chunk.reason,
            resultCount: chunk.resultCount,
          });
        } else if (chunk.type === 'usage') {
          // A model round that ended in tool calls: its tokens count too.
          this.reportUsage({ model: chunk.result.model, ...chunk.result.usage });
        } else {
          // Never report a success after the user cancelled.
          if (controller.signal.aborted) throw new Error('cancelled');
          this.reportUsage({ model: chunk.result.model, ...chunk.result.usage });
          this.storeReply(conversationId, text, {
            status: 'complete',
            model: chunk.result.model,
            promptTokens: chunk.result.usage.promptTokens,
            completionTokens: chunk.result.usage.completionTokens,
          });
          emit({
            type: 'done',
            streamId,
            model: chunk.result.model,
            finishReason: chunk.result.finishReason,
            completionTokens: chunk.result.usage.completionTokens,
            totalDurationMs: chunk.result.usage.totalDurationMs,
          });
        }
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        (isModelProviderError(error) && error.code === 'cancelled')
      ) {
        if (text) this.storeReply(conversationId, text, { status: 'cancelled' });
        emit({ type: 'cancelled', streamId });
      } else {
        // Kept (even empty) so the failed bubble can be shown again after a restart.
        this.storeReply(conversationId, text, { status: 'error' });
        emit({ type: 'error', streamId, ...toChatError(error) });
      }
    } finally {
      if (this.active?.streamId === streamId) this.active = undefined;
    }
  }
}

export function toChatError(error: unknown): { code: ChatErrorCode; message: string } {
  if (!isModelProviderError(error)) {
    return {
      code: 'generation-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  switch (error.code) {
    case 'unavailable':
    case 'model-not-found':
    case 'timeout':
    case 'invalid-request':
    case 'invalid-response':
    case 'unsupported':
      return { code: error.code, message: error.message };
    default:
      return { code: 'generation-failed', message: error.message };
  }
}
