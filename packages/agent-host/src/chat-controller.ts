import { randomUUID } from 'node:crypto';
import { type AgentRuntime } from '@rka/agent-runtime';
import { isModelProviderError } from '@rka/model-provider';
import {
  CHAT_MAX_MESSAGES,
  ChatConversationListSchema,
  ChatConversationRequestSchema,
  ChatCreateResultSchema,
  ChatEventSchema,
  ChatHistorySchema,
  ChatStartRequestSchema,
  ChatStopRequestSchema,
  type ChatErrorCode,
  type ChatConversationList,
  type ChatCreateResult,
  type ChatEvent,
  type ChatHistory,
  type ChatStartResult,
} from '@rka/shared';
import { isStorageError, type ConversationRepository } from '@rka/storage';
import { chatContext, chatWindow, newlyOmitted } from './chat-context.js';
import { type ChatEngine, legacyChatEngine } from './chat-engine.js';
import {
  acceptSummary,
  clipForSummary,
  SUMMARY_TIMEOUT_MS,
  type ChatSummarizer,
} from './chat-summary.js';

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
  /** The stored conversations (SQLite): what Chat remembers, per conversation. */
  readonly conversations: ConversationRepository;
  /**
   * Folds turns that fell out of the context window into the conversation's
   * summary (the host uses the local model). Without it, older turns are only
   * represented by the code-built note.
   */
  readonly summarize?: ChatSummarizer;
  /** Deadline for one summarize call. Injected for tests. */
  readonly summaryTimeoutMs?: number;
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
 * Many conversations may exist; every request names one, and only that
 * conversation's rows (and summary) are read for it. The transcript is stored
 * here: an accepted message is a row before streaming starts, and the reply is a
 * row when it ends (done, cancelled with text, or error). The model receives only
 * the last turns of that conversation plus a summary of older ones (chat-context.ts).
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
    const { conversationId, text } = parsed.data;
    const { conversations } = this.deps;
    if (!conversations.get(conversationId)) {
      return {
        status: 'rejected',
        code: 'invalid-request',
        message: 'That conversation does not exist. Choose or create another one.',
      };
    }
    // Room for this message and its reply; older messages are never dropped.
    if (conversations.listMessages(conversationId).length > CHAT_MAX_MESSAGES - 2) {
      return {
        status: 'rejected',
        code: 'invalid-request',
        message: `The conversation is full (${CHAT_MAX_MESSAGES} messages). Start a new chat to continue.`,
      };
    }

    // Stored before streaming begins; the model's context comes from the stored rows.
    conversations.append({ conversationId, role: 'user', content: text, status: 'complete' });

    // The engine is fixed for this request: a later flag change affects only new requests.
    const engine = this.deps.selectEngine?.() ?? legacyChatEngine(this.deps.runtime);
    const streamId = this.newId();
    const controller = new AbortController();
    const finished = this.run(engine, sink, streamId, conversationId, controller);
    this.active = { streamId, sinkId: sink.id, controller, finished, conversationId };
    return { status: 'started', streamId, model: this.deps.runtime.model };
  }

  /** Conversations, newest-updated first. */
  list(): ChatConversationList {
    return ChatConversationListSchema.parse({
      conversations: this.deps.conversations
        .list()
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    });
  }

  /** A new empty conversation (`New chat`). */
  create(): ChatCreateResult {
    return ChatCreateResultSchema.parse({ conversationId: this.deps.conversations.create().id });
  }

  /** One conversation's stored transcript, oldest first (empty for an unknown id). */
  history(payload: unknown): ChatHistory {
    const { conversationId } = ChatConversationRequestSchema.parse(payload);
    return ChatHistorySchema.parse({
      messages: this.deps.conversations.listMessages(conversationId).map((m) => ({
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
   * Deletes one conversation and its messages. If the running reply belongs to it,
   * that reply is stopped first and this resolves once it has finished (its late
   * finish finds the conversation gone and stores nothing). A reply running in
   * another conversation is left alone.
   */
  async clear(payload: unknown): Promise<void> {
    const { conversationId } = ChatConversationRequestSchema.parse(payload);
    const own = this.active?.conversationId === conversationId ? this.active : undefined;
    own?.controller.abort();
    this.deps.conversations.delete(conversationId);
    await own?.finished;
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

  /**
   * Folds the turns that newly fell out of the window into this conversation's
   * summary. Calls the model only when there are such turns; on any failure
   * (throw, timeout, invalid text) the stored summary and cursor stay as they were.
   * Never throws.
   */
  private async updateSummary(conversationId: string, signal: AbortSignal): Promise<void> {
    const { conversations, summarize } = this.deps;
    if (!summarize) return;
    const conversation = conversations.get(conversationId);
    if (!conversation) return;
    const fresh = newlyOmitted(
      chatWindow(conversations.listMessages(conversationId)).omitted,
      conversation.summarizedThroughSeq,
    );
    const throughSeq = fresh.at(-1)?.seq;
    if (throughSeq === undefined) return;

    const deadline = new AbortController();
    const abort = () => deadline.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.deps.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS);
    try {
      const ended = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(new Error('The summary call was stopped or timed out.'));
        if (deadline.signal.aborted) fail();
        else deadline.signal.addEventListener('abort', fail, { once: true });
      });
      ended.catch(() => undefined);
      const text = await Promise.race([
        summarize({
          previousSummary: conversation.summary ?? '',
          turns: fresh.map(clipForSummary),
          signal: deadline.signal,
        }),
        ended,
      ]);
      const summary = acceptSummary(text);
      if (summary === null) {
        console.warn('Chat summary rejected: empty or longer than allowed.');
        return;
      }
      if (signal.aborted) return;
      conversations.setSummary({ conversationId, summary, throughSeq });
    } catch (error) {
      // Diagnostics only: never the conversation text.
      const reason = error instanceof Error ? error.name : typeof error;
      console.warn(`Chat summary skipped (${reason}); the previous summary is kept.`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private async run(
    engine: ChatEngine,
    sink: ChatEventSink,
    streamId: string,
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
      // After the user row is stored and before the reply stream: once per message.
      await this.updateSummary(conversationId, controller.signal);
      if (controller.signal.aborted) throw new Error('cancelled');
      // Only this conversation's rows and summary.
      const context = chatContext(this.deps.conversations.listMessages(conversationId), {
        summary: this.deps.conversations.get(conversationId)?.summary ?? null,
      });
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
