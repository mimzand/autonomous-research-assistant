import {
  type ChatApi,
  type ChatConversationItem,
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Chat state for one window: the list of stored conversations, the open one's
 * transcript (the agent keeps both in SQLite), the current generation, and
 * stop/new/switch/delete. Every request carries the open conversation's id; the
 * agent decides what context the model gets. One reply at a time: switching,
 * creating and deleting are refused while a reply is streaming, so a reply's
 * bubbles stay on the conversation that started it. Talks only to the preload
 * `ChatApi`; never to Ollama.
 */
export function createChatSession(api: ChatApi, options: ChatSessionOptions) {
  /** Stored conversations, newest-updated first. */
  const conversations = ref<ChatConversationItem[]>([]);
  /** The open conversation; null shows the empty state (nothing open yet, or deleted). */
  const openId = ref<string | null>(null);
  /** The open conversation's bubbles. */
  const messages = ref<UiMessage[]>([]);
  const draft = ref('');
  const phase = ref<ChatPhase>('idle');
  /** The open conversation's transcript has been loaded (or failed to load). Send waits. */
  const loaded = ref(false);
  /** Why the last message could not be started, or why loading/switching/deleting failed. */
  const startError = ref<ChatErrorView | null>(null);
  /** The first list load (and opening the newest conversation) has settled. */
  const initialized = ref(false);
  /** Bumped when the open conversation changes: a load or start for an older one is ignored. */
  let epoch = 0;

  let nextId = 1;
  let streamId: string | null = null;
  let current: UiMessage | null = null;
  let stopRequested = false;
  /** Events that arrived while `start` was still resolving. */
  let early: ChatEvent[] = [];

  const busy = computed(() => phase.value !== 'idle');
  const canSend = computed(
    () => openId.value !== null && loaded.value && !busy.value && draft.value.trim().length > 0,
  );

  function push(message: Omit<UiMessage, 'id'>): UiMessage {
    messages.value.push({ id: nextId++, ...message });
    // Return the reactive proxy so later mutations update the view.
    return messages.value[messages.value.length - 1] as UiMessage;
  }

  function finish(): void {
    const ended = streamId !== null;
    phase.value = 'idle';
    streamId = null;
    current = null;
    stopRequested = false;
    early = [];
    // A finished reply changed its conversation's title or position in the list.
    if (ended) void refreshList();
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

  function showError(what: string, error: unknown): void {
    startError.value = describeChatError(
      'generation-failed',
      `${what}: ${message(error)}`,
      options.model(),
    );
  }

  /** Reloads the conversation list (errors are shown, the old list stays). */
  async function refreshList(): Promise<void> {
    try {
      conversations.value = (await api.list()).conversations;
    } catch (error) {
      showError('The conversation list could not be loaded', error);
    }
  }

  /** Shows the empty state: no conversation open. */
  function close(): void {
    epoch++;
    openId.value = null;
    messages.value = [];
    loaded.value = false;
  }

  /**
   * Opens a conversation and loads its transcript; Send is enabled when that
   * settles. Refused (false) while a reply is streaming.
   */
  async function open(conversationId: string): Promise<boolean> {
    if (busy.value) return false;
    const mine = ++epoch;
    openId.value = conversationId;
    messages.value = [];
    loaded.value = false;
    startError.value = null;
    try {
      const { messages: stored } = await api.history(conversationId);
      if (mine !== epoch) return true; // another one was opened meanwhile
      messages.value = [];
      stored.forEach((m) => push(fromStored(m)));
    } catch (error) {
      if (mine !== epoch) return true;
      showError('The saved conversation could not be loaded', error);
    } finally {
      if (mine === epoch) loaded.value = true;
    }
    return true;
  }

  /** Creates an empty conversation and opens it. Refused (false) while busy. */
  async function create(): Promise<boolean> {
    if (busy.value) return false;
    let conversationId: string;
    try {
      ({ conversationId } = await api.create());
    } catch (error) {
      showError('A new conversation could not be created', error);
      return false;
    }
    await refreshList();
    return open(conversationId);
  }

  /**
   * Deletes one conversation (agent first, then the list). If it was open, the
   * page shows the empty state. Refused (false) while a reply is streaming.
   */
  async function remove(conversationId: string): Promise<boolean> {
    if (busy.value) return false;
    try {
      await api.clear(conversationId);
    } catch (error) {
      showError('The conversation could not be deleted', error);
      return false;
    }
    if (openId.value === conversationId) {
      close();
      startError.value = null;
    }
    conversations.value = conversations.value.filter((c) => c.id !== conversationId);
    await refreshList();
    return true;
  }

  /**
   * The list, then the newest-updated conversation opened (an empty database
   * shows the empty state: nothing is created until the user asks).
   */
  const whenLoaded: Promise<void> = (async () => {
    try {
      await refreshList();
      const first = conversations.value[0];
      if (first) await open(first.id);
    } finally {
      initialized.value = true;
    }
  })();

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
    const conversationId = openId.value;
    if (!canSend.value || conversationId === null) return;
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
      // Only the new text: the agent adds this conversation's stored turns as context.
      result = await api.start({ conversationId, text });
    } catch (error) {
      if (sentIn !== epoch) return;
      const detail = error instanceof Error ? error.message : String(error);
      startFailed(user, assistant, text, 'generation-failed', detail);
      return;
    }

    if (sentIn !== epoch) {
      // The conversation changed while starting (not possible from the UI): stop it.
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

  /** Deletes the open conversation (see `remove`). */
  async function clear(): Promise<boolean> {
    return openId.value === null ? false : remove(openId.value);
  }

  function dispose(): void {
    if (streamId) void api.stop(streamId).catch(() => undefined);
    unsubscribe();
  }

  return {
    conversations,
    openId,
    messages,
    draft,
    phase,
    busy,
    canSend,
    initialized,
    loaded,
    startError,
    whenLoaded,
    send,
    stop,
    open,
    create,
    remove,
    clear,
    refreshList,
    dispose,
  };
}

export type ChatSession = ReturnType<typeof createChatSession>;
