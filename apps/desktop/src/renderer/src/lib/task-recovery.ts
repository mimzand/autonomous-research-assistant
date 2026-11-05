import { type TaskRecoveryInfo } from '@rka/shared';

type Interruption = NonNullable<TaskRecoveryInfo['interruption']>;

export interface InterruptionView {
  readonly title: string;
  /** What happened, in plain words. The stored detail is shown separately. */
  readonly text: string;
  /** What the user should do before clicking Resume. */
  readonly action: string;
  readonly tone: 'info' | 'warn';
}

/** Explains why an interrupted task is waiting and what to do about it. */
export function describeInterruption(interruption: Interruption | null): InterruptionView {
  switch (interruption?.kind) {
    case 'paused':
      return {
        title: 'Paused',
        text: 'You paused this task. The step that was running will start again on resume.',
        action: 'Click Resume when you want to continue.',
        tone: 'info',
      };
    case 'app-closed':
      return {
        title: 'Interrupted — the app was closed',
        text: 'The app stopped while this task was running. It will not continue on its own.',
        action: 'Click Resume to continue.',
        tone: 'warn',
      };
    case 'model-unavailable':
      return {
        title: 'Waiting for Ollama',
        text: 'The local model could not be reached, so the task stopped instead of failing.',
        action: 'Start Ollama (and check that the model is installed), then click Resume.',
        tone: 'warn',
      };
    case 'search-unavailable':
      return {
        title: 'Waiting for SearXNG',
        text: 'The search service could not be reached, so the task stopped instead of failing.',
        action: 'Start SearXNG (check SEARXNG_URL), then click Resume.',
        tone: 'warn',
      };
    case 'offline':
      return {
        title: 'Waiting for the internet connection',
        text: 'Several sites could not be reached, which usually means the connection is down.',
        action:
          'Check the internet connection, then click Resume. Sources that failed because of the connection are tried again.',
        tone: 'warn',
      };
    default:
      return {
        title: 'Interrupted — waiting for you',
        text: 'This task stopped before it finished. It will not continue on its own.',
        action: 'Click Resume to continue.',
        tone: 'warn',
      };
  }
}

/** Removes the hint the main process appends, so it is not shown twice. */
export function interruptionDetail(interruption: Interruption | null): string | null {
  if (!interruption || interruption.kind === 'paused' || interruption.kind === 'app-closed') {
    return null;
  }
  return interruption.message.replace(/\s+(Start|Check) [^.]*, then click Resume\.$/, '').trim();
}
