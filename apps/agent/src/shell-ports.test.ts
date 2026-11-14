import { connectAgent, type ShellHandlers } from '@rka/agent-client';
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  type ClientKind,
  type Envelope,
} from '@rka/agent-protocol';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellCallError } from './connection-context.js';
import { startAgentServer, type AgentServer } from './server.js';
import { createShellPorts, type ShellPortsOptions } from './shell-ports.js';
import { generateToken } from './token.js';

const token = generateToken();
const servers: AgentServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A server whose `storage.backup` and `researchTools.openUrl` use the shell ports. */
async function setup(options: Partial<ShellPortsOptions> = {}) {
  const logs: string[] = [];
  const failures: unknown[] = [];
  // Called only while a request is served, i.e. once `server` exists.
  const shell = createShellPorts({ connections: () => server.connections(), ...options });
  const server = await startAgentServer({
    token,
    agentVersion: '1',
    log: (m) => logs.push(m),
    handlers: {
      'storage.backup': async () => {
        try {
          const path = await shell.ports.chooseBackupPath();
          return path
            ? { status: 'saved', path, bytes: 0, verified: false }
            : { status: 'cancelled' };
        } catch (error) {
          failures.push(error);
          throw error;
        }
      },
      'researchTools.openUrl': async ({ url }) => {
        await shell.ports.openExternal(url);
        return { status: 'opened' };
      },
    },
  });
  servers.push(server);
  const port = server.port;
  const connectShell = async (handlers: ShellHandlers, kind: ClientKind = 'shell') => {
    const client = await connectAgent({ port, token, client: { kind, version: '1' } });
    client.serve(handlers);
    return client;
  };
  return { server, shell, logs, failures, connectShell };
}

const never = () => new Promise<never>(() => undefined);

