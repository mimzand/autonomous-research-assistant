/**
 * Architecture guard: the Vue renderer must never talk to Ollama (or any
 * network endpoint) directly. All model traffic goes through the main
 * process via the preload bridge.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererDir = join(import.meta.dirname, '..', 'renderer');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|vue|html)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('renderer isolation', () => {
  it('restricts network access with CSP connect-src self', () => {
    const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
    const directives = new Map(
      csp.split(';').map((d) => {
        const [name = '', ...values] = d.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(csp).not.toMatch(/11434|127\.0\.0\.1|localhost/);
  });

  it('has no direct network calls or Ollama addresses in renderer code', () => {
    const offenders = sourceFiles(rendererDir).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [
        /\bfetch\s*\(/,
        /XMLHttpRequest/,
        /new\s+WebSocket/,
        /EventSource/,
        /11434/,
        /\/api\/(chat|generate)/,
      ]
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${relative(rendererDir, file)}: ${pattern}`);
    });
    expect(offenders).toEqual([]);
  });
});
