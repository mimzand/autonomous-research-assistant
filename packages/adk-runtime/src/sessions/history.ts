/**
 * Reading stored ADK history after a restart.
 *
 * A stored history is a record of what was said, not of what was done: tool
 * outcomes come only from the ToolOutcomeTracker of the process that ran the
 * tools (see `summarizeInvocation`), never from stored events.
 */
import { type Event } from '../adk.js';

/**
 * Invocations that never reached an end: no final model answer and no error
 * or abort event. Typically the process stopped mid-turn (crash, power loss)
 * after some of the turn's events were stored. Partial (streaming) events are
 * never stored, so an interrupted answer can only show up here, never as an
 * answer.
 */
export function findIncompleteInvocations(events: readonly Event[]): string[] {
  const order: string[] = [];
  const ended = new Set<string>();
  for (const event of events) {
    const id = event.invocationId;
    if (!id) continue;
    if (!order.includes(id)) order.push(id);
    if (isTerminal(event)) ended.add(id);
  }
  return order.filter((id) => !ended.has(id));
}

function isTerminal(event: Event): boolean {
  if (event.partial) return false;
  if (event.errorCode) return true;
  if (event.author === 'user') return false;
  const parts = event.content?.parts ?? [];
  if (parts.length === 0) return false;
  return !parts.some((p) => p.functionCall || p.functionResponse);
}
