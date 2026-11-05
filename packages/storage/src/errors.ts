export type StorageErrorCode =
  | 'not-found'
  | 'invalid-input'
  | 'invalid-transition'
  | 'step-already-completed'
  | 'conflict'
  | 'secret-rejected'
  | 'encryption-unavailable'
  | 'migration-failed';

/** The only error type repositories throw for expected failures. */
export class StorageError extends Error {
  override readonly name = 'StorageError';

  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}
