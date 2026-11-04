export const MODEL_ERROR_CODES = [
  /** The model server cannot be reached (not running, wrong address). */
  'unavailable',
  /** The requested model is not installed on the server. */
  'model-not-found',
  /** The request failed validation, locally or on the server. */
  'invalid-request',
  /** The server answered with something that does not match the expected shape. */
  'invalid-response',
  /** The request exceeded its deadline or stalled. */
  'timeout',
  /** The caller aborted the request. */
  'cancelled',
  /** The server returned an error status or an in-stream error. */
  'http-error',
  /** The model or server does not support the requested feature. */
  'unsupported',
] as const;

export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export interface ModelErrorOptions {
  readonly cause?: unknown;
  readonly status?: number;
}

/** The only error type a ModelProvider throws. Callers branch on `code`. */
export class ModelProviderError extends Error {
  override readonly name = 'ModelProviderError';
  readonly code: ModelErrorCode;
  readonly status: number | undefined;

  constructor(code: ModelErrorCode, message: string, options: ModelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status;
  }
}

export function isModelProviderError(value: unknown): value is ModelProviderError {
  return value instanceof ModelProviderError;
}

/** Node's fetch reports "fetch failed"; the useful detail (e.g. ECONNREFUSED) is in `cause`. */
export function describeRequestError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.cause !== undefined) {
    const { cause } = error;
    const code =
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return `${message} (${code})`;
  }
  return message;
}
