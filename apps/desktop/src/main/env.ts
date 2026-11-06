import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Applies variables from .env text without overriding values that are
 * already set: real environment variables always win.
 * Returns the keys that were applied.
 */
export function applyEnvText(
  text: string,
  target: NodeJS.ProcessEnv,
  allow: (key: string) => boolean = () => true,
): string[] {
  const parsed = parseEnv(text);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (allow(key) && target[key] === undefined && value !== undefined) {
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

/**
 * Packaged app: applies `settings.env` from the user data folder, if present.
 * Only allowed keys (OLLAMA_*, SEARXNG_*, WEB_*, RESEARCH_*) are applied, real
 * environment variables still win, and a file larger than 64 KB is ignored.
 * Returns the applied keys and the keys that were ignored.
 */
export function loadSettingsFile(
  path: string,
  target: NodeJS.ProcessEnv,
  allow: (key: string) => boolean,
): { applied: string[]; ignored: string[] } | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  if (text.length > 64 * 1024) throw new Error(`${path} is larger than 64 KB.`);
  const ignored = Object.keys(parseEnv(text)).filter((key) => !allow(key));
  return { applied: applyEnvText(text, target, allow), ignored };
}
