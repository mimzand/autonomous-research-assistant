import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliUsageError, DEFAULT_DATA_DIR, parseCliArgs } from './cli.js';
import { connectAgent, readStateFile } from '@rka/agent-client';
import { runAgent, type RunningAgent } from './run.js';
import { type AgentBroadcast } from './server.js';
import { writeStateFile } from './state-file.js';
import { generateToken } from './token.js';

const dirs: string[] = [];
const agents: RunningAgent[] = [];
const statePath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-run-'));
  dirs.push(dir);
  return join(dir, 'agent-state.json');
};
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runAgent', () => {
  it('writes a state file a client can use, and removes it on stop', async () => {
    const stateFile = statePath();
    const agent = await runAgent({ port: 0, stateFile, agentVersion: '1.0.0' });
    agents.push(agent);

    const read = readStateFile(stateFile);
    if (read.status !== 'ok') throw new Error(`state file ${read.status}`);
    expect(read.state).toMatchObject({
      host: '127.0.0.1',
      port: agent.server.port,
      pid: process.pid,
    });

    const client = await connectAgent({ port: read.state.port, token: read.state.token });
    await expect(client.request('system.ping', {})).resolves.toHaveProperty('agentTime');
    client.close();

    await agent.stop();
    await agent.stop();
    expect(existsSync(stateFile)).toBe(false);
  });

  it('refuses to start while the state file belongs to a live process', async () => {
    const stateFile = statePath();
    writeStateFile(stateFile, {
      protocol: 'rka-agent',
      version: 1,
      host: '127.0.0.1',
      port: 1,
      token: generateToken(),
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    await expect(
      runAgent({ port: 0, stateFile, agentVersion: '1', isProcessAlive: (pid) => pid === 4242 }),
    ).rejects.toThrow(/pid 4242/);
  });

  it('replaces a stale state file left by a dead process', async () => {
    const stateFile = statePath();
    writeStateFile(stateFile, {
      protocol: 'rka-agent',
      version: 1,
      host: '127.0.0.1',
      port: 1,
      token: generateToken(),
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    const agent = await runAgent({
      port: 0,
      stateFile,
      agentVersion: '1',
      isProcessAlive: () => false,
    });
    agents.push(agent);
    expect(readStateFile(stateFile)).toMatchObject({
      status: 'ok',
      state: { pid: process.pid, port: agent.server.port },
    });
  });

  it('serves the opened services and closes them on stop', async () => {
    const stateFile = statePath();
    let closed = 0;
    const agent = await runAgent({
      port: 0,
      stateFile,
      agentVersion: '1',
      openServices: () => ({
        handlers: { 'reports.list': () => ({ items: [], total: 0 }) },
        close: () => void closed++,
      }),
    });
    agents.push(agent);
    const read = readStateFile(stateFile);
    if (read.status !== 'ok') throw new Error(`state file ${read.status}`);
    const client = await connectAgent({ port: read.state.port, token: read.state.token });
    await expect(client.request('reports.list', {})).resolves.toEqual({ items: [], total: 0 });
    client.close();

    await agent.stop();
    await agent.stop();
    expect(closed).toBe(1);
  });

  it('gives the services the server broadcast once it listens', async () => {
    const stateFile = statePath();
    let broadcast: AgentBroadcast | undefined;
    const agent = await runAgent({
      port: 0,
      stateFile,
      agentVersion: '1',
      openServices: () => ({
        handlers: {},
        attachEvents: (next) => void (broadcast = next),
        close: () => undefined,
      }),
    });
    agents.push(agent);
    expect(broadcast).toBe(agent.server.broadcast);
  });

  it('does not open the services while another live agent owns the state file', async () => {
    const stateFile = statePath();
    writeStateFile(stateFile, {
      protocol: 'rka-agent',
      version: 1,
      host: '127.0.0.1',
      port: 1,
      token: generateToken(),
      pid: 4242,
      startedAt: new Date().toISOString(),
    });
    let opened = false;
    await expect(
      runAgent({
        port: 0,
        stateFile,
        agentVersion: '1',
        isProcessAlive: () => true,
        openServices: () => {
          opened = true;
          return { handlers: {}, close: () => undefined };
        },
      }),
    ).rejects.toThrow(/pid 4242/);
    expect(opened).toBe(false);
  });
});

describe('parseCliArgs', () => {
  it('defaults to an ephemeral port and the dev data folder', () => {
    expect(parseCliArgs([])).toEqual({
      dataDir: resolve(DEFAULT_DATA_DIR),
      stateFile: join(resolve(DEFAULT_DATA_DIR), 'agent-state.json'),
      port: 0,
      help: false,
    });
  });

  it('derives the state file from --data-dir unless --state-file is given', () => {
    const dir = resolve('some-data');
    expect(parseCliArgs(['--data-dir', dir, '--port', '45000'])).toMatchObject({
      dataDir: dir,
      stateFile: join(dir, 'agent-state.json'),
      port: 45_000,
    });
    expect(parseCliArgs(['--data-dir', dir, '--state-file', 'x.json']).stateFile).toBe(
      resolve('x.json'),
    );
  });

  it.each([
    [['--port', '-1']],
    [['--port', '65536']],
    [['--port', '1.5']],
    [['--port', '']],
    [['--token', 'abc']],
    [['positional']],
    [['--data-dir', '   ']],
  ])('rejects %j', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
  });
});
