import { randomUUID } from 'node:crypto';
import { type AgentRuntime } from '@rka/agent-runtime';
import { isModelProviderError } from '@rka/model-provider';
import {
  ChatEventSchema,
  ChatStartRequestSchema,
  ChatStopRequestSchema,
  type ChatErrorCode,
  type ChatEvent,
  type ChatStartResult,
} from '@rka/shared';

/** Where a stream's events go: one renderer (webContents). */
export interface ChatEventSink {
  readonly id: number;
  isDestroyed(): boolean;
  send(event: ChatEvent): void;
}

export interface ChatControllerDeps {
  readonly runtime: Pick<AgentRuntime, 'model' | 'streamChat'>;
  /** Injected for tests. */
  readonly newId?: () => string;
}

interface ActiveStream {
  readonly streamId: string;
  readonly sinkId: number;
  readonly controller: AbortController;
  readonly finished: Promise<void>;
}

/**
 * Runs chat generations for the renderer. Lives in the main process: the
 * renderer only sends validated requests and receives validated events.
 * One generation at a time (single local model, single GPU).
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

    const streamId = this.newId();
    const controller = new AbortController();
    const finished = this.run(sink, streamId, parsed.data.messages, controller);
    this.active = { streamId, sinkId: sink.id, controller, finished };
    return { status: 'started', streamId, model: this.deps.runtime.model };
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

  private async run(
    sink: ChatEventSink,
    streamId: string,
    turns: Parameters<AgentRuntime['streamChat']>[0],
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

    try {
      for await (const chunk of this.deps.runtime.streamChat(turns, {
        signal: controller.signal,
      })) {
        if (chunk.type === 'delta') {
          if (chunk.content) emit({ type: 'delta', streamId, content: chunk.content });
        } else {
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
        emit({ type: 'cancelled', streamId });
      } else {
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
