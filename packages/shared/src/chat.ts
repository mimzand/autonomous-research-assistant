import { z } from 'zod';

/*
 * Chat playground contract between renderer (via preload) and main.
 * Main validates every request; the preload validates every event.
 *
 * The transcript is stored by the agent (SQLite, one conversation). The renderer
 * sends only the new user text; the agent builds what the model receives from its
 * own rows (the last turns, see agent-host chat-context.ts).
 */

export const CHAT_MAX_MESSAGES = 200;
export const CHAT_MAX_MESSAGE_CHARS = 32_000;

export const ChatTurnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(CHAT_MAX_MESSAGE_CHARS),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

/** The new user message only. The agent adds the earlier turns from the stored transcript. */
export const ChatStartRequestSchema = z.strictObject({
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

/** `chat.history`: the stored transcript (empty when there is none). */
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
  /** Sends the new user message; the agent adds the stored transcript as context. */
  start(request: ChatStartRequest): Promise<ChatStartResult>;
  stop(streamId: string): Promise<void>;
  /** The stored transcript, oldest first. */
  history(): Promise<ChatHistory>;
  /** Stops the active reply (if any) and deletes the stored transcript. */
  clear(): Promise<void>;
  /** Subscribes to chat events. Returns an unsubscribe function. */
  onEvent(listener: (event: ChatEvent) => void): () => void;
}
