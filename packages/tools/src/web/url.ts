import { err, ok, type Result } from '@rka/shared';
import { checkHostname } from './ip-policy.js';

export const MAX_URL_LENGTH = 2048;

export type UrlRejection =
  | 'invalid-url'
  | 'too-long'
  | 'unsupported-protocol'
  | 'credentials-not-allowed'
  | 'blocked-host'
  | 'blocked-port';

export interface UrlError {
  readonly code: UrlRejection;
  readonly message: string;
}

/** Ports a web page may be served from. Everything else is usually an internal service. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Validates a URL the agent (or a web page, via a redirect or search result)
 * wants to fetch. Only http(s) to public host names or public IP literals is
 * accepted. DNS answers are validated again at connection time.
 *
 * The WHATWG parser normalises tricks such as `http://2130706433/`,
 * `http://0x7f.1/` or `http://127.1/` to `127.0.0.1` before the host check.
 */
export function parsePublicUrl(raw: string, base?: string | URL): Result<URL, UrlError> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return err({ code: 'invalid-url', message: 'URL is empty.' });
  }
  if (raw.length > MAX_URL_LENGTH) {
    return err({ code: 'too-long', message: `URL is longer than ${MAX_URL_LENGTH} characters.` });
  }
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return err({ code: 'invalid-url', message: 'Not a valid URL.' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return err({
      code: 'unsupported-protocol',
      message: `Only http and https URLs can be fetched (got "${url.protocol}").`,
    });
  }
  if (url.username || url.password) {
    return err({
      code: 'credentials-not-allowed',
      message: 'URLs with embedded credentials are not allowed.',
    });
  }
  const host = checkHostname(url.hostname);
  if (!host.allowed) {
    return err({ code: 'blocked-host', message: `Blocked host: ${host.reason}.` });
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return err({ code: 'blocked-port', message: `Port ${url.port} is not allowed.` });
  }
  if (url.href.length > MAX_URL_LENGTH) {
    return err({ code: 'too-long', message: `URL is longer than ${MAX_URL_LENGTH} characters.` });
  }
  return ok(url);
}

/** Query parameters that only track clicks and never change the page. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'ref_src',
  'spm',
]);
const isTracking = (key: string) =>
  TRACKING_PARAMS.has(key.toLowerCase()) || /^(utm|pk|mtm|hsa)_/i.test(key);

/**
 * Canonical form used to detect duplicate sources:
 * - lower-case scheme and host, default port removed, trailing dot removed (WHATWG + below)
 * - fragment removed
 * - tracking parameters removed, remaining parameters sorted by name (stable)
 * - empty query removed
 *
 * The path is kept as-is: `/a` and `/a/` can be different pages.
 */
export function canonicalizeUrl(input: string | URL): string {
  const url = new URL(typeof input === 'string' ? input : input.href);
  url.hash = '';
  url.hostname = url.hostname.replace(/\.$/, '');
  const kept = [...url.searchParams.entries()].filter(([key]) => !isTracking(key));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.href;
}
