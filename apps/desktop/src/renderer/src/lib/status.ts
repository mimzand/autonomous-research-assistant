import { type StepStatus, type TaskStatus } from '@rka/shared';

export type StatusTone = 'neutral' | 'info' | 'ok' | 'error' | 'warn' | 'accent';

export interface StatusMeta {
  readonly label: string;
  readonly tone: StatusTone;
  /** One-line explanation for tooltips. */
  readonly hint: string;
}

export const TASK_STATUS_META: Readonly<Record<TaskStatus, StatusMeta>> = {
  pending: { label: 'Pending', tone: 'neutral', hint: 'Created, not started yet.' },
  running: { label: 'Running', tone: 'info', hint: 'Executing right now.' },
  'awaiting-approval': {
    label: 'Awaiting approval',
    tone: 'accent',
    hint: 'Paused until you approve or reject an action.',
  },
  interrupted: {
    label: 'Interrupted',
    tone: 'warn',
    hint: 'The app stopped while this task was running.',
  },
  completed: { label: 'Completed', tone: 'ok', hint: 'Finished successfully.' },
  failed: { label: 'Failed', tone: 'error', hint: 'Stopped because of an error.' },
  cancelled: { label: 'Cancelled', tone: 'neutral', hint: 'Stopped by the user.' },
};

export const STEP_STATUS_META: Readonly<Record<StepStatus, StatusMeta>> = {
  pending: { label: 'Pending', tone: 'neutral', hint: 'Not started yet.' },
  running: { label: 'Running', tone: 'info', hint: 'Executing right now.' },
  completed: { label: 'Completed', tone: 'ok', hint: 'Done. Will never run again.' },
  failed: { label: 'Failed', tone: 'error', hint: 'Stopped because of an error.' },
  interrupted: { label: 'Interrupted', tone: 'warn', hint: 'Was running when the app stopped.' },
  skipped: { label: 'Skipped', tone: 'neutral', hint: 'Not needed.' },
};

/** Stat cards on the Tasks dashboard, in display order. */
export const TASK_STAT_CARDS: readonly { key: 'total' | TaskStatus; label: string }[] = [
  { key: 'total', label: 'Total' },
  { key: 'pending', label: 'Pending' },
  { key: 'running', label: 'Running' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'interrupted', label: 'Interrupted' },
];

/** Status filter chips. */
export const TASK_FILTERS: readonly { label: string; statuses: TaskStatus[] }[] = [
  { label: 'All', statuses: [] },
  { label: 'Pending', statuses: ['pending'] },
  { label: 'Running', statuses: ['running'] },
  { label: 'Completed', statuses: ['completed'] },
  { label: 'Failed', statuses: ['failed'] },
  { label: 'Interrupted', statuses: ['interrupted'] },
  { label: 'Other', statuses: ['awaiting-approval', 'cancelled'] },
];
