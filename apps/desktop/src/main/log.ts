import { redactText } from '@rka/shared';

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>;

const redactArg = (arg: unknown): unknown => {
  if (typeof arg === 'string') return redactText(arg);
  if (arg instanceof Error) {
    // Keep the type and a redacted message/stack; drop other (possibly sensitive) properties.
    const copy = new Error(redactText(arg.message));
    copy.name = arg.name;
    copy.stack = arg.stack === undefined ? undefined : redactText(arg.stack);
    return copy;
  }
  return arg;
};

/**
 * Makes every main-process console method redact secrets, e-mail addresses
 * and home-folder user names before anything is written (stdout is captured
 * in log files and bug reports). Idempotent.
 */
export function installConsoleRedaction(target: ConsoleLike = console): void {
  const marker = target as ConsoleLike & { __redacted?: true };
  if (marker.__redacted) return;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map(redactArg));
  }
  marker.__redacted = true;
}
