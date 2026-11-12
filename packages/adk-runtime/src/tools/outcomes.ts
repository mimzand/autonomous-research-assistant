import { redactText } from '@rka/shared';
import { type Event } from '../adk.js';
import { type RegistryToolStatus } from './registry-tool.js';

/*
 * Authoritative tool outcomes for an ADK run.
 *
 * The model's text is never evidence that a tool ran, was approved or
 * succeeded. What happened is recorded by RegistryTool (which delegates to the
 * ToolRegistry) at the moment it happens, per tool call. At the application
 * boundary, `summarizeInvocation` turns those records plus the run's events into
 * one authoritative result and a deterministic, app-generated message. The
 * model's final text is passed on only when every requested tool really
 * completed; otherwise it is withheld (kept, redacted, for diagnostics only).
 * Nothing here reads or interprets the model's wording, so it works the same in
 * every language.
 */

export type ApprovalState = 'not_required' | 'required' | 'granted' | 'denied';

/** What happened to one tool call. */
export interface ToolOutcome {
  readonly invocationId: string;
  /** The model's function-call id (undefined only if ADK did not provide one). */
  readonly callId: string | undefined;
  readonly tool: string;
  /** The bridge status; `not_executed` when the call never reached the bridge. */
  readonly status: RegistryToolStatus | 'not_executed';
  readonly approval: ApprovalState | 'unknown';
  /** True once the tool's code was invoked (it may have had effects). */
  readonly executionStarted: boolean;
  /** True only when the tool finished and its output passed validation. */
  readonly succeeded: boolean;
  readonly reason?: string;
}

/** Collects outcomes per invocation. One tracker can serve many runs. */
export class ToolOutcomeTracker {
  private readonly byInvocation = new Map<string, ToolOutcome[]>();

  record(outcome: ToolOutcome): void {
    const list = this.byInvocation.get(outcome.invocationId) ?? [];
    list.push(Object.freeze({ ...outcome }));
    this.byInvocation.set(outcome.invocationId, list);
    if (this.byInvocation.size > 100)
      this.byInvocation.delete(this.byInvocation.keys().next().value as string);
  }

  /** The recorded outcomes of an invocation, in the order the calls finished. */
  get(invocationId: string): readonly ToolOutcome[] {
    return this.byInvocation.get(invocationId) ?? [];
  }

  /** Returns and forgets an invocation's outcomes. */
  take(invocationId: string): readonly ToolOutcome[] {
    const list = this.get(invocationId);
    this.byInvocation.delete(invocationId);
    return list;
  }
}

export type InvocationStatus =
  | 'completed'
  | 'approval_required'
  | 'approval_denied'
  | 'partially_completed'
  | 'failed'
  | 'cancelled'
  | 'limit_exceeded';

/** The authoritative result of one ADK run at the application boundary. */
export interface InvocationResult {
  readonly status: InvocationStatus;
  /** Deterministic, app-generated; never derived from the model's text. */
  readonly message: string;
  /** Every tool call of the run, individually (including ones that never ran). */
  readonly outcomes: readonly ToolOutcome[];
  /**
   * The model's final answer, only when `status` is `completed`: every
   * requested tool actually ran and succeeded and the run ended normally.
   * Even then it is the model's wording; `status` and `message` are the facts.
   */
  readonly modelText?: string;
  /** For logs and tests only (redacted). Never show it as the result. */
  readonly diagnostics: {
    readonly rawModelText?: string;
    readonly errorCodes: readonly string[];
  };
}

const ABORTED = 'INVOCATION_ABORTED';
const LIMIT_STATUSES = new Set<ToolOutcome['status']>(['limit_exceeded', 'duplicate_call']);

/**
 * Builds the authoritative result of a run from its events and the tracker.
 *
 * Precedence (first match wins):
 * 1. cancelled            – the run was aborted, or any call was cancelled.
 * 2. approval_denied      – any call was denied by the user.
 * 3. approval_required    – any call still needs approval.
 * 4. limit_exceeded       – any call was stopped by a call-budget or repeat limit.
 * 5. failed               – the model/adapter reported an error (e.g. an
 *                           undeclared tool or invalid structured output), the
 *                           run ended without a final answer, or tools were
 *                           requested and none succeeded.
 * 6. partially_completed  – some calls succeeded and some did not.
 * 7. completed            – every requested call succeeded (or no tool was
 *                           requested) and the model gave a final answer. With no
 *                           tool calls the message states that no tool was run, so a
 *                           model claiming an action it never requested is not
 *                           confirmed by the app.
 */
