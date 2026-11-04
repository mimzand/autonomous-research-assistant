import { z } from 'zod';

/*
 * Chat playground contract between renderer (via preload) and main.
 * Main validates every request; the preload validates every event.
 */

export const CHAT_MAX_MESSAGES = 200;
export const CHAT_MAX_MESSAGE_CHARS = 32_000;

export const ChatTurnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(CHAT_MAX_MESSAGE_CHARS),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const ChatStartRequestSchema = z
  .strictObject({
    messages: z.array(ChatTurnSchema).min(1).max(CHAT_MAX_MESSAGES),
  })
  .refine(
    ({ messages }) => {
      const last = messages.at(-1);
      return last?.role === 'user' && last.content.trim().length > 0;
    },
    { message: 'The last message must be a non-empty user message.', path: ['messages'] },
  );
export type ChatStartRequest = z.infer<typeof ChatStartRequestSchema>;

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
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

/** Chat surface exposed to the renderer as `window.api.chat`. */
export interface ChatApi {
  start(request: ChatStartRequest): Promise<ChatStartResult>;
  stop(streamId: string): Promise<void>;
  /** Subscribes to chat events. Returns an unsubscribe function. */
  onEvent(listener: (event: ChatEvent) => void): () => void;
}
