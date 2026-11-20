import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentClientError } from '@rka/agent-client';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION, type Envelope } from '@rka/agent-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentStateFilePath,
  agentTransportFromEnv,
  connectServiceAgent,
  resolveAgentTransport,
  SERVICE_CONNECT_TIMEOUT_MS,
} from './agent-transport.js';

const token = 'desktop-test-token'.padEnd(43, '_');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('agentTransportFromEnv', () => {
  it('defaults to the supervised agent service (Phase 8)', () => {
    expect(agentTransportFromEnv({})).toBe('service');
    expect(agentTransportFromEnv({ AGENT_TRANSPORT: '  ' })).toBe('service');
  });

  it('accepts every mode, case-insensitively', () => {
    expect(agentTransportFromEnv({ AGENT_TRANSPORT: 'service' })).toBe('service');
    expect(agentTransportFromEnv({ AGENT_TRANSPORT: ' Service ' })).toBe('service');
    expect(agentTransportFromEnv({ AGENT_TRANSPORT: 'EXTERNAL' })).toBe('external');
    expect(agentTransportFromEnv({ AGENT_TRANSPORT: 'INPROCESS' })).toBe('inprocess');
  });

  it('stops startup on an unknown value instead of guessing', () => {
    expect(() => agentTransportFromEnv({ AGENT_TRANSPORT: 'remote' })).toThrow(
      'AGENT_TRANSPORT must be "service", "external" or "inprocess" (got "remote").',
    );
  });
});

describe('resolveAgentTransport', () => {
  it('keeps every mode in development', () => {
    for (const mode of ['service', 'external', 'inprocess'] as const) {
      expect(resolveAgentTransport({ AGENT_TRANSPORT: mode }, { isPackaged: false })).toEqual({
        transport: mode,
      });
    }
  });

  it('always supervises the agent in a packaged app, warning about a dev-only mode', () => {
    expect(resolveAgentTransport({}, { isPackaged: true })).toEqual({ transport: 'service' });
    for (const mode of ['external', 'inprocess']) {
      expect(resolveAgentTransport({ AGENT_TRANSPORT: mode }, { isPackaged: true })).toEqual({
        transport: 'service',
        warning: `Ignored AGENT_TRANSPORT=${mode}: the installed app always runs its own agent service.`,
      });
    }
  });

  it('still refuses an unknown value when packaged', () => {
    expect(() =>
      resolveAgentTransport({ AGENT_TRANSPORT: 'remote' }, { isPackaged: true }),
    ).toThrow(/AGENT_TRANSPORT must be/);
  });
});

describe('agentStateFilePath', () => {
  const base = { env: {}, appPath: join('repo', 'apps', 'desktop'), userDataDir: 'userdata' };

  it('uses the file pnpm agent:dev writes in development', () => {
    expect(agentStateFilePath({ ...base, isPackaged: false })).toBe(
      join('repo', 'apps', 'agent', '.agent-data', 'agent-state.json'),
    );
  });

  it('uses the user data folder when packaged', () => {
    expect(agentStateFilePath({ ...base, isPackaged: true })).toBe(
      join('userdata', 'agent-state.json'),
    );
  });

  it('honours AGENT_STATE_FILE', () => {
    expect(
      agentStateFilePath({ ...base, isPackaged: true, env: { AGENT_STATE_FILE: 'x/state.json' } }),
    ).toBe(resolve('x/state.json'));
  });
});

describe('connectServiceAgent', () => {
  it('fails with an actionable message when the agent is not running', async () => {
    const connect = () =>
      Promise.reject(new AgentClientError('not_running', 'No agent state file at X.'));
    await expect(connectServiceAgent({ stateFile: 'X', appVersion: '1', connect })).rejects.toThrow(
      'The agent service is not reachable. No agent state file at X. ' +
        'AGENT_TRANSPORT=external: start it with "pnpm agent:dev", or unset AGENT_TRANSPORT to let the app start its own agent.',
    );
    await expect(
      connectServiceAgent({ stateFile: 'X', appVersion: '1', connect, hint: 'Restart the app.' }),
    ).rejects.toThrow(
      'The agent service is not reachable. No agent state file at X. Restart the app.',
    );
  });

  it('passes the shell identity and a bounded timeout', async () => {
    const seen: unknown[] = [];
    const connect = (path: string, options: unknown) => {
      seen.push(path, options);
      return Promise.reject(new Error('stop'));
    };
    await expect(
      connectServiceAgent({ stateFile: 'S', appVersion: '2.0.0', connect }),
    ).rejects.toThrow(/stop/);
    expect(seen).toEqual([
      'S',
      { client: { kind: 'shell', version: '2.0.0' }, timeoutMs: SERVICE_CONNECT_TIMEOUT_MS },
    ]);
  });

  it('closes the connection if the ping fails', async () => {
    let closed = false;
    const client = {
      ack: {} as never,
      request: () => Promise.reject(new AgentClientError('timeout', 'system.ping timed out.')),
      onEvent: () => () => undefined,
      serve: () => undefined,
      onClose: () => undefined,
      close: () => {
        closed = true;
      },
    };
    const connect = () => Promise.resolve({ client, state: {} as never });
    await expect(connectServiceAgent({ stateFile: 'S', appVersion: '1', connect })).rejects.toThrow(
      /system\.ping timed out\./,
    );
    expect(closed).toBe(true);
  });

  it('authenticates and pings over 127.0.0.1 through the state file', async () => {
    const received: Envelope[] = [];
    const server: Server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on('error', () => socket.destroy());
      socket.on('data', (chunk: Buffer) => {
        for (const r of decoder.push(chunk)) {
          if (!r.ok) {
            socket.destroy();
            return;
          }
          const { id, method, payload } = r.value;
          received.push(r.value);
          const reply: Envelope =
            method === 'system.hello'
              ? {
                  id,
                  kind: 'res',
                  method,
                  payload: {
                    protocol: 'rka-agent',
                    version: PROTOCOL_VERSION,
                    sessionId: '7d3b2c1a-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
                    agent: { pid: 777, version: '0.1.0', startedAt: '2026-11-14T12:00:00.000Z' },
                  },
                }
              : {
                  id,
                  kind: 'res',
                  method,
                  payload: { ...(payload as object), agentTime: new Date().toISOString() },
                };
          socket.write(encodeFrame(reply));
        }
      });
    });
    await new Promise<void>((r) => server.listen({ host: '127.0.0.1', port: 0 }, r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');

    const dir = mkdtempSync(join(tmpdir(), 'rka-desktop-agent-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stateFile = join(dir, 'agent-state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        protocol: 'rka-agent',
        version: PROTOCOL_VERSION,
        host: '127.0.0.1',
        port: address.port,
        token,
        pid: process.pid,
        startedAt: '2026-11-14T12:00:00.000Z',
      }),
    );

    const { client, summary } = await connectServiceAgent({ stateFile, appVersion: '0.1.0' });
    cleanups.push(() => client.close());
    expect(summary).toMatch(
      new RegExp(
        `^connected to 127\\.0\\.0\\.1:${address.port} \\(agent pid 777, v0\\.1\\.0, protocol ${PROTOCOL_VERSION}\\)`,
      ),
    );
    expect(summary).not.toContain(token);
    expect(received.map((e) => e.method)).toEqual(['system.hello', 'system.ping']);
    expect(received[0]?.payload).toMatchObject({
      token,
      client: { kind: 'shell', version: '0.1.0' },
    });
  });
});