export function summarizeInvocation(
  events: readonly Event[],
  tracker: ToolOutcomeTracker,
): InvocationResult {
  const invocationId = events.find((e) => e.invocationId)?.invocationId ?? '';
  const recorded = tracker.get(invocationId);
  const errorCodes = events.flatMap((e) => (e.errorCode ? [e.errorCode] : []));

  // Every function call the model made, matched to what really happened.
  const requested = events.flatMap((e) =>
    e.partial
      ? []
      : (e.content?.parts ?? []).flatMap((p) => (p.functionCall ? [p.functionCall] : [])),
  );
  const outcomes: ToolOutcome[] = [...recorded];
  for (const call of requested) {
    if (!recorded.some((o) => o.callId !== undefined && o.callId === call.id)) {
      outcomes.push({
        invocationId,
        callId: call.id,
        tool: call.name ?? '(unknown)',
        status: 'not_executed',
        approval: 'unknown',
        executionStarted: false,
        succeeded: false,
        reason: 'The call never reached the tool.',
      });
    }
  }

  const rawModelText = finalModelText(events);
  const any = (test: (o: ToolOutcome) => boolean) => outcomes.some(test);
  const succeeded = outcomes.filter((o) => o.succeeded);
  const otherErrors = errorCodes.filter((c) => c !== ABORTED);

  let status: InvocationStatus;
  if (errorCodes.includes(ABORTED) || any((o) => o.status === 'cancelled')) status = 'cancelled';
  else if (any((o) => o.status === 'approval_denied')) status = 'approval_denied';
  else if (any((o) => o.status === 'approval_required')) status = 'approval_required';
  else if (any((o) => LIMIT_STATUSES.has(o.status))) status = 'limit_exceeded';
  else if (
    otherErrors.length > 0 ||
    rawModelText === undefined ||
    (outcomes.length > 0 && succeeded.length === 0)
  )
    status = 'failed';
  else if (succeeded.length < outcomes.length) status = 'partially_completed';
  else status = 'completed';

  return {
    status,
    message: describe(status, outcomes, otherErrors),
    outcomes,
    ...(status === 'completed' && rawModelText !== undefined && { modelText: rawModelText }),
    diagnostics: {
      ...(rawModelText !== undefined && { rawModelText: redactText(rawModelText) }),
      errorCodes,
    },
  };
}

/** Text of the last complete model response (thought parts excluded). */
function finalModelText(events: readonly Event[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.partial || event.errorCode) continue;
    const parts = event.content?.parts ?? [];
    if (event.content?.role !== 'model' || parts.some((p) => p.functionCall)) continue;
    const text = parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    if (text) return text;
  }
  return undefined;
}

const names = (outcomes: readonly ToolOutcome[]) =>
  [...new Set(outcomes.map((o) => `"${o.tool}"`))].join(', ');

function describe(
  status: InvocationStatus,
  outcomes: readonly ToolOutcome[],
  errors: readonly string[],
): string {
  const where = (test: (o: ToolOutcome) => boolean) => outcomes.filter(test);
  const ran = where((o) => o.succeeded);
  switch (status) {
    case 'cancelled':
      return 'The request was cancelled. No result is reported as completed.';
    case 'approval_denied':
      return `Not done: you declined ${names(where((o) => o.status === 'approval_denied'))}. It was not run.`;
    case 'approval_required':
      return `Not done: ${names(where((o) => o.status === 'approval_required'))} needs your approval and was not run.`;
    case 'limit_exceeded':
      return `Stopped: the tool-call limit for this request was reached. ${names(where((o) => LIMIT_STATUSES.has(o.status)))} was not run.`;
    case 'failed':
      if (errors.length > 0)
        return `The request failed (${errors.join(', ')}). No tool result is reported as completed.`;
      if (outcomes.length > 0)
        return `The request failed: ${names(outcomes)} did not complete successfully.`;
      return 'The request failed: no answer was produced.';
    case 'partially_completed':
      return `Partly done: ${names(ran)} completed; ${names(where((o) => !o.succeeded))} did not.`;
    case 'completed':
      return ran.length > 0
        ? `Done: ${names(ran)} completed successfully.`
        : 'Answered without running any tools.';
  }
}
