import { describe, expect, it } from 'vitest';
import { redactText, redactValue } from './redact.js';

describe('redactText', () => {
  it.each([
    ['https://alice:hunter2@example.com/x', 'https://[redacted]@example.com/x'],
    [
      'GET https://api.example.com/v1?q=heat&api_key=abc123&page=2',
      'GET https://api.example.com/v1?q=heat&api_key=[redacted]&page=2',
    ],
    ['https://example.com/cb?code=4/0AY&state=1', 'https://example.com/cb?code=[redacted]&state=1'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'Authorization: Bearer [redacted]'],
    ['password=hunter2 user=bob', 'password=[redacted] user=bob'],
    ['{"api_key": "abcdef"}', '{"api_key": "[redacted]"}'],
    ['key sk-abcdefghijklmnopqrstuv used', 'key [redacted] used'],
    ['token ghp_abcdefghijklmnopqrstuvwx', 'token [redacted]'],
    ['contact morteza@example.com now', 'contact [email] now'],
    [
      'ENOENT: C:\\Users\\zandm\\AppData\\Roaming\\x.db',
      'ENOENT: C:\\Users\\[user]\\AppData\\Roaming\\x.db',
    ],
    ['open /home/alice/.config/app', 'open /home/[user]/.config/app'],
  ])('%s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('keeps ordinary diagnostics readable', () => {
    for (const text of [
      'HTTP status code: 503',
      'Model call failed (timeout): no answer within 300 s',
      'fetch_source failed (http-error-4xx): HTTP 404',
      'prompt tokens: 120, completion tokens: 40',
      'https://example.com/heat-pumps?page=2&lang=en',
      'Waiting for Ollama: connect ECONNREFUSED 127.0.0.1:11434',
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });
});

describe('redactValue', () => {
  it('redacts nested strings and secret-named keys, keeps normal keys', () => {
    expect(
      redactValue({
        url: 'https://u:p@x.example/?token=t',
        code: 'http-error',
        key: 'plan',
        nested: [{ password: 'x', attempts: 2 }],
      }),
    ).toEqual({
      url: 'https://[redacted]@x.example/?token=[redacted]',
      code: 'http-error',
      key: 'plan',
      nested: [{ password: '[redacted]', attempts: 2 }],
    });
  });
});
