import { INTERRUPTED_MESSAGE, type TaskRecord } from '@rka/storage';

/*
 * Failure classification for the research workflow. Every error ends in one
 * of these outcomes - nothing is dropped silently:
 *
 * | kind               | step          | task                     | user action        |
 * | ------------------ | ------------- | ------------------------ | ------------------ |
 * | model-unavailable  | interrupted   | interrupted (waiting)    | start Ollama, Resume |
 * | search-unavailable | interrupted   | interrupted (waiting)    | start SearXNG, Resume |
 * | offline            | interrupted   | interrupted (waiting)    | reconnect, Resume  |
 * | source             | failed        | continues                | (shown in report)  |
 * | fatal              | failed        | failed                   | Retry              |
 */

export type FailureKind =
  'model-unavailable' | 'search-unavailable' | 'offline' | 'source' | 'fatal';

export class StepFailure extends Error {
  override readonly name = 'StepFailure';
  constructor(
    readonly kind: FailureKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Steps whose failure only loses one source; the task continues without it. */
export const NON_FATAL_STEP_KINDS: ReadonlySet<string> = new Set(['fetch', 'evidence']);

/** Error stored on a failed step: "[code] message". */
export const formatStepError = (code: string, message: string) => `[${code}] ${message}`;
export function parseStepError(error: string | null): { code: string; message: string } {
  const match = /^\[([a-z0-9-]+)\] ([\s\S]*)$/.exec(error ?? '');
  return match?.[1] && match[2] !== undefined
    ? { code: match[1], message: match[2] }
    : { code: 'unknown', message: error ?? '' };
}

/** Failed source steps with these codes are re-queued automatically on Resume. */
export const TRANSIENT_SOURCE_CODES: ReadonlySet<string> = new Set([
  'network-error',
  'dns-failed',
  'timeout',
  'http-error-5xx',
]);

// --- Interruption reasons (stored in tasks.error) ---------------------------------------

export const PAUSED_MESSAGE = 'Paused by the user. Resume to continue from the current step.';

const WAITING_PREFIX: Record<'model-unavailable' | 'search-unavailable' | 'offline', string> = {
  'model-unavailable': 'Waiting for Ollama: ',
  'search-unavailable': 'Waiting for SearXNG: ',
  offline: 'Waiting for the internet connection: ',
};

export function waitingMessage(kind: keyof typeof WAITING_PREFIX, detail: string): string {
  const hint = {
    'model-unavailable': 'Start Ollama (or check OLLAMA_HOST), then click Resume.',
    'search-unavailable': 'Start SearXNG (check SEARXNG_URL), then click Resume.',
    offline: 'Check the internet connection, then click Resume.',
  }[kind];
  return `${WAITING_PREFIX[kind]}${detail.slice(0, 600)} ${hint}`;
}

export type InterruptionKind =
  'paused' | 'app-closed' | 'model-unavailable' | 'search-unavailable' | 'offline' | 'other';

/** Why an interrupted task is waiting, derived from its stored reason. */
export function interruptionOf(
  task: Pick<TaskRecord, 'status' | 'error'>,
): { kind: InterruptionKind; message: string } | null {
  if (task.status !== 'interrupted') return null;
  const message = task.error ?? '';
  if (message === PAUSED_MESSAGE) return { kind: 'paused', message };
  for (const [kind, prefix] of Object.entries(WAITING_PREFIX)) {
    if (message.startsWith(prefix)) return { kind: kind as InterruptionKind, message };
  }
  // Set by storage recovery at startup for tasks that were running when the app stopped.
  if (message === INTERRUPTED_MESSAGE) return { kind: 'app-closed', message };
  return { kind: 'other', message };
}

// --- Classification ----------------------------------------------------------------------

/** Model errors after all retries. */
export function classifyModelError(code: string, message: string): StepFailure {
  if (code === 'unavailable' || code === 'model-not-found') {
    return new StepFailure('model-unavailable', code, message);
  }
  if (code === 'invalid-response') {
    return new StepFailure(
      'fatal',
      'malformed-output',
      `The model's answer was not valid: ${message}`,
    );
  }
  return new StepFailure('fatal', code, message);
}

/** Search tool errors (SearXNG is local; its engines need the internet). */
export function classifySearchError(code: string, message: string): StepFailure | null {
  if (code === 'engines-unreachable') return new StepFailure('offline', code, message);
  if (['network-error', 'dns-failed', 'timeout'].includes(code)) {
    return new StepFailure('search-unavailable', code, message);
  }
  if (code === 'http-error' && /HTTP (403|5\d\d)/.test(message)) {
    return new StepFailure('search-unavailable', code, message);
  }
  return null; // Recorded with the query; the other queries still run.
}

/** Network-level fetch failures (as opposed to a page that refuses or does not exist). */
export const isNetworkLevel = (code: string) =>
  ['network-error', 'dns-failed', 'timeout'].includes(code);

/** Normalises a fetch error code so 5xx (retry later) differs from 4xx (permanent). */
export function sourceErrorCode(code: string, message: string): string {
  if (code === 'http-error')
    return /HTTP 5\d\d/.test(message) ? 'http-error-5xx' : 'http-error-4xx';
  return code;
}
