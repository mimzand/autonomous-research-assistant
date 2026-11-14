import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectFromStateFile } from './connect.js';
import { isProcessAlive, readStateFile } from './state-file.js';
import { pingHandler, startFakeAgent } from './test-fixtures.js';

const token = 'S3CRET_TOKEN_'.padEnd(43, 'x');
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-client-'));
  dirs.push(dir);
  const path = join(dir, 'agent-state.json');
  if (content !== undefined) {
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return path;
}

const state = (port: number, overrides: Record<string, unknown> = {}) => ({
  protocol: 'rka-agent',
  version: 1,
  host: '127.0.0.1',
  port,
  token,
  pid: process.pid,
  startedAt: '2026-11-14T12:00:00.000Z',
  ...overrides,
});

const expectNoToken = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(token);
  return error;
};

describe('connectFromStateFile', () => {
  it('connects through a valid state file and hides the token from the result', async () => {
    const server = await startFakeAgent(pingHandler);
    closers.push(server.close);
    const { client, state: info } = await connectFromStateFile(stateFile(state(server.port)));
    expect(info).toMatchObject({ host: '127.0.0.1', port: server.port, pid: process.pid });
    expect(info).not.toHaveProperty('token');
    await expect(client.request('system.ping', {})).resolves.toHaveProperty('agentTime');
    client.close();
  });

  it('reports a missing state file as not running', async () => {
    const path = stateFile(undefined);
    await expect(connectFromStateFile(path)).rejects.toMatchObject({
      code: 'not_running',
      message: expect.stringContaining(path) as unknown,
    });
  });

  it.each([
    ['not JSON', '{'],
    ['a non-loopback host', state(1, { host: '0.0.0.0' })],
    ['a LAN host', state(1, { host: '192.168.1.5' })],
    ['a weak token', state(1, { token: 'short' })],
    ['extra keys', state(1, { remote: true })],
  ])('refuses a state file with %s', async (_label, content) => {
    const error = await expectNoToken(connectFromStateFile(stateFile(content)));
    expect(error).toMatchObject({ code: 'state_file_invalid' });
  });

  it('reports a stale state file (dead pid) without connecting', async () => {
    const error = await expectNoToken(
      connectFromStateFile(stateFile(state(1, { pid: 4242 })), { isProcessAlive: () => false }),
    );
    expect(error).toMatchObject({
      code: 'not_running',
      message: expect.stringContaining('process 4242 is not running') as unknown,
    });
  });

  it('reports a live pid whose port refuses connections', async () => {
    const server = await startFakeAgent(pingHandler);
    const port = server.port;
    await server.close();
    const error = await expectNoToken(connectFromStateFile(stateFile(state(port))));
    expect(error).toMatchObject({ code: 'connect_failed' });
  });
});

describe('state file helpers', () => {
  it('reads only valid loopback state files', () => {
    expect(readStateFile(stateFile(state(5000)))).toMatchObject({ status: 'ok' });
    expect(readStateFile(stateFile(state(5000, { host: '::1' })))).toEqual({ status: 'invalid' });
    expect(readStateFile(stateFile('x'.repeat(70_000)))).toEqual({ status: 'invalid' });
  });

  it('detects the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
