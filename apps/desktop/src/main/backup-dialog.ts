import { join } from 'node:path';
import { type SaveDialogOptions } from 'electron';

/** Default file name, e.g. research-backup-2026-11-04-1530.db */
export function backupFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `research-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.db`;
}

/**
 * Native Save dialog for database backups. Windows and macOS always ask
 * before replacing an existing file; `showOverwriteConfirmation` makes Linux
 * ask too. Nothing is ever overwritten without that explicit confirmation.
 */
export function backupDialogOptions(documentsDir: string, now: Date): SaveDialogOptions {
  return {
    title: 'Export database backup',
    buttonLabel: 'Save backup',
    defaultPath: join(documentsDir, backupFileName(now)),
    filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  };
}
