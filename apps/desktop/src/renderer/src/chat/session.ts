import {
  type ChatApi,
  type ChatErrorCode,
  type ChatEvent,
  type ChatHistoryMessage,
  type ChatStartResult,
} from '@rka/shared';
import { computed, ref } from 'vue';
import { describeChatError, type ChatErrorView } from './errors';
import { applyToolEvent, settleRunningSteps, type UiToolStep } from './tool-steps';

export type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';

export interface UiMessage {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  error: ChatErrorView | null;
  stats: { tokens: number | null; durationMs: number | null } | null;
  /** Web searches the model made for this reply (Legacy Chat with web search). */
  tools: UiToolStep[];
}

/** idle → starting → generating → (stopping) → idle */
export type ChatPhase = 'idle' | 'starting' | 'generating' | 'stopping';

export interface ChatSessionOptions {
  /** Model name to show before the first reply (from the health check). */
  readonly model: () => string;
  /** Called after errors that may mean the model status changed. */
  readonly onConnectionProblem?: () => void;
}

/** A stored error reply after a restart: the original error details are not kept. */
const STORED_ERROR: ChatErrorView = {
  code: 'generation-failed',
  title: 'This reply failed',
  hint: 'Send your message again to retry.',
  detail: '',
};

/**
 * Chat state for one window: the stored transcript (loaded from the agent, which
 * keeps it in SQLite), the current generation, and cancel/clear. Sends only the new
 * text; the agent decides what context the model gets. Talks only to the preload
 * `ChatApi`; never to Ollama.
 */
export function createChatSession(api: ChatApi, options: ChatSessionOptions) {
  const messages = ref<UiMessage[]>([]);
  const draft = ref('');
  const phase = ref<ChatPhase>('idle');
  /** The stored transcript has been loaded (or failed to load). Send waits for it. */
  const loaded = ref(false);
  /** Why the last message could not be started, or why loading/clearing failed. */
  const startError = ref<ChatErrorView | null>(null);
  /** Bumped by Clear: a start that resolves after it is ignored. */
  let epoch = 0;

  let nextId = 1;
  let streamId: string | null = null;
  let current: UiMessage | null = null;
  let stopRequested = false;
  /** Events that arrived while `start` was still resolving. */
  let early: ChatEvent[] = [];

  const busy = computed(() => phase.value !== 'idle');
  const canSend = computed(() => loaded.value && !busy.value && draft.value.trim().length > 0);

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
      settleRunningSteps(current.tools, 'failed');
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
        settleRunningSteps(current.tools, 'cancelled');
        current.status = 'cancelled';
        finish();
        break;
      case 'tool':
        applyToolEvent(current.tools, event);
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

  /** A stored bubble as shown (tool steps are not stored). */
  function fromStored(m: ChatHistoryMessage): Omit<UiMessage, 'id'> {
    return {
      role: m.role,
      content: m.content,
      status: m.status,
      error: m.status === 'error' ? STORED_ERROR : null,
      stats:
        m.role === 'assistant' && m.status === 'complete' && m.completionTokens !== null
          ? { tokens: m.completionTokens, durationMs: null }
          : null,
      tools: [],
    };
  }

  /** Loads the stored transcript once; Send is enabled when this settles. */
  const whenLoaded: Promise<void> = api
    .history()
    .then(
      ({ messages: stored }) => {
        // Bubbles sent meanwhile cannot exist (Send waits), so this is the whole list.
        messages.value = [];
        stored.forEach((m) => push(fromStored(m)));
      },
      (error: unknown) => {
        startError.value = describeChatError(
          'generation-failed',
          `The saved conversation could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          options.model(),
        );
      },
    )
    .finally(() => {
      loaded.value = true;
    });

  /** A start that failed: its optimistic bubbles go, the text goes back to the draft. */
  function startFailed(
    user: UiMessage,
    assistant: UiMessage,
    text: string,
    code: ChatErrorCode,
    detail: string,
  ): void {
    messages.value = messages.value.filter((m) => m.id !== user.id && m.id !== assistant.id);
    if (!draft.value.trim()) draft.value = text;
    startError.value = describeChatError(code, detail, options.model());
    if (code === 'unavailable' || code === 'model-not-found') options.onConnectionProblem?.();
    finish();
  }

  async function send(): Promise<void> {
    if (!canSend.value) return;
    const text = draft.value.trim();
    const sentIn = epoch;
    startError.value = null;

    const user = push({
      role: 'user',
      content: text,
      status: 'complete',
      error: null,
      stats: null,
      tools: [],
    });
    const assistant = push({
      role: 'assistant',
      content: '',
      status: 'streaming',
      error: null,
      stats: null,
      tools: [],
    });
    current = assistant;
    draft.value = '';
    phase.value = 'starting';

    let result: ChatStartResult;
    try {
      // Only the new text: the agent adds the stored conversation as context.
      result = await api.start({ text });
    } catch (error) {
      if (sentIn !== epoch) return;
      const detail = error instanceof Error ? error.message : String(error);
      startFailed(user, assistant, text, 'generation-failed', detail);
      return;
    }

    if (sentIn !== epoch) {
      // Cleared while starting: the reply belongs to a deleted conversation.
      if (result.status === 'started') await api.stop(result.streamId).catch(() => undefined);
      return;
    }
    if (result.status === 'rejected') {
      startFailed(user, assistant, text, result.code, result.message);
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

  /** Deletes the stored transcript (the agent also stops a running reply), then the list. */
  async function clear(): Promise<void> {
    try {
      await api.clear();
    } catch (error) {
      startError.value = describeChatError(
        'generation-failed',
        `The conversation could not be cleared: ${error instanceof Error ? error.message : String(error)}`,
        options.model(),
      );
      return;
    }
    epoch++;
    messages.value = [];
    startError.value = null;
    finish(); // Late events for the old stream are ignored.
  }

  function dispose(): void {
    if (streamId) void api.stop(streamId).catch(() => undefined);
    unsubscribe();
  }

  return {
    messages,
    draft,
    phase,
    busy,
    canSend,
    loaded,
    startError,
    whenLoaded,
    send,
    stop,
    clear,
    dispose,
  };
}

export type ChatSession = ReturnType<typeof createChatSession>;
