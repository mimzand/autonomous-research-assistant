import { type AgentStateFile } from '@rka/agent-protocol';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isProcessAlive, readStateFile } from '@rka/agent-client';
import { removeStateFile, writeStateFile } from './state-file.js';
import { generateToken, tokensEqual } from './token.js';

const dirs: string[] = [];
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-test-'));
  dirs.push(dir);
  return join(dir, 'nested', 'agent-state.json');
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const state = (token = generateToken()): AgentStateFile => ({
  protocol: 'rka-agent',
  version: 1,
  host: '127.0.0.1',
  port: 50_000,
  token,
  pid: process.pid,
  startedAt: new Date().toISOString(),
});

describe('token', () => {
  it('generates distinct 43-character base64url tokens', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
  });

  it('compares tokens exactly', () => {
    const a = generateToken();
    expect(tokensEqual(a, a)).toBe(true);
    expect(tokensEqual(a, generateToken())).toBe(false);
    expect(tokensEqual(a, `${a}x`)).toBe(false);
    expect(tokensEqual('', a)).toBe(false);
  });
});

describe('state file', () => {
  it('writes (creating folders) and reads back', () => {
    const path = tempPath();
    const s = state();
    writeStateFile(path, s);
    expect(readStateFile(path)).toEqual({ status: 'ok', state: s });
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('refuses to write a non-loopback state', () => {
    expect(() =>
      writeStateFile(tempPath(), { ...state(), host: '0.0.0.0' as '127.0.0.1' }),
    ).toThrow();
  });

  it('reports missing and invalid files', () => {
    const path = tempPath();
    expect(readStateFile(path)).toEqual({ status: 'missing' });
    writeStateFile(path, state());
    writeFileSync(path, '{ not json');
    expect(readStateFile(path)).toEqual({ status: 'invalid' });
    writeFileSync(path, JSON.stringify({ ...state(), host: '0.0.0.0' }));
    expect(readStateFile(path)).toEqual({ status: 'invalid' });
  });

  it('removes the file only when it still holds our token', () => {
    const path = tempPath();
    const ours = generateToken();
    writeStateFile(path, state(generateToken()));
    expect(removeStateFile(path, ours)).toBe(false);
    expect(existsSync(path)).toBe(true);
    writeStateFile(path, state(ours));
    expect(removeStateFile(path, ours)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(removeStateFile(path, ours)).toBe(false);
  });

  it('refuses to store anything but the schema fields', () => {
    const path = tempPath();
    expect(() => writeStateFile(path, { ...state(), extra: 'x' } as AgentStateFile)).toThrow();
    expect(existsSync(path)).toBe(false);
    writeStateFile(path, state());
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object).sort()).toEqual([
      'host',
      'pid',
      'port',
      'protocol',
      'startedAt',
      'token',
      'version',
    ]);
  });

  it('detects live processes', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
