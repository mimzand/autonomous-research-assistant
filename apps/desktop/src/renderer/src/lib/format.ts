/** Display helpers. Pure functions (no DOM), unit-tested. */

const dateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

const compactDateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Short form for dense tables, e.g. "Nov 4, 21:05" (no year or seconds). */
export function formatCompactDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : compactDateTime.format(date);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a date. */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDateTime(iso);
}

/** Duration between two timestamps, e.g. "1.4 s", "2 min 5 s". */
export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** Pretty JSON for display; `truncateAt` keeps huge values responsive. */
export function prettyJson(
  value: unknown,
  truncateAt?: number,
): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null');
  if (truncateAt !== undefined && text.length > truncateAt) {
    return { text: `${text.slice(0, truncateAt)}\n…`, truncated: true };
  }
  return { text, truncated: false };
}

export function shortHash(hash: string | null | undefined, length = 12): string {
  return hash ? hash.slice(0, length) : '—';
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
