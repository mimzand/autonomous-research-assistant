import { type ChatMessageStatus, type ChatTurn } from '@rka/shared';

/*
 * What the model sees of the stored Chat transcript. The transcript (SQLite) keeps
 * every bubble; the model receives only the last CHAT_CONTEXT_TURNS qualifying
 * turns. When older ones exist, one short preface built here (never by a model)
 * says how many were left out and quotes the start of each omitted question. It
 * never contains omitted assistant text. The turn cap is the whole policy: it does
 * not look at num_ctx.
 */

/** Turns sent to the model, including the new user message. */
export const CHAT_CONTEXT_TURNS = 8;
/** Characters quoted from each omitted user message in the preface. */
export const PREFACE_QUESTION_CHARS = 80;

/** A stored bubble, as far as the context window needs it. */
export interface StoredChatTurn {
  readonly role: ChatTurn['role'];
  readonly content: string;
  readonly status: ChatMessageStatus;
}

export interface ChatContext {
  /** The last qualifying turns, oldest first; the new user message is the last one. */
  readonly turns: ChatTurn[];
  /** Present only when earlier qualifying turns were left out. */
  readonly preface?: string;
}

/**
 * Qualifying turns are those that produced text: non-empty, `complete` or
 * `cancelled` (error replies stay in the transcript, never in the context).
 * Input order is the transcript order (`seq`).
 */
export function chatContext(
  messages: readonly StoredChatTurn[],
  maxTurns: number = CHAT_CONTEXT_TURNS,
): ChatContext {
  const qualifying = messages
    .filter((m) => m.content.trim() && (m.status === 'complete' || m.status === 'cancelled'))
    .map(({ role, content }) => ({ role, content }));
  const keep = Math.max(1, maxTurns);
  if (qualifying.length <= keep) return { turns: qualifying };
  const omitted = qualifying.slice(0, qualifying.length - keep);
  return { turns: qualifying.slice(-keep), preface: contextPreface(omitted) };
}

/** The preface for omitted turns: their count and the start of each omitted question. */
export function contextPreface(omitted: readonly ChatTurn[]): string {
  const questions = omitted
    .filter((t) => t.role === 'user')
    // One line each: whitespace (newlines included) collapsed before clipping.
    .map((t) => t.content.replace(/\s+/g, ' ').trim().slice(0, PREFACE_QUESTION_CHARS));
  const list = questions.length ? questions.map((q) => `\n- ${q}`).join('') : ' none';
  return `Earlier turns omitted: ${omitted.length}. Omitted questions:${list}.`;
}
