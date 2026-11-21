import { asc, desc, eq, max } from 'drizzle-orm';
import { CHAT_MAX_MESSAGES } from '@rka/shared';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { StorageError } from '../errors.js';
import {
  CONVERSATION_MESSAGE_STATUSES,
  CONVERSATION_ROLES,
  conversationMessages,
  conversations,
  type ConversationMessageRecord,
  type ConversationRecord,
} from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { parseInput } from '../validation.js';

/** Length of a conversation title: the first user message, trimmed. */
export const CONVERSATION_TITLE_CHARS = 80;
/** Sanity limit for one stored message (model replies are not bounded by the input limit). */
export const MAX_CONVERSATION_MESSAGE_CHARS = 1_000_000;

const AppendMessageSchema = z.strictObject({
  /** Omit to append to the current conversation (created by its first user message). */
  conversationId: z.string().min(1).max(100).optional(),
  role: z.enum(CONVERSATION_ROLES),
  content: z.string().max(MAX_CONVERSATION_MESSAGE_CHARS),
  status: z.enum(CONVERSATION_MESSAGE_STATUSES),
  model: z.string().min(1).max(200).nullable().optional(),
  promptTokens: z.int().nonnegative().nullable().optional(),
  completionTokens: z.int().nonnegative().nullable().optional(),
});
export type AppendConversationMessageInput = z.input<typeof AppendMessageSchema>;

export interface AppendedConversationMessage {
  readonly conversation: ConversationRecord;
  readonly message: ConversationMessageRecord;
}

/**
 * The Chat transcript: one conversation for the app, its messages in `seq` order.
 * Appending assigns `seq` in the same transaction as the insert; a conversation
 * holds at most CHAT_MAX_MESSAGES messages (older ones are never dropped to make room).
 */
export function createConversationRepository(db: Executor, ctx: StorageContext) {
  const find = (tx: Executor, id: string) =>
    tx.select().from(conversations).where(eq(conversations.id, id)).get();
  const latest = (tx: Executor) =>
    tx
      .select()
      .from(conversations)
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(1)
      .get();

  return {
    /** The app's conversation, or undefined when there is none (never used, or cleared). */
    current(): ConversationRecord | undefined {
      return latest(db);
    },

    get(id: string): ConversationRecord | undefined {
      return find(db, id);
    },

    /**
     * Appends one message. Without `conversationId` it goes to the current
     * conversation, which a user message creates when there is none. With an id
     * that no longer exists it fails with `not-found` (it was deleted).
     */
    append(input: AppendConversationMessageInput): AppendedConversationMessage {
      const data = parseInput(AppendMessageSchema, input, 'conversation message');
      return guarded('Append conversation message', () =>
        db.transaction((tx) => {
          const now = ctx.now();
          let conversation = data.conversationId ? find(tx, data.conversationId) : latest(tx);
          if (!conversation && data.conversationId) {
            throw new StorageError('not-found', 'The conversation no longer exists.');
          }
          if (!conversation) {
            const title = data.content.trim().slice(0, CONVERSATION_TITLE_CHARS);
            if (data.role !== 'user' || !title) {
              throw new StorageError(
                'invalid-input',
                'A conversation starts with a non-empty user message.',
              );
            }
            conversation = tx
              .insert(conversations)
              .values({ id: ctx.newId(), title, model: null, createdAt: now, updatedAt: now })
              .returning()
              .get();
          }
          const last = tx
            .select({ seq: max(conversationMessages.seq) })
            .from(conversationMessages)
            .where(eq(conversationMessages.conversationId, conversation.id))
            .get();
          const seq = (last?.seq ?? 0) + 1;
          if (seq > CHAT_MAX_MESSAGES) {
            throw new StorageError(
              'invalid-input',
              `The conversation already has ${CHAT_MAX_MESSAGES} messages. Clear it to continue.`,
            );
          }
          const message = tx
            .insert(conversationMessages)
            .values({
              id: ctx.newId(),
              conversationId: conversation.id,
              seq,
              role: data.role,
              content: data.content,
              status: data.status,
              model: data.model ?? null,
              promptTokens: data.promptTokens ?? null,
              completionTokens: data.completionTokens ?? null,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
          const updated = tx
            .update(conversations)
            .set({ updatedAt: now, ...(data.model && { model: data.model }) })
            .where(eq(conversations.id, conversation.id))
            .returning()
            .get();
          return { conversation: updated ?? conversation, message };
        }),
      );
    },

    /** Messages of a conversation in `seq` order (at most CHAT_MAX_MESSAGES). */
    listMessages(conversationId: string): ConversationMessageRecord[] {
      return db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(asc(conversationMessages.seq))
        .limit(CHAT_MAX_MESSAGES)
        .all();
    },

    /** Deletes a conversation and (cascade) its messages. Returns whether it existed. */
    delete(conversationId: string): boolean {
      return db.delete(conversations).where(eq(conversations.id, conversationId)).run().changes > 0;
    },
  };
}

export type ConversationRepository = ReturnType<typeof createConversationRepository>;
