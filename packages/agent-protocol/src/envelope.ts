import { err, ok, type Result } from '@rka/shared';
import { z } from 'zod';
import {
  describeIssues,
  protocolError,
  ProtocolErrorSchema,
  type ProtocolError,
} from './errors.js';

/**
 * Framing (frozen in Phase 0): every frame is a 4-byte unsigned big-endian byte
 * length followed by exactly that many bytes of UTF-8 JSON holding one envelope.
 * A receiver closes the connection on a header larger than `MAX_FRAME_BYTES`.
 */
export const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const ENVELOPE_KINDS = ['req', 'res', 'event', 'error'] as const;
export const EnvelopeKindSchema = z.enum(ENVELOPE_KINDS);
export type EnvelopeKind = z.infer<typeof EnvelopeKindSchema>;

/**
 * Request ids are chosen by the sender and unique per connection and direction.
 * `res` / `error` echo the id of the request they answer; events carry their own id.
 */
export const MessageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** `namespace.name` in lower camel case, e.g. `tasks.startResearch`. */
export const MethodNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/);

/**
 * Method of an `error` envelope that answers no readable request (e.g. a frame that
 * is not JSON). Its id is fresh; the sender closes the connection afterwards.
 */
export const UNATTRIBUTED_ERROR_METHOD = 'system.error';

/**
 * The envelope layer checks shape only; `payload` is validated per method by the
 * registry (`parseRequest` / `parseResult` / `parseEvent`). Senders use `{}` for
 * "no params" and `null` for "no result".
 */
const envelopeFields = { id: MessageIdSchema, method: MethodNameSchema, payload: z.unknown() };

export const RequestEnvelopeSchema = z.strictObject({ ...envelopeFields, kind: z.literal('req') });
export const ResponseEnvelopeSchema = z.strictObject({ ...envelopeFields, kind: z.literal('res') });
export const EventEnvelopeSchema = z.strictObject({ ...envelopeFields, kind: z.literal('event') });
export const ErrorEnvelopeSchema = z.strictObject({
  ...envelopeFields,
  kind: z.literal('error'),
  payload: ProtocolErrorSchema,
});

export const EnvelopeSchema = z.discriminatedUnion('kind', [
  RequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  EventEnvelopeSchema,
  ErrorEnvelopeSchema,
]);
export type RequestEnvelope = z.infer<typeof RequestEnvelopeSchema>;
export type ResponseEnvelope = z.infer<typeof ResponseEnvelopeSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Parses one frame body (UTF-8 already decoded) into an envelope. */
export function decodeEnvelope(text: string): Result<Envelope, ProtocolError> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err(protocolError('bad_frame', 'Frame is not valid JSON.'));
  }
  const parsed = EnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return err(protocolError('bad_frame', `Invalid envelope at: ${describeIssues(parsed.error)}.`));
  }
  return ok(parsed.data);
}

/** Validates and serialises an envelope. Throws on an invalid envelope (a sender bug). */
export function encodeEnvelope(envelope: Envelope): string {
  return JSON.stringify(EnvelopeSchema.parse(envelope));
}