describe('reverse calls to the shell (Phase 6)', () => {
  it('asks the shell that made the request, not another one', async () => {
    const { connectShell } = await setup();
    const a = await connectShell({ 'shell.chooseBackupPath': () => ({ path: 'C:\\a.db' }) });
    const b = await connectShell({ 'shell.chooseBackupPath': () => ({ path: 'C:\\b.db' }) });
    await expect(a.request('storage.backup', {})).resolves.toMatchObject({ path: 'C:\\a.db' });
    await expect(b.request('storage.backup', {})).resolves.toMatchObject({ path: 'C:\\b.db' });
    a.close();
    b.close();
  });

  it('treats a cancelled dialog as null and passes params through', async () => {
    const { connectShell } = await setup();
    const opened: string[] = [];
    const client = await connectShell({
      'shell.chooseBackupPath': () => ({ path: null }),
      'shell.openExternal': ({ url }) => {
        opened.push(url);
        return null;
      },
    });
    await expect(client.request('storage.backup', {})).resolves.toEqual({ status: 'cancelled' });
    await expect(
      client.request('researchTools.openUrl', { url: 'https://example.com/a' }),
    ).resolves.toEqual({ status: 'opened' });
    expect(opened).toEqual(['https://example.com/a']);
    client.close();
  });

  it('fails the operation when the shell does not serve the dialog or answers badly', async () => {
    const { connectShell, failures } = await setup();
    const silent = await connectShell({});
    await expect(silent.request('storage.backup', {})).rejects.toMatchObject({ code: 'internal' });
    expect(failures[0]).toMatchObject({ name: 'ShellCallError', code: 'not_implemented' });
    silent.close();

    // The shell client refuses its own invalid result; the raw test below covers the agent's check.
    const liar = await connectShell({
      'shell.chooseBackupPath': () => ({ path: 42 }) as never,
    });
    await expect(liar.request('storage.backup', {})).rejects.toMatchObject({ code: 'internal' });
    expect(failures[1]).toBeInstanceOf(ShellCallError);
    liar.close();
  });

  it('validates raw shell answers and ignores unsolicited ones', async () => {
    const { server, failures, logs } = await setup();
    const socket = connect({ host: '127.0.0.1', port: server.port });
    const decoder = new FrameDecoder();
    const received: Envelope[] = [];
    socket.on('data', (chunk: Buffer) => {
      for (const r of decoder.push(chunk)) {
        if (!r.ok) continue;
        received.push(r.value);
        if (r.value.method === 'shell.chooseBackupPath') {
          socket.write(encodeFrame({ ...r.value, kind: 'res', payload: { path: 42 } }));
        }
      }
    });
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(
      encodeFrame({
        id: 'h1',
        kind: 'req',
        method: 'system.hello',
        payload: {
          protocol: PROTOCOL_NAME,
          version: PROTOCOL_VERSION,
          token,
          client: { kind: 'shell', version: '0' },
        },
      }),
    );
    socket.write(encodeFrame({ id: 'x1', kind: 'res', method: 'shell.chooseFile', payload: {} }));
    socket.write(encodeFrame({ id: 'b1', kind: 'req', method: 'storage.backup', payload: {} }));
    await expect.poll(() => received.find((e) => e.id === 'b1')).toMatchObject({ kind: 'error' });
    expect(failures[0]).toMatchObject({ code: 'bad_request' });
    expect(logs).toContain('Rejecting an invalid shell.chooseBackupPath result from the shell.');
    expect(logs).toContain('Ignoring unsolicited res for shell.chooseFile.');
    socket.destroy();
  });

  it('times out a dialog nobody answers instead of hanging', async () => {
    const { connectShell, failures } = await setup({ dialogTimeoutMs: 50 });
    const client = await connectShell({ 'shell.chooseBackupPath': never });
    await expect(client.request('storage.backup', {})).rejects.toMatchObject({ code: 'internal' });
    expect(failures[0]).toMatchObject({ code: 'timeout' });
    client.close();
  });

  it('fails a pending dialog as soon as its shell disconnects', async () => {
    const { connectShell, failures } = await setup();
    let asked!: () => void;
    const dialogOpen = new Promise<void>((resolve) => (asked = resolve));
    const client = await connectShell({
      'shell.chooseBackupPath': () => {
        asked();
        return never();
      },
    });
    const backup = client.request('storage.backup', {}).catch((error: unknown) => error);
    await dialogOpen;
    const started = Date.now();
    client.close();
    await expect(backup).resolves.toMatchObject({ code: 'connection_closed' });
    await expect.poll(() => failures.length).toBe(1);
    expect(failures[0]).toMatchObject({ name: 'ShellCallError', code: 'shell_unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses dialogs outside a request', async () => {
    const { shell, connectShell } = await setup();
    const client = await connectShell({ 'shell.chooseFile': () => ({ path: 'C:\\x.pdf' }) });
    await expect(shell.ports.chooseFile()).rejects.toMatchObject({ code: 'shell_unavailable' });
    client.close();
  });

  it('asks the newest connected shell for secrets, never a non-shell client', async () => {
    const { shell, connectShell } = await setup();
    await expect(shell.secrets.getSecret('ollama.authToken')).rejects.toMatchObject({
      code: 'shell_unavailable',
    });
    const cli = await connectShell({ 'shell.getSecret': () => ({ value: 'from-cli' }) }, 'cli');
    await expect(shell.secrets.encryptionAvailable()).rejects.toMatchObject({
      code: 'shell_unavailable',
    });
    const older = await connectShell({ 'shell.getSecret': () => ({ value: 'older' }) });
    const newer = await connectShell({
      'shell.getSecret': ({ key }) => ({ value: `newer:${key}` }),
      'shell.encryptionAvailable': () => ({ available: true }),
    });
    await expect(shell.secrets.getSecret('ollama.authToken')).resolves.toBe(
      'newer:ollama.authToken',
    );
    await expect(shell.secrets.encryptionAvailable()).resolves.toBe(true);
    newer.close();
    await expect.poll(() => shell.secrets.getSecret('ollama.authToken')).toBe('older');
    cli.close();
    older.close();
  });
});
