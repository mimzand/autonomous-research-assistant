import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface AppUrlOptions {
  /** electron-vite dev server URL (development only). */
  readonly devServerUrl: string | undefined;
  /** Absolute path of the packaged renderer's index.html (production). */
  readonly rendererIndexPath?: string;
}

/**
 * Returns true when a URL belongs to our own renderer: in production only the
 * packaged index.html file (any other file:// page is refused), in
 * development only the electron-vite dev server origin.
 *
 * The second argument may also be the dev server URL alone (older callers);
 * then any file:// URL is accepted in production.
 */
export function isAppUrl(url: string, options: AppUrlOptions | string | undefined): boolean {
  const { devServerUrl, rendererIndexPath } =
    typeof options === 'object' ? options : { devServerUrl: options, rendererIndexPath: undefined };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (devServerUrl) {
    try {
      return parsed.origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  if (parsed.protocol !== 'file:') return false;
  if (!rendererIndexPath) return true;
  try {
    return samePath(fileURLToPath(parsed), rendererIndexPath);
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, '/');
  // Windows paths are case-insensitive.
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/**
 * Links the app may hand to the system browser: plain http(s) URLs without
 * credentials. Everything else (file:, javascript:, custom protocols that
 * launch other programs, ms-settings:, ...) is refused.
 */
export function isSafeExternalUrl(url: string): boolean {
  if (url.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hostname !== ''
  );
}

/** Settings a user may put in settings.env. Nothing else (e.g. NODE_OPTIONS) is applied. */
export const ALLOWED_SETTING_PREFIXES = ['OLLAMA_', 'SEARXNG_', 'WEB_', 'RESEARCH_'] as const;

export const isAllowedSetting = (key: string): boolean =>
  ALLOWED_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix)) && /^[A-Z0-9_]+$/.test(key);
