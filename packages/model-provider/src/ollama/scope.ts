import { ModelProviderError, describeRequestError } from '../errors.js';

export interface ScopeOptions {
  readonly signal?: AbortSignal | undefined;
  /** Overall deadline. */
  readonly timeoutMs?: number | undefined;
  /** Deadline that restarts on every `touch()`. */
  readonly idleTimeoutMs?: number | undefined;
}

/**
 * One request's cancellation scope. Combines the caller's signal with
 * overall and idle deadlines, and remembers *why* it aborted so errors can
 * be reported as `cancelled` or `timeout` rather than a generic abort.
 */
export class RequestScope {
  private readonly controller = new AbortController();
  private reason: 'cancelled' | 'timeout' | 'released' | undefined;
  private timeoutMessage = '';
  private totalTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onParentAbort = (): void => this.abort('cancelled');

  constructor(private readonly options: ScopeOptions) {
    if (options.signal?.aborted) {
      throw new ModelProviderError('cancelled', 'Request was cancelled before it started.');
    }
    options.signal?.addEventListener('abort', this.onParentAbort, { once: true });

    if (options.timeoutMs !== undefined) {
      const ms = options.timeoutMs;
      this.totalTimer = setTimeout(() => {
        this.timeoutMessage = `Request timed out after ${ms} ms.`;
        this.abort('timeout');
      }, ms);
    }
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Restarts the idle deadline. Call whenever data arrives. */
  touch(): void {
    const ms = this.options.idleTimeoutMs;
    if (ms === undefined || this.reason) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.timeoutMessage = `No data from the model for ${ms} ms.`;
      this.abort('timeout');
    }, ms);
  }

  /** Stops timers and aborts any in-flight I/O (e.g. when a stream consumer stops early). */
  release(): void {
    this.clear();
    if (!this.controller.signal.aborted) this.abort('released');
  }

  /** Throws a typed error if the scope was cancelled or timed out. */
  throwIfAborted(): void {
    if (this.reason === 'cancelled' || this.reason === 'timeout') throw this.toError(undefined);
  }

  /** Converts any failure during the request into a ModelProviderError. */
  toError(
    cause: unknown,
    unavailableMessage = 'Cannot reach the model server',
  ): ModelProviderError {
    if (cause instanceof ModelProviderError) return cause;
    if (this.reason === 'cancelled') {
      return new ModelProviderError('cancelled', 'Request was cancelled.', { cause });
    }
    if (this.reason === 'timeout') {
      return new ModelProviderError('timeout', this.timeoutMessage, { cause });
    }
    return new ModelProviderError(
      'unavailable',
      `${unavailableMessage}: ${describeRequestError(cause)}`,
      { cause },
    );
  }

  private abort(reason: 'cancelled' | 'timeout' | 'released'): void {
    if (this.reason) return;
    this.reason = reason;
    this.clear();
    this.controller.abort();
  }

  private clear(): void {
    clearTimeout(this.totalTimer);
    clearTimeout(this.idleTimer);
    this.options.signal?.removeEventListener('abort', this.onParentAbort);
  }
}
