import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestScope } from './scope.js';

describe('RequestScope', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refuses to start when the caller already cancelled', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => new RequestScope({ signal: controller.signal })).toThrow(
      expect.objectContaining({ code: 'cancelled' }),
    );
  });

  it('reports caller aborts as cancelled', () => {
    const controller = new AbortController();
    const scope = new RequestScope({ signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    expect(scope.signal.aborted).toBe(true);
    expect(scope.toError(new Error('AbortError'))).toMatchObject({ code: 'cancelled' });
  });

  it('reports the overall deadline as timeout', () => {
    const scope = new RequestScope({ timeoutMs: 1000 });
    vi.advanceTimersByTime(999);
    expect(scope.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.toError(undefined)).toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('1000 ms'),
    });
  });

  it('restarts the idle deadline on touch', () => {
    const scope = new RequestScope({ idleTimeoutMs: 500 });
    vi.advanceTimersByTime(400);
    scope.touch();
    vi.advanceTimersByTime(400);
    expect(scope.signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.toError(undefined)).toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('No data'),
    });
  });

  it('maps other failures to unavailable', () => {
    const scope = new RequestScope({});
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    });
    expect(scope.toError(error, 'Cannot reach Ollama')).toMatchObject({
      code: 'unavailable',
      message: 'Cannot reach Ollama: fetch failed (ECONNREFUSED)',
    });
  });

  it('release stops timers and does not count as cancel or timeout', () => {
    const scope = new RequestScope({ timeoutMs: 100 });
    scope.release();
    vi.advanceTimersByTime(1000);
    expect(scope.signal.aborted).toBe(true);
    expect(() => scope.throwIfAborted()).not.toThrow();
  });

  it('stops listening to the caller signal after release', () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    new RequestScope({ signal: controller.signal }).release();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
