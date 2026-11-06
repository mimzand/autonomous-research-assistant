import { describe, expect, it } from 'vitest';
import { DEV_PORT_CANDIDATES, parseDevPort, pickDevPort } from '../../electron.vite.config.js';

describe('development server port', () => {
  it('uses 5173 when it can be opened', async () => {
    await expect(pickDevPort(undefined, async () => null)).resolves.toBe(5173);
  });

  it('skips ports Windows has reserved (EACCES) or that are in use', async () => {
    const refused: Record<number, string> = { 5173: 'EACCES', 5273: 'EADDRINUSE' };
    await expect(pickDevPort(undefined, async (p) => refused[p] ?? null)).resolves.toBe(5373);
  });

  it('uses exactly RKA_DEV_PORT when set, and explains when it is refused', async () => {
    await expect(pickDevPort('5299', async () => null)).resolves.toBe(5299);
    await expect(pickDevPort('5299', async () => 'EACCES')).rejects.toThrow(
      /5299 \(EACCES\).*excludedportrange.*RKA_DEV_PORT/,
    );
  });

  it('reports every refused candidate', async () => {
    const error = await pickDevPort(undefined, async () => 'EACCES').catch((e: Error) => e);
    expect(String(error)).toContain(DEV_PORT_CANDIDATES.map((p) => `${p} (EACCES)`).join(', '));
  });

  it('validates RKA_DEV_PORT', () => {
    expect(parseDevPort(undefined)).toBeUndefined();
    expect(parseDevPort(' ')).toBeUndefined();
    expect(() => parseDevPort('abc')).toThrow(/RKA_DEV_PORT/);
    expect(() => parseDevPort('80')).toThrow(/1024/);
  });
});
