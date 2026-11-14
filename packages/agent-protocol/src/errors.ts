import { z } from 'zod';

/**
 * Error codes carried by `error` envelopes. Messages are short, fixed-shape text:
 * never echo payload values (they may hold tokens, secrets or user documents).
 */
export const PROTOCOL_ERROR_CODES = [
  /** Frame is not JSON, too large, or not a valid envelope. The connection is closed. */
  'bad_frame',
  /** Envelope is valid but its payload fails the method's schema. */
  'bad_request',
  /** No handshake yet, malformed hello, or wrong token. The connection is closed. */
  'unauthorized',
  /** The hello asked for a protocol version this side does not speak. */
  'unsupported_version',
  /** Method is not in the registry, or not callable in this direction. */
  'unknown_method',
  /** Method is in the registry but this build does not serve it yet. */
  'not_implemented',
  'busy',
  'timeout',
  'cancelled',
  /** A reverse (agent → shell) call could not be served: no shell connected or it went away. */
  'shell_unavailable',
  'shutting_down',
  'internal',
] as const;
export const ProtocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;

export const ProtocolErrorSchema = z.strictObject({
  code: ProtocolErrorCodeSchema,
  message: z.string().max(2000),
});
export type ProtocolError = z.infer<typeof ProtocolErrorSchema>;

export const protocolError = (code: ProtocolErrorCode, message: string): ProtocolError => ({
  code,
  message,
});

/** Issue paths only (never values), so validation errors cannot leak payload content. */
export function describeIssues(error: z.ZodError): string {
  const paths = error.issues.map((issue) => issue.path.map(String).join('.') || '(root)');
  return [...new Set(paths)].slice(0, 10).join(', ');
}
