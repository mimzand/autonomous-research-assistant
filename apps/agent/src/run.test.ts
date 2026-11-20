import { PROTOCOL_VERSION } from '@rka/agent-protocol';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliUsageError, DEFAULT_DATA_DIR, parseCliArgs } from './cli.js';
import { connectAgent, readStateFile } from '@rka/agent-client';
import { runAgent, type RunningAgent } from './run.js';
import { type AgentServerLink } from './server.js';
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
      version: PROTOCOL_VERSION,
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
      version: PROTOCOL_VERSION,
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

  it('gives the services the server once it listens', async () => {
    const stateFile = statePath();
    let attached: AgentServerLink | undefined;
    const agent = await runAgent({
      port: 0,
      stateFile,
      agentVersion: '1',
      openServices: () => ({
        handlers: {},
        attachServer: (server) => void (attached = server),
        close: () => undefined,
      }),
    });
    agents.push(agent);
    expect(attached).toBe(agent.server);
  });

  it('does not open the services while another live agent owns the state file', async () => {
    const stateFile = statePath();
    writeStateFile(stateFile, {
      protocol: 'rka-agent',
      version: PROTOCOL_VERSION,
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

describe('system.shutdown (Phase 8)', () => {
  async function started(onShutdown?: () => void) {
    const stateFile = statePath();
    let closed = 0;
    const agent = await runAgent({
      port: 0,
      stateFile,
      agentVersion: '1.0.0',
      openServices: () => ({ handlers: {}, close: () => void closed++ }),
      ...(onShutdown && { onShutdown }),
    });
    agents.push(agent);
    const read = readStateFile(stateFile);
    if (read.status !== 'ok') throw new Error(`state file ${read.status}`);
    const as = (kind: 'shell' | 'cli') =>
      connectAgent({
        port: read.state.port,
        token: read.state.token,
        client: { kind, version: '1.0.0' },
      });
    return { stateFile, as, closed: () => closed };
  }

  it('stops the agent for the desktop shell: services closed, state file removed', async () => {
    let shutdown!: () => void;
    const done = new Promise<void>((resolve) => (shutdown = resolve));
    const t = await started(() => shutdown());
    const shell = await t.as('shell');
    await expect(shell.request('system.shutdown', {})).resolves.toBeNull();
    await done;
    expect(t.closed()).toBe(1);
    expect(existsSync(t.stateFile)).toBe(false);
    shell.close();
  });

  it('refuses other clients and keeps running', async () => {
    let calls = 0;
    const t = await started(() => void calls++);
    const cli = await t.as('cli');
    await expect(cli.request('system.shutdown', {})).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(cli.request('system.ping', {})).resolves.toHaveProperty('agentTime');
    expect(calls).toBe(0);
    expect(existsSync(t.stateFile)).toBe(true);
    cli.close();
  });

  it('answers not_implemented when the runner did not enable it', async () => {
    const t = await started();
    const shell = await t.as('shell');
    await expect(shell.request('system.shutdown', {})).rejects.toMatchObject({
      code: 'not_implemented',
    });
    shell.close();
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
