import { and, asc, desc, eq, isNull, lt, max, or } from 'drizzle-orm';
import { CHAT_MAX_LISTED_CONVERSATIONS, CHAT_MAX_MESSAGES } from '@rka/shared';
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
/** Title of a conversation until its first user message. */
export const NEW_CONVERSATION_TITLE = 'New chat';
/** Most conversations `list()` returns (newest-updated first). */
export const CONVERSATION_LIST_LIMIT = CHAT_MAX_LISTED_CONVERSATIONS;
/** Longest stored summary of the turns outside the context window. */
export const CONVERSATION_SUMMARY_CHARS = 1500;
/** Sanity limit for one stored message (model replies are not bounded by the input limit). */
export const MAX_CONVERSATION_MESSAGE_CHARS = 1_000_000;

const ConversationIdSchema = z.string().min(1).max(100);

const AppendMessageSchema = z.strictObject({
  conversationId: ConversationIdSchema,
  role: z.enum(CONVERSATION_ROLES),
  content: z.string().max(MAX_CONVERSATION_MESSAGE_CHARS),
  status: z.enum(CONVERSATION_MESSAGE_STATUSES),
  model: z.string().min(1).max(200).nullable().optional(),
  promptTokens: z.int().nonnegative().nullable().optional(),
  completionTokens: z.int().nonnegative().nullable().optional(),
});
export type AppendConversationMessageInput = z.input<typeof AppendMessageSchema>;

const SetSummarySchema = z.strictObject({
  conversationId: ConversationIdSchema,
  summary: z.string().trim().min(1).max(CONVERSATION_SUMMARY_CHARS),
  throughSeq: z.int().min(1),
});
export type SetConversationSummaryInput = z.input<typeof SetSummarySchema>;

export interface AppendedConversationMessage {
  readonly conversation: ConversationRecord;
  readonly message: ConversationMessageRecord;
}

/**
 * Chat conversations and their transcripts. The caller (the renderer, through the
 * agent) always names the conversation: nothing here picks "the latest one".
 * Appending assigns `seq` in the same transaction as the insert; a conversation
 * holds at most CHAT_MAX_MESSAGES messages (older ones are never dropped to make room).
 */
export function createConversationRepository(db: Executor, ctx: StorageContext) {
  const find = (tx: Executor, id: string) =>
    tx.select().from(conversations).where(eq(conversations.id, id)).get();

  return {
    /** A new empty conversation titled `New chat`. */
    create(): ConversationRecord {
      const now = ctx.now();
      return guarded('Create conversation', () =>
        db
          .insert(conversations)
          .values({
            id: ctx.newId(),
            title: NEW_CONVERSATION_TITLE,
            model: null,
            summary: null,
            summarizedThroughSeq: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get(),
      );
    },

    /** Conversations, newest-updated first (at most CONVERSATION_LIST_LIMIT). */
    list(): ConversationRecord[] {
      return db
        .select()
        .from(conversations)
        .orderBy(
          desc(conversations.updatedAt),
          desc(conversations.createdAt),
          desc(conversations.id),
        )
        .limit(CONVERSATION_LIST_LIMIT)
        .all();
    },

    get(id: string): ConversationRecord | undefined {
      return find(db, id);
    },

    /**
     * Appends one message to an existing conversation (`not-found` when it does not
     * exist, e.g. it was deleted). The first non-empty user message becomes the title;
     * later messages leave the title alone.
     */
    append(input: AppendConversationMessageInput): AppendedConversationMessage {
      const data = parseInput(AppendMessageSchema, input, 'conversation message');
      return guarded('Append conversation message', () =>
        db.transaction((tx) => {
          const now = ctx.now();
          const conversation = find(tx, data.conversationId);
          if (!conversation) {
            throw new StorageError('not-found', 'The conversation no longer exists.');
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
          const title = data.content.trim().slice(0, CONVERSATION_TITLE_CHARS);
          // The first non-empty user message names the conversation (trimmed as in JS).
          const firstUserMessage =
            data.role === 'user' &&
            title.length > 0 &&
            !tx
              .select({ content: conversationMessages.content })
              .from(conversationMessages)
              .where(
                and(
                  eq(conversationMessages.conversationId, conversation.id),
                  eq(conversationMessages.role, 'user'),
                ),
              )
              .all()
              .some((m) => m.content.trim().length > 0);
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
            .set({
              updatedAt: now,
              ...(data.model && { model: data.model }),
              ...(firstUserMessage && { title }),
            })
            .where(eq(conversations.id, conversation.id))
            .returning()
            .get();
          return { conversation: updated ?? conversation, message };
        }),
      );
    },

    /**
     * Stores the rolling summary and how far it reaches. The cursor only moves
     * forward: a write with a `throughSeq` at or below the stored one (or for a
     * conversation that no longer exists) changes nothing and returns false.
     * Does not touch `updatedAt` (the list order follows messages, not summaries).
     */
    setSummary(input: SetConversationSummaryInput): boolean {
      const data = parseInput(SetSummarySchema, input, 'conversation summary');
      return guarded(
        'Store conversation summary',
        () =>
          db
            .update(conversations)
            .set({ summary: data.summary, summarizedThroughSeq: data.throughSeq })
            .where(
              and(
                eq(conversations.id, data.conversationId),
                or(
                  isNull(conversations.summarizedThroughSeq),
                  lt(conversations.summarizedThroughSeq, data.throughSeq),
                ),
              ),
            )
            .run().changes > 0,
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
