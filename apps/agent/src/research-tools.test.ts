/**
 * Research Tools and backup over the agent protocol (Phase 6): a real AgentClient
 * acting as the desktop shell answers the agent's dialog and link requests; the
 * agent's real services pick and extract a real file, fetch from a scripted web,
 * and back up the real database.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgent, type ShellHandlers } from '@rka/agent-client';
import { type ClientKind } from '@rka/agent-protocol';
import {
  buildDocx,
  createReconfigurableWebServices,
  loadWebConfig,
  paragraph,
  type FetchedDocument,
  type ReconfigurableWebServices,
} from '@rka/tools';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgentServer } from './server.js';
import { openAgentServices } from './services.js';
import { generateToken } from './token.js';

const PAGE_URL = 'https://one.example/history';

function scriptedWeb(): ReconfigurableWebServices {
  return {
    ...createReconfigurableWebServices(loadWebConfig({ SEARXNG_URL: 'http://127.0.0.1:9' })),
    fetcher: {
      fetch(url): Promise<FetchedDocument> {
        if (url !== PAGE_URL) return Promise.reject(new Error('not a fixture page'));
        const text = 'The Lindholm lighthouse was built in 1872.';
        return Promise.resolve({
          requestedUrl: url,
          finalUrl: url,
          canonicalUrl: url,
          redirects: [],
          status: 200,
          kind: 'html',
          contentType: 'text/html',
          byteLength: text.length,
          sha256: 'c'.repeat(64),
          retrievedAt: '2026-11-14T10:00:00.000Z',
          title: 'Lindholm',
          text,
          truncated: false,
          metadata: {},
          timings: { downloadMs: 1, extractMs: 1 },
        });
      },
    },
  };
}

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-tools-'));
  dirs.push(dir);
  return dir;
};

async function setup() {
  const services = openAgentServices({
    dataDir: tempDir(),
    env: { OLLAMA_HOST: '127.0.0.1:9' },
    webServices: scriptedWeb(),
  });
  cleanups.push(() => services.close());
  const token = generateToken();
  const logs: string[] = [];
  const server = await startAgentServer({
    token,
    agentVersion: '1.0.0',
    handlers: services.handlers,
    onDisconnect: (id) => services.onDisconnect(id),
    log: (m) => logs.push(m),
  });
  services.attachServer(server);
  cleanups.push(() => server.close());
  const connect = async (handlers: ShellHandlers, kind: ClientKind = 'shell') => {
    const client = await connectAgent({ port: server.port, token, client: { kind, version: '1' } });
    client.serve(handlers);
    cleanups.push(() => client.close());
    return client;
  };
  return { connect, logs };
}

describe('Research Tools and backup in service mode (Phase 6)', () => {
  it('picks a file through the shell dialog and extracts it by token only', async () => {
    const dir = tempDir();
    const path = join(dir, 'notes.docx');
    writeFileSync(path, buildDocx(paragraph('Word document text.'), { title: 'Notes' }));
    const { connect } = await setup();
    const client = await connect({ 'shell.chooseFile': () => ({ path }) });

    const picked = await client.request('researchTools.pickFile', {});
    expect(picked).toMatchObject({
      status: 'selected',
      file: { name: 'notes.docx', kind: 'docx' },
    });
    expect(JSON.stringify(picked)).not.toContain(dir);
    if (picked.status !== 'selected') return;
    await expect(
      client.request('researchTools.extractFile', { requestId: 'r1', token: picked.file.token }),
    ).resolves.toMatchObject({
      status: 'ok',
      source: { kind: 'docx', label: 'notes.docx', text: 'Word document text.' },
    });
  });

  it('reports a cancelled file dialog', async () => {
    const { connect } = await setup();
    const client = await connect({ 'shell.chooseFile': () => ({ path: null }) });
    await expect(client.request('researchTools.pickFile', {})).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('opens only fetched links, through the shell', async () => {
    const { connect } = await setup();
    const opened: string[] = [];
    const client = await connect({
      'shell.openExternal': ({ url }) => {
        opened.push(url);
        return null;
      },
    });
    await expect(
      client.request('researchTools.openUrl', { url: 'https://never.example/' }),
    ).resolves.toMatchObject({ status: 'refused' });
    await expect(
      client.request('researchTools.fetchUrl', { requestId: 'f1', url: PAGE_URL }),
    ).resolves.toMatchObject({ status: 'ok' });
    await expect(client.request('researchTools.openUrl', { url: PAGE_URL })).resolves.toEqual({
      status: 'opened',
    });
    expect(opened).toEqual([PAGE_URL]);
  });

  it('backs up the database to the path the shell dialog chose', async () => {
    const target = join(tempDir(), 'backup.db');
    const { connect } = await setup();
    let answer: string | null = target;
    const client = await connect({ 'shell.chooseBackupPath': () => ({ path: answer }) });
    await expect(client.request('storage.backup', {})).resolves.toMatchObject({
      status: 'saved',
      path: target,
      verified: true,
    });
    expect(existsSync(target)).toBe(true);
    answer = null;
    await expect(client.request('storage.backup', {})).resolves.toEqual({ status: 'cancelled' });
  });

  it('fails the pick safely when the shell disconnects mid-dialog', async () => {
    const { connect, logs } = await setup();
    let asked!: () => void;
    const dialogOpen = new Promise<void>((resolve) => (asked = resolve));
    const shell = await connect({
      'shell.chooseFile': () => {
        asked();
        return new Promise<never>(() => undefined);
      },
    });
    const pick = shell.request('researchTools.pickFile', {}).catch((error: unknown) => error);
    await dialogOpen;
    shell.close();
    await expect(pick).resolves.toMatchObject({ code: 'connection_closed' });
    await expect
      .poll(() => logs)
      .toContain('researchTools.pickFile failed: The shell disconnected during shell.chooseFile.');

    // The agent is still serving: a new shell can pick.
    const next = await connect({ 'shell.chooseFile': () => ({ path: null }) });
    await expect(next.request('researchTools.pickFile', {})).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('never shows a dialog on another client than the one that asked', async () => {
    const { connect } = await setup();
    const shown: string[] = [];
    await connect({
      'shell.chooseFile': () => {
        shown.push('shell');
        return { path: null };
      },
    });
    const cli = await connect({}, 'cli');
    await expect(cli.request('researchTools.pickFile', {})).rejects.toMatchObject({
      code: 'internal',
    });
    expect(shown).toEqual([]);
  });
});

describe('Electron substitutes for clients without a shell (agent Web API)', () => {
  it('extracts an uploaded file from its bytes, for a client without dialogs', async () => {
    const { connect } = await setup();
    const cli = await connect({}, 'cli');
    const docx = buildDocx(paragraph('Uploaded text.'), { title: 'Up' });
    await expect(
      cli.request('researchTools.extractUpload', {
        requestId: 'u1',
        name: 'upload.docx',
        contentBase64: Buffer.from(docx).toString('base64'),
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      source: { kind: 'docx', label: 'upload.docx', text: 'Uploaded text.' },
    });
  });

  it('refuses a file whose content does not match its type, and path names', async () => {
    const { connect } = await setup();
    const cli = await connect({}, 'cli');
    const renamed = await cli.request('researchTools.extractUpload', {
      requestId: 'u2',
      name: 'invoice.pdf',
      contentBase64: Buffer.from('MZ not a pdf').toString('base64'),
    });
    expect(renamed).toMatchObject({ status: 'error' });
    await expect(
      cli.request('researchTools.extractUpload', {
        requestId: 'u3',
        name: '../../etc/passwd.docx',
        contentBase64: 'AAAA',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('hands out the database as a snapshot read in chunks (no save dialog, no file)', async () => {
    const { connect } = await setup();
    const cli = await connect({}, 'cli');
    await cli.request('tasks.runPersistenceCheck', {});
    const info = await cli.request('storage.createSnapshot', {});
    expect(info.fileName).toMatch(/^research-.+\.db$/);
    const parts: Buffer[] = [];
    for (let offset = 0; ;) {
      const chunk = await cli.request('storage.readSnapshot', {
        snapshotId: info.snapshotId,
        offset,
        length: 64 * 1024,
      });
      if (!chunk) throw new Error('snapshot expired');
      const bytes = Buffer.from(chunk.dataBase64, 'base64');
      parts.push(bytes);
      offset += bytes.length;
      if (chunk.eof) break;
    }
    const bytes = Buffer.concat(parts);
    expect(bytes.length).toBe(info.sizeBytes);
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    await expect(
      cli.request('storage.readSnapshot', {
        snapshotId: '00000000-0000-4000-8000-000000000000',
        offset: 0,
        length: 1,
      }),
    ).resolves.toBeNull();
  });
});
