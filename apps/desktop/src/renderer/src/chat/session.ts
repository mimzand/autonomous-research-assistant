import {
  type ChatApi,
  type ChatErrorCode,
  type ChatEvent,
  type ChatStartResult,
  type ChatTurn,
} from '@rka/shared';
import { computed, ref } from 'vue';
import { describeChatError, type ChatErrorView } from './errors';

export type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';

export interface UiMessage {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  error: ChatErrorView | null;
  stats: { tokens: number | null; durationMs: number | null } | null;
}

/** idle → starting → generating → (stopping) → idle */
export type ChatPhase = 'idle' | 'starting' | 'generating' | 'stopping';

export interface ChatSessionOptions {
  /** Model name to show before the first reply (from the health check). */
  readonly model: () => string;
  /** Called after errors that may mean the model status changed. */
  readonly onConnectionProblem?: () => void;
}

/**
 * Chat state for one window: conversation history (kept for the session),
 * the current generation, and cancel/clear. Talks only to the preload
 * `ChatApi`; never to Ollama.
 */
export function createChatSession(api: ChatApi, options: ChatSessionOptions) {
  const messages = ref<UiMessage[]>([]);
  const draft = ref('');
  const phase = ref<ChatPhase>('idle');

  let nextId = 1;
  let streamId: string | null = null;
  let current: UiMessage | null = null;
  let stopRequested = false;
  /** Events that arrived while `start` was still resolving. */
  let early: ChatEvent[] = [];

  const busy = computed(() => phase.value !== 'idle');
  const canSend = computed(() => !busy.value && draft.value.trim().length > 0);

  function push(message: Omit<UiMessage, 'id'>): UiMessage {
    messages.value.push({ id: nextId++, ...message });
    // Return the reactive proxy so later mutations update the view.
    return messages.value[messages.value.length - 1] as UiMessage;
  }

  function finish(): void {
    phase.value = 'idle';
    streamId = null;
    current = null;
    stopRequested = false;
    early = [];
  }

  function fail(code: ChatErrorCode, detail: string): void {
    if (current) {
      current.status = 'error';
      current.error = describeChatError(code, detail, options.model());
    }
    if (code === 'unavailable' || code === 'model-not-found') options.onConnectionProblem?.();
    finish();
  }

  function apply(event: ChatEvent): void {
    if (!current) return;
    switch (event.type) {
      case 'delta':
        current.content += event.content;
        break;
      case 'done':
        current.status = 'complete';
        current.stats = { tokens: event.completionTokens, durationMs: event.totalDurationMs };
        finish();
        break;
      case 'cancelled':
        current.status = 'cancelled';
        finish();
        break;
      case 'error':
        fail(event.code, event.message);
        break;
    }
  }

  const unsubscribe = api.onEvent((event) => {
    if (phase.value === 'starting' && streamId === null) {
      early.push(event); // Our stream id is not known yet.
      return;
    }
    if (event.streamId === streamId) apply(event);
  });

  /** Turns that are sent as context: everything that produced text. */
  function history(): ChatTurn[] {
    return messages.value
      .filter((m) => m.content.trim() && (m.status === 'complete' || m.status === 'cancelled'))
      .map((m) => ({ role: m.role, content: m.content }));
  }

  async function send(): Promise<void> {
    if (!canSend.value) return;
    const text = draft.value.trim();
    const turns = [...history(), { role: 'user' as const, content: text }];

    push({ role: 'user', content: text, status: 'complete', error: null, stats: null });
    current = push({
      role: 'assistant',
      content: '',
      status: 'streaming',
      error: null,
      stats: null,
    });
    draft.value = '';
    phase.value = 'starting';

    let result: ChatStartResult;
    try {
      result = await api.start({ messages: turns });
    } catch (error) {
      fail('generation-failed', error instanceof Error ? error.message : String(error));
      return;
    }

    if (result.status === 'rejected') {
      fail(result.code, result.message);
      return;
    }

    streamId = result.streamId;
    phase.value = stopRequested ? 'stopping' : 'generating';
    const pending = early.filter((e) => e.streamId === streamId);
    early = [];
    pending.forEach(apply);

    // Replayed events may already have finished the stream (finish() clears streamId).
    const stillRunning = streamId === result.streamId;
    if (stillRunning && stopRequested) await api.stop(result.streamId).catch(() => undefined);
  }

  async function stop(): Promise<void> {
    if (phase.value === 'starting') {
      stopRequested = true; // Sent as soon as the stream id is known.
      return;
    }
    if (phase.value !== 'generating' || !streamId) return;
    phase.value = 'stopping';
    try {
      await api.stop(streamId);
    } catch {
      // The stream may have just finished; its final event resets the phase.
    }
  }

  async function clear(): Promise<void> {
    if (busy.value) await stop();
    messages.value = [];
    finish(); // Late events for the old stream are ignored.
  }

  function dispose(): void {
    if (streamId) void api.stop(streamId).catch(() => undefined);
    unsubscribe();
  }

  return { messages, draft, phase, busy, canSend, send, stop, clear, dispose };
}

export type ChatSession = ReturnType<typeof createChatSession>;
