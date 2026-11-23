import { type ChatMessageStatus, type ChatTurn } from '@rka/shared';
import { wrapUntrusted } from '@rka/tools';

/*
 * What the model sees of one stored Chat conversation. The transcript (SQLite)
 * keeps every bubble; the model receives only the last CHAT_CONTEXT_TURNS
 * qualifying turns of that conversation, verbatim. Older qualifying turns are
 * represented by a preface:
 * - the conversation's stored summary (model-written, see chat-summary.ts), fenced
 *   as data, when there is one;
 * - otherwise a note built here (never by a model): how many turns were left out
 *   and the start of each omitted question. It never contains omitted assistant text.
 * The turn cap is the whole policy: it does not look at num_ctx.
 */

/** Turns sent to the model, including the new user message. */
export const CHAT_CONTEXT_TURNS = 8;
/** Characters quoted from each omitted user message in the fallback note. */
export const PREFACE_QUESTION_CHARS = 80;

/** A stored bubble, as far as the context window needs it. */
export interface StoredChatTurn {
  readonly seq: number;
  readonly role: ChatTurn['role'];
  readonly content: string;
  readonly status: ChatMessageStatus;
}

/** A turn that produced text, with its transcript position. */
export interface QualifyingTurn extends ChatTurn {
  readonly seq: number;
}

/** The split of one conversation's qualifying turns. */
export interface ChatWindow {
  /** The last qualifying turns, oldest first; sent verbatim. */
  readonly recent: QualifyingTurn[];
  /** Every earlier qualifying turn, oldest first; represented by the preface. */
  readonly omitted: QualifyingTurn[];
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
export function chatWindow(
  messages: readonly StoredChatTurn[],
  maxTurns: number = CHAT_CONTEXT_TURNS,
): ChatWindow {
  const qualifying = messages
    .filter((m) => m.content.trim() && (m.status === 'complete' || m.status === 'cancelled'))
    .map(({ seq, role, content }) => ({ seq, role, content }));
  const keep = Math.max(1, maxTurns);
  const cut = Math.max(0, qualifying.length - keep);
  return { recent: qualifying.slice(cut), omitted: qualifying.slice(0, cut) };
}

/**
 * Omitted turns not yet folded into the stored summary: those after the summary's
 * cursor (`summarized_through_seq`; null when nothing has been folded).
 */
export function newlyOmitted(
  omitted: readonly QualifyingTurn[],
  summarizedThroughSeq: number | null,
): QualifyingTurn[] {
  return omitted.filter((t) => summarizedThroughSeq === null || t.seq > summarizedThroughSeq);
}

/**
 * The model input for one conversation: the recent turns verbatim and, when older
 * turns were left out, the stored summary (if any) or else the fallback note.
 */
export function chatContext(
  messages: readonly StoredChatTurn[],
  options: { readonly summary?: string | null; readonly maxTurns?: number } = {},
): ChatContext {
  const { recent, omitted } = chatWindow(messages, options.maxTurns);
  const turns = recent.map(({ role, content }) => ({ role, content }));
  if (omitted.length === 0) return { turns };
  const preface = options.summary ? summaryPreface(options.summary) : contextPreface(omitted);
  return { turns, preface };
}

/** The fallback preface: the omitted count and the start of each omitted question. */
export function contextPreface(omitted: readonly ChatTurn[]): string {
  const questions = omitted
    .filter((t) => t.role === 'user')
    // One line each: whitespace (newlines included) collapsed before clipping.
    .map((t) => t.content.replace(/\s+/g, ' ').trim().slice(0, PREFACE_QUESTION_CHARS));
  const list = questions.length ? questions.map((q) => `\n- ${q}`).join('') : ' none';
  return `Earlier turns omitted: ${omitted.length}. Omitted questions:${list}.`;
}

/**
 * The stored summary as a preface: fenced as data (it was written by a model from
 * user and model text), then one line saying what it covers.
 */
export function summaryPreface(summary: string): string {
  return (
    `${wrapUntrusted(summary, { url: 'chat:summary' })}\n` +
    'The fenced text above is a summary of the earlier turns of this conversation; ' +
    'the messages that follow are the most recent turns.'
  );
}
