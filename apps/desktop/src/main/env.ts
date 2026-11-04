import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Applies variables from .env text without overriding values that are
 * already set: real environment variables always win.
 * Returns the keys that were applied.
 */
export function applyEnvText(text: string, target: NodeJS.ProcessEnv): string[] {
  const parsed = parseEnv(text);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined && value !== undefined) {
      target[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

/** Loads the first .env file that exists. Development only - never call in packaged builds. */
export function loadDevEnvFile(
  candidates: readonly string[],
  target: NodeJS.ProcessEnv,
): string | undefined {
  const file = candidates.find((path) => existsSync(path));
  if (!file) return undefined;
  applyEnvText(readFileSync(file, 'utf8'), target);
  return file;
}
