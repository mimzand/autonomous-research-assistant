/**
 * Removes secrets and personal details from text before it is written to a
 * log (the execution log in SQLite, or the main-process console).
 *
 * It is a best-effort filter for things that can end up in error messages
 * and URLs: credentials in URLs, secret-looking query parameters, bearer
 * tokens, `key=value` secrets, e-mail addresses and the user name in home
 * directory paths. It never throws and keeps the text otherwise readable.
 */

export const REDACTED = '[redacted]';

/** Query parameters that commonly carry secrets (broad: only applied to URL parameters). */
const QUERY_NAMES =
  'access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|signature|sig|x-amz-signature|x-amz-credential|session(?:id)?|jwt|code|credential';

/** Names of `name: value` pairs and JSON keys that hold secrets (narrow: "code" or "key" alone are normal words). */
const SECRET_NAMES =
  'access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|authorization|private[_-]?key|credentials?';

const RULES: readonly [RegExp, string][] = [
  // https://user:password@host -> https://[redacted]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`],
  // ?token=abc&x=1 -> ?token=[redacted]&x=1
  [new RegExp(`([?&#;](?:${QUERY_NAMES})=)[^&#\\s"'<>]+`, 'gi'), `$1${REDACTED}`],
  // Authorization: Bearer abc / Basic abc
  [/\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // password: hunter2, "api_key": "abc", secret=abc
  [
    new RegExp(
      `\\b((?:${SECRET_NAMES})["']?\\s*[:=]\\s*["']?)(?!\\[redacted\\]|(?:bearer|basic)\\s)[^\\s"',;&]{3,}`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
  // Well-known key formats (OpenAI/Anthropic/GitHub/Slack/AWS style) even without a name.
  [/\b(?:sk|pk|rk)-[a-z0-9_-]{16,}\b/gi, REDACTED],
  [/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abpr])_[a-z0-9_-]{16,}\b/gi, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // E-mail addresses.
  [/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[email]'],
  // C:\Users\name\... and /home/name/... /Users/name/...
  [/\b([a-z]:\\users\\)[^\\/\s"']+/gi, '$1[user]'],
  [/(^|[\s"'(=])(\/(?:home|Users)\/)[^/\s"']+/g, '$1$2[user]'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Redacts every string inside a JSON-like value (keys whose names look secret are blanked). */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 20) return value;
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactValue(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const secretKey = new RegExp(`^(?:${SECRET_NAMES})$`, 'i');
    // e.g. { password: 'x' } -> { password: '[redacted]' }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        secretKey.test(k) && v !== null && typeof v !== 'object'
          ? REDACTED
          : redactValue(v, depth + 1),
      ]),
    ) as T;
  }
  return value;
}
