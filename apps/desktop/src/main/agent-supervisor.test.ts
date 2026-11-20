import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { type StateFileConnection } from '@rka/agent-client';
import { PROTOCOL_NAME, PROTOCOL_VERSION } from '@rka/agent-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEntryPath,
  agentEnvironment,
  agentLaunchArgs,
  createAgentSupervisor,
  type AgentSupervisorDeps,
  type ForkAgent,
} from './agent-supervisor.js';

const TOKEN = 'supervisor-test-token'.padEnd(43, '_');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    setImmediate(() => this.emit('exit', 15));
    return true;
  });
  constructor(readonly pid: number) {
    super();
  }
}

function writeState(stateFile: string, pid: number): void {
  writeFileSync(
    stateFile,
    JSON.stringify({
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      host: '127.0.0.1',
      port: 4567,
      token: TOKEN,
      pid,
      startedAt: '2026-11-14T12:00:00.000Z',
    }),
  );
}

/** A connection whose `system.shutdown` / `system.ping` behave as given. */
function fakeConnection(pid: number, onRequest: (method: string) => Promise<unknown>) {
  const client = {
    ack: { version: PROTOCOL_VERSION, agent: { pid, version: '0.1.0' } },
    request: vi.fn((method: string) => onRequest(method)),
    close: vi.fn(),
  };
  return {
    client,
    connection: {
      client,
      state: { host: '127.0.0.1', port: 4567, pid },
    } as unknown as StateFileConnection,
  };
}

