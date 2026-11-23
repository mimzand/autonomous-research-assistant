import { z } from 'zod';

/*
 * Chat playground contract between renderer (via preload) and main.
 * Main validates every request; the preload validates every event.
 *
 * The agent stores the conversations (SQLite). The renderer picks one by id and
 * sends only the new user text; the agent builds what the model receives from that
 * conversation's own rows (the last turns plus a summary of older ones, see
 * agent-host chat-context.ts). Nothing from one conversation reaches another.
 */

export const CHAT_MAX_MESSAGES = 200;
export const CHAT_MAX_MESSAGE_CHARS = 32_000;

export const ChatTurnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(CHAT_MAX_MESSAGE_CHARS),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

/** A conversation id, as `chat.create` / `chat.list` return it. */
export const ChatConversationIdSchema = z.string().min(1).max(100);

/** Requests that name one conversation (`chat.history`, `chat.clear`). */
export const ChatConversationRequestSchema = z.strictObject({
  conversationId: ChatConversationIdSchema,
});
export type ChatConversationRequest = z.infer<typeof ChatConversationRequestSchema>;

/** One row of the conversation list. No message bodies. */
export const ChatConversationItemSchema = z.strictObject({
  id: ChatConversationIdSchema,
  title: z.string().max(200),
  updatedAt: z.string(),
});
export type ChatConversationItem = z.infer<typeof ChatConversationItemSchema>;

/** Most conversations `chat.list` returns. */
export const CHAT_MAX_LISTED_CONVERSATIONS = 500;

/** `chat.list`: conversations, newest-updated first. */
export const ChatConversationListSchema = z.strictObject({
  conversations: z.array(ChatConversationItemSchema).max(CHAT_MAX_LISTED_CONVERSATIONS),
});
export type ChatConversationList = z.infer<typeof ChatConversationListSchema>;

/** `chat.create`: the new, empty conversation (titled `New chat`). */
export const ChatCreateResultSchema = z.strictObject({ conversationId: ChatConversationIdSchema });
export type ChatCreateResult = z.infer<typeof ChatCreateResultSchema>;

/**
 * The new user message for one conversation. The agent adds that conversation's
 * earlier turns from its stored transcript.
 */
export const ChatStartRequestSchema = z.strictObject({
  conversationId: ChatConversationIdSchema,
  text: z
    .string()
    .trim()
    .min(1, 'The message must not be empty.')
    .max(
      CHAT_MAX_MESSAGE_CHARS,
      `The message must be at most ${CHAT_MAX_MESSAGE_CHARS} characters.`,
    ),
});
export type ChatStartRequest = z.input<typeof ChatStartRequestSchema>;

/** Status of a stored Chat bubble. Error replies are kept so they can be shown again. */
export const ChatMessageStatusSchema = z.enum(['complete', 'cancelled', 'error']);
export type ChatMessageStatus = z.infer<typeof ChatMessageStatusSchema>;

/** One stored bubble, in order. Web-search steps are not stored. */
export const ChatHistoryMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  status: ChatMessageStatusSchema,
  /** Assistant replies that finished: the model and token counts. */
  model: z.string().nullable(),
  promptTokens: z.int().nonnegative().nullable(),
  completionTokens: z.int().nonnegative().nullable(),
});
export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessageSchema>;

/** `chat.history`: one conversation's stored transcript (empty for an unknown id). */
export const ChatHistorySchema = z.strictObject({
  messages: z.array(ChatHistoryMessageSchema).max(CHAT_MAX_MESSAGES),
});
export type ChatHistory = z.infer<typeof ChatHistorySchema>;

export const StreamIdSchema = z.uuid();

export const ChatErrorCodeSchema = z.enum([
  'unavailable',
  'model-not-found',
  'timeout',
  'invalid-request',
  'invalid-response',
  'unsupported',
  'generation-failed',
  'busy',
]);
export type ChatErrorCode = z.infer<typeof ChatErrorCodeSchema>;

export const ChatStartResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started'), streamId: StreamIdSchema, model: z.string() }),
  z.object({
    status: z.literal('rejected'),
    code: z.enum(['busy', 'invalid-request']),
    message: z.string(),
  }),
]);
export type ChatStartResult = z.infer<typeof ChatStartResultSchema>;

export const ChatStopRequestSchema = z.strictObject({ streamId: StreamIdSchema });
export type ChatStopRequest = z.infer<typeof ChatStopRequestSchema>;

/** Status of a model-initiated web search shown in the Chat timeline (Phase 8.2). */
export const CHAT_TOOL_STATUSES = [
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const ChatToolStatusSchema = z.enum(CHAT_TOOL_STATUSES);
export type ChatToolStatus = z.infer<typeof ChatToolStatusSchema>;

/** Why a tool call produced no result. Fixed codes: never raw error text. */
export const CHAT_TOOL_REASONS = [
  'not-allowed',
  'invalid-arguments',
  'limit-reached',
  'duplicate',
  'context-limit',
  'timeout',
  'unavailable',
  'invalid-result',
  'failed',
  'cancelled',
] as const;
export const ChatToolReasonSchema = z.enum(CHAT_TOOL_REASONS);
export type ChatToolReason = z.infer<typeof ChatToolReasonSchema>;

/** One web-search step of a reply. Several events per call (running, then the outcome). */
export const ChatToolEventSchema = z.strictObject({
  type: z.literal('tool'),
  streamId: StreamIdSchema,
  callId: z.string().min(1).max(256),
  /** Tool name, e.g. "web_search" (sanitised; unknown names become "invalid_tool"). */
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** The search query the model sent; null when its arguments were invalid. */
  query: z.string().max(400).nullable(),
  status: ChatToolStatusSchema,
  reason: ChatToolReasonSchema.nullable(),
  resultCount: z.int().min(0).max(10).nullable(),
});
export type ChatToolEvent = z.infer<typeof ChatToolEventSchema>;

export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), streamId: StreamIdSchema, content: z.string() }),
  z.object({
    type: z.literal('done'),
    streamId: StreamIdSchema,
    model: z.string(),
    finishReason: z.enum(['stop', 'length', 'other']),
    completionTokens: z.number().int().nonnegative().nullable(),
    totalDurationMs: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal('error'),
    streamId: StreamIdSchema,
    code: ChatErrorCodeSchema,
    message: z.string(),
  }),
  z.object({ type: z.literal('cancelled'), streamId: StreamIdSchema }),
  ChatToolEventSchema,
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

/** Chat surface exposed to the renderer as `window.api.chat`. */
export interface ChatApi {
  /** Conversations, newest-updated first. */
  list(): Promise<ChatConversationList>;
  /** A new empty conversation; returns its id. */
  create(): Promise<ChatCreateResult>;
  /** Sends the new user message to one conversation; the agent adds its stored turns. */
  start(request: ChatStartRequest): Promise<ChatStartResult>;
  stop(streamId: string): Promise<void>;
  /** One conversation's stored transcript, oldest first. */
  history(conversationId: string): Promise<ChatHistory>;
  /** Deletes one conversation (stopping its running reply, if any). */
  clear(conversationId: string): Promise<void>;
  /** Subscribes to chat events. Returns an unsubscribe function. */
  onEvent(listener: (event: ChatEvent) => void): () => void;
}
