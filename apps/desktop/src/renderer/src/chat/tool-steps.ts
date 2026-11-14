import { type ChatToolEvent, type ChatToolReason, type ChatToolStatus } from '@rka/shared';

/*
 * Web-search steps of a Chat reply (Phase 8.2): what the timeline shows when
 * the model searched the web. Built only from validated `tool` events; the
 * texts are fixed (never raw error messages).
 */

export interface UiToolStep {
  readonly callId: string;
  readonly name: string;
  readonly query: string | null;
  status: ChatToolStatus;
  reason: ChatToolReason | null;
  resultCount: number | null;
}

/** Adds a step or updates it (events for one call arrive as running → outcome). */
export function applyToolEvent(steps: UiToolStep[], event: ChatToolEvent): void {
  const existing = steps.find((s) => s.callId === event.callId);
  if (existing) {
    // A finished step never goes back to "running".
    if (existing.status !== 'running' && event.status === 'running') return;
    existing.status = event.status;
    existing.reason = event.reason;
    existing.resultCount = event.resultCount;
    return;
  }
  steps.push({
    callId: event.callId,
    name: event.name,
    query: event.query,
    status: event.status,
    reason: event.reason,
    resultCount: event.resultCount,
  });
}

/** When the reply ends without an outcome for a running step (stopped or failed). */
export function settleRunningSteps(steps: UiToolStep[], status: 'cancelled' | 'failed'): void {
  for (const step of steps) {
    if (step.status === 'running') {
      step.status = status;
      step.reason = status === 'cancelled' ? 'cancelled' : 'failed';
    }
  }
}

const REASON_TEXT: Readonly<Record<ChatToolReason, string>> = {
  'not-allowed': 'this tool is not available',
  'invalid-arguments': 'invalid search request',
  'limit-reached': 'search limit for this message reached',
  duplicate: 'same search already made',
  'context-limit': 'size limit for search results reached',
  timeout: 'took too long',
  unavailable: 'web search is unavailable',
  'invalid-result': 'invalid result from the search service',
  failed: 'the search failed',
  cancelled: 'stopped',
};

/** Short status text, e.g. "Searching…", "5 results", "Not run: same search already made". */
export function toolStepStatusText(step: UiToolStep): string {
  switch (step.status) {
    case 'running':
      return 'Searching…';
    case 'completed':
      return step.resultCount === 1 ? '1 result' : `${step.resultCount ?? 0} results`;
    case 'cancelled':
      return 'Stopped';
    case 'skipped':
      return `Not run: ${step.reason ? REASON_TEXT[step.reason] : 'refused'}`;
    case 'failed':
      return `Failed: ${step.reason ? REASON_TEXT[step.reason] : 'the search failed'}`;
  }
}

/** Label of the step: "Web search" for web_search, otherwise the (sanitised) tool name. */
export function toolStepLabel(step: Pick<UiToolStep, 'name'>): string {
  return step.name === 'web_search' ? 'Web search' : `Tool ${step.name}`;
}
