import { AgentClientError, type AgentClientErrorCode } from '@rka/agent-client';
import { z } from 'zod';

/** Every error response: `{ "error": { "code", "message" } }`. */
export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export type ErrorStatus =
  400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 501 | 502 | 503 | 504;

/** An error the API answers with as is (status, code and a safe message). */
export class ApiError extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Agent and connection errors as HTTP statuses. The agent's own messages are kept
 * for client errors (they name schema paths, never values); for server-side failures
 * a fixed message is used so internals never leak.
 */
const STATUS: Record<AgentClientErrorCode, ErrorStatus> = {
  bad_request: 400,
  bad_frame: 502,
  unauthorized: 502,
  unsupported_version: 502,
  unknown_method: 501,
  not_implemented: 501,
  busy: 409,
  timeout: 504,
  cancelled: 409,
  shell_unavailable: 501,
  shutting_down: 503,
  internal: 502,
  not_running: 503,
  state_file_invalid: 503,
  connect_failed: 503,
  connection_closed: 503,
};

const AGENT_DOWN =
  'The agent service is not reachable. Start it (pnpm agent:dev or pnpm api:up) and check AGENT_STATE_FILE.';

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AgentClientError) {
    const status = STATUS[error.code];
    if (status === 503 && error.code !== 'shutting_down') {
      return new ApiError(503, 'agent_unavailable', AGENT_DOWN);
    }
    if (error.code === 'shell_unavailable') {
      return new ApiError(
        501,
        'needs_desktop_app',
        'This action needs the desktop app (a native dialog or the OS key store).',
      );
    }
    if (status === 400 || status === 409 || status === 501 || status === 504) {
      return new ApiError(status, error.code, error.message);
    }
    return new ApiError(status, error.code, 'The agent service could not complete the request.');
  }
  return new ApiError(500, 'internal', 'Internal error.');
}

export const errorBody = (error: ApiError): ErrorBody => ({
  error: { code: error.code, message: error.message },
});
