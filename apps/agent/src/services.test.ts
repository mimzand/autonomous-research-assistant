import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAgent, type AgentClient } from '@rka/agent-client';
import { PROTOCOL_METHODS } from '@rka/agent-protocol';
import { appDatabasePath, openStorage } from '@rka/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgentServer, type AgentServer } from './server.js';
import { openAgentServices, type AgentServices } from './services.js';
import { generateToken } from './token.js';

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rka-agent-data-'));
  dirs.push(dir);
  return dir;
}

function open(dir: string, log?: (message: string) => void): AgentServices {
  const services = openAgentServices({ dataDir: dir, env: {}, ...(log && { log }) });
  cleanups.push(() => services.close());
  return services;
}

/** Serves `services` on 127.0.0.1 and returns an authenticated client. */
async function serve(services: AgentServices): Promise<AgentClient> {
  const token = generateToken();
  const server: AgentServer = await startAgentServer({
    token,
    agentVersion: '1.0.0',
    handlers: services.handlers,
  });
  cleanups.push(() => server.close());
  const client = await connectAgent({ port: server.port, token });
  cleanups.push(() => client.close());
  return client;
}

/** A finished research task with one source, one report and one log entry. */
function seed(dir: string) {
  const storage = openStorage({ path: appDatabasePath(dir) });
  const task = storage.tasks.create({ title: 'Seeded research', input: { question: 'q' } });
  storage.tasks.start(task.id);
  const source = storage.sources.add(task.id, {
    url: 'https://example.org/a',
    title: 'Example source',
  });
  const report = storage.reports.create(task.id, {
    title: 'Seeded report',
    content: '# Report',
    citedSourceIds: [source.id],
  });
  storage.logs.append(task.id, { level: 'info', event: 'note', message: 'Seeded.' });
  storage.tasks.complete(task.id, { summary: 'done' });
  storage.close();
  return { taskId: task.id, sourceId: source.id, reportId: report.id };
}

describe('openAgentServices', () => {
  it('opens the database in the userData layout and runs migrations', () => {
    const dir = dataDir();
    const services = open(dir);
    expect(services.databasePath).toBe(join(dir, 'data', 'research.db'));
    expect(services.recovery.interruptedTaskIds).toEqual([]);
  });

  it('marks tasks left running as interrupted on open, and logs it', () => {
    const dir = dataDir();
    const first = openStorage({ path: appDatabasePath(dir) });
    const task = first.tasks.create({ title: 'Research', input: { question: 'q' } });
    first.tasks.start(task.id);
    first.close(); // Simulated crash.

    const logs: string[] = [];
    const services = open(dir, (m) => logs.push(m));
    expect(services.recovery.interruptedTaskIds).toEqual([task.id]);
    expect(logs).toContain('Marked 1 task(s) as interrupted after an unexpected shutdown.');
  });

  it('serves every shell → agent method except system.* (Phases 3–7, Web API)', () => {
    const served = Object.keys(open(dataDir()).handlers).sort();
    const toAgent = Object.entries(PROTOCOL_METHODS)
      .filter(([, def]) => def.type === 'request' && def.direction === 'toAgent')
      .map(([name]) => name)
      .filter((name) => !name.startsWith('system.'))
      .sort();
    expect(served).toEqual(toAgent);
    expect(served).toEqual([
      'chat.clear',
      'chat.history',
      'chat.start',
      'chat.stop',
      'model.connect',
      'model.connectionState',
      'model.disconnect',
      'model.effectiveConfig',
      'model.health',
      'model.listModels',
      'model.showModel',
      'model.testConnection',
      'model.testModel',
      'reports.get',
      'reports.list',
      'researchTools.cancel',
      'researchTools.checkSearch',
      'researchTools.extractFile',
      'researchTools.extractUpload',
      'researchTools.fetchUrl',
      'researchTools.openUrl',
      'researchTools.pickFile',
      'researchTools.saveSource',
      'researchTools.search',
      'researchTools.status',
      'settings.chooseBackupFolder',
      'settings.get',
      'settings.reset',
      'settings.storeSecret',
      'settings.testSearxng',
      'settings.update',
      'settings.validate',
      'sources.get',
      'sources.list',
      'storage.backup',
      'storage.createSnapshot',
      'storage.integrityCheck',
      'storage.readSnapshot',
      'storage.status',
      'tasks.cancel',
      'tasks.counts',
      'tasks.get',
      'tasks.list',
      'tasks.logs',
      'tasks.pause',
      'tasks.resume',
      'tasks.retry',
      'tasks.runPersistenceCheck',
      'tasks.startResearch',
    ]);
  });
});

describe('dashboard methods over the protocol', () => {
  it('reads tasks, logs, sources and reports from the agent database', async () => {
    const dir = dataDir();
    const ids = seed(dir);
    const client = await serve(open(dir));

    const counts = await client.request('tasks.counts', {});
    expect(counts).toMatchObject({ total: 1, byStatus: { completed: 1 } });

    const list = await client.request('tasks.list', {});
    expect(list.items.map((t) => t.id)).toEqual([ids.taskId]);

    const task = await client.request('tasks.get', { id: ids.taskId });
    expect(task).toMatchObject({ task: { id: ids.taskId, title: 'Seeded research' } });
    await expect(client.request('tasks.get', { id: 'missing' })).resolves.toBeNull();

    const logs = await client.request('tasks.logs', { id: ids.taskId });
    expect(logs.items.map((l) => l.message)).toContain('Seeded.');

    const sources = await client.request('sources.list', {});
    expect(sources.items.map((s) => s.id)).toEqual([ids.sourceId]);
    await expect(client.request('sources.get', { id: ids.sourceId })).resolves.toMatchObject({
      source: { id: ids.sourceId },
    });

    const reports = await client.request('reports.list', {});
    expect(reports.items.map((r) => r.id)).toEqual([ids.reportId]);
    await expect(client.request('reports.get', { id: ids.reportId })).resolves.toMatchObject({
      report: { id: ids.reportId, title: 'Seeded report' },
      citedSources: [{ id: ids.sourceId }],
    });
  });

  it('reports storage status and integrity', async () => {
    const dir = dataDir();
    const client = await serve(open(dir));
    const status = await client.request('storage.status', {});
    expect(status).toMatchObject({ path: appDatabasePath(dir) });
    await expect(client.request('storage.integrityCheck', {})).resolves.toMatchObject({
      ok: true,
    });
  });

  it('runs the persistence check as a write in the agent database', async () => {
    const dir = dataDir();
    const services = open(dir);
    const client = await serve(services);
    const result = await client.request('tasks.runPersistenceCheck', {});
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    await expect(client.request('tasks.get', { id: result.taskId })).resolves.not.toBeNull();
  });

  it('answers not_implemented for later-phase methods and keeps the connection', async () => {
    const client = await serve(open(dataDir()));
    await expect(client.request('system.shutdown', {})).rejects.toMatchObject({
      code: 'not_implemented',
    });
    await expect(client.request('tasks.counts', {})).resolves.toBeDefined();
  });

  it('rejects invalid params before they reach the database', async () => {
    const client = await serve(open(dataDir()));
    await expect(client.request('tasks.get', { id: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});