function setup(overrides: Partial<AgentSupervisorDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rka-supervisor-'));
  dirs.push(dataDir);
  const stateFile = join(dataDir, 'agent-state.json');
  const children: FakeChild[] = [];
  const forks: Parameters<ForkAgent>[] = [];
  /** By default the agent comes up: writes its state file shortly after the fork. */
  let onFork = (child: FakeChild): void => {
    setTimeout(() => writeState(stateFile, child.pid), 20);
  };
  const fork = vi.fn<ForkAgent>((...args) => {
    forks.push(args);
    const child = new FakeChild(1000 + children.length);
    children.push(child);
    onFork(child);
    return child;
  });
  const requests: string[] = [];
  /** What a connection to the state file's agent does with each request. */
  let answer = (method: string, pid: number): Promise<unknown> => {
    if (method === 'system.shutdown') {
      const child = children.find((c) => c.pid === pid);
      setTimeout(() => {
        rmSync(stateFile, { force: true });
        child?.emit('exit', 0);
      }, 10);
      return Promise.resolve(null);
    }
    return Promise.resolve({ nonce: 'n', agentTime: '2026-11-14T12:00:00.000Z' });
  };
  const connect = vi.fn((path: string) => {
    expect(path).toBe(stateFile);
    if (!existsSync(stateFile)) return Promise.reject(new Error('No agent state file.'));
    const pid = Number((JSON.parse(readFileSync(stateFile, 'utf8')) as { pid: number }).pid);
    return Promise.resolve(
      fakeConnection(pid, (method) => {
        requests.push(method);
        return answer(method, pid);
      }).connection,
    );
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const supervisor = createAgentSupervisor({
    fork,
    appPath: '/app/resources/app.asar',
    dataDir,
    appVersion: '0.1.0',
    env: { OLLAMA_HOST: '127.0.0.1:11434', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' },
    log,
    connect,
    startTimeoutMs: 2_000,
    stopTimeoutMs: 200,
    ...overrides,
  });
  return {
    supervisor,
    stateFile,
    dataDir,
    fork,
    forks,
    children,
    connect,
    requests,
    log,
    setOnFork: (fn: typeof onFork) => (onFork = fn),
    setAnswer: (fn: typeof answer) => (answer = fn),
  };
}

describe('agent launch allow-list', () => {
  it('is the bundled entry under the app path with fixed arguments', () => {
    expect(agentEntryPath('/app/resources/app.asar')).toBe(
      join('/app/resources/app.asar', 'out', 'agent', 'main.js'),
    );
    expect(agentLaunchArgs({ dataDir: '/d', stateFile: '/d/agent-state.json' })).toEqual([
      '--data-dir',
      '/d',
      '--state-file',
      '/d/agent-state.json',
      '--port',
      '0',
    ]);
  });

  it('passes the environment on without runtime switches', () => {
    expect(
      agentEnvironment({
        OLLAMA_HOST: 'h',
        PATH: '/bin',
        NODE_OPTIONS: '--require x',
        ELECTRON_RUN_AS_NODE: '1',
        electron_enable_logging: '1',
        EMPTY: undefined,
      }),
    ).toEqual({ OLLAMA_HOST: 'h', PATH: '/bin' });
  });
});

describe('createAgentSupervisor', () => {
  it('starts only the bundled agent and connects once its state file is written', async () => {
    const t = setup();
    const agent = await t.supervisor.start();
    expect(t.forks).toEqual([
      [
        agentEntryPath('/app/resources/app.asar'),
        agentLaunchArgs({ dataDir: t.dataDir, stateFile: t.stateFile }),
        { env: { OLLAMA_HOST: '127.0.0.1:11434' }, serviceName: 'Research Agent', stdio: 'pipe' },
      ],
    ]);
    expect(agent.summary).toMatch(/^connected to 127\.0\.0\.1:4567 \(agent pid 1000, v0\.1\.0/);
    expect(t.requests).toEqual(['system.ping']);
    expect(JSON.stringify(t.forks)).not.toContain(TOKEN);
  });

  it('forwards the agent output to the log', async () => {
    const t = setup();
    await t.supervisor.start();
    t.children[0]?.stdout.write('[agent] Database: x\n[agent] Listening\n');
    t.children[0]?.stderr.write('a warning\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.log.info).toHaveBeenCalledWith('[agent] Database: x');
    expect(t.log.info).toHaveBeenCalledWith('[agent] Listening');
    expect(t.log.warn).toHaveBeenCalledWith('a warning');
  });

  it('ignores a state file of another process and removes a stale one before the start', async () => {
    const t = setup();
    writeState(t.stateFile, 77); // left by a crashed run; nothing answers
    t.connect.mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')));
    t.setOnFork((child) => {
      expect(existsSync(t.stateFile)).toBe(false);
      setTimeout(() => writeState(t.stateFile, child.pid), 20);
    });
    await t.supervisor.start();
    expect(t.fork).toHaveBeenCalledTimes(1);
  });

  it('asks an agent still running from an earlier run to stop first', async () => {
    const t = setup();
    writeState(t.stateFile, 1000);
    const earlier = new FakeChild(1000);
    t.children.push(earlier);
    await t.supervisor.start();
    expect(t.requests.slice(0, 1)).toEqual(['system.shutdown']);
    expect(t.log.info).toHaveBeenCalledWith(
      'Agent service: stopped an agent left running by an earlier run.',
    );
  });

  it('fails with the agent error when it exits during startup', async () => {
    const t = setup();
    t.setOnFork((child) =>
      setTimeout(() => {
        child.stderr.write('[agent] Another agent is using the state file.\n');
        setTimeout(() => child.emit('exit', 1), 10);
      }, 10),
    );
    await expect(t.supervisor.start()).rejects.toThrow(
      'The agent service exited during startup (code 1). [agent] Another agent is using the state file.',
    );
  });

  it('times out when the agent never writes its state file', async () => {
    const t = setup({ startTimeoutMs: 100 });
    t.setOnFork(() => undefined);
    await expect(t.supervisor.start()).rejects.toThrow('The agent service did not start in time.');
  });

  it('stops cleanly with system.shutdown on a control connection', async () => {
    const t = setup();
    await t.supervisor.start();
    await t.supervisor.stop();
    expect(t.requests).toEqual(['system.ping', 'system.shutdown']);
    expect(t.children[0]?.kill).not.toHaveBeenCalled();
    expect(existsSync(t.stateFile)).toBe(false);
    expect(t.log.warn).not.toHaveBeenCalled();
    await t.supervisor.stop(); // idempotent
    expect(t.requests).toHaveLength(2);
  });

  it('kills an agent that does not stop and removes its state file', async () => {
    const t = setup();
    await t.supervisor.start();
    t.setAnswer(() => Promise.reject(new Error('timeout')));
    await t.supervisor.stop();
    expect(t.children[0]?.kill).toHaveBeenCalledTimes(1);
    expect(existsSync(t.stateFile)).toBe(false);
    expect(t.log.warn).toHaveBeenCalledWith(
      'Agent service: did not stop in time; ending the process.',
    );
  });

  it('warns when the agent stops unexpectedly; stop is then a no-op', async () => {
    const t = setup();
    await t.supervisor.start();
    t.children[0]?.emit('exit', 3);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.log.warn).toHaveBeenCalledWith(
      'Agent service stopped unexpectedly (code 3). Requests to the agent fail until the app restarts.',
    );
    await t.supervisor.stop();
    expect(t.requests).toEqual(['system.ping']);
    expect(existsSync(t.stateFile)).toBe(false);
  });

  it('does nothing on stop when it was never started', async () => {
    const t = setup();
    await t.supervisor.stop();
    expect(t.fork).not.toHaveBeenCalled();
  });
});
