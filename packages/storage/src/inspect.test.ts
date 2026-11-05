import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { inputPreview, likePattern, TABLE_NAMES } from './inspect.js';
import { openStorage, type Storage } from './storage.js';
import { memoryStorage, tempDir } from './testing.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

/** Seeds a realistic mix of tasks, steps, sources and reports. */
function seed(storage: Storage) {
  const heat = storage.tasks.create({
    title: 'Heat pumps',
    input: { question: 'How efficient are heat pumps?' },
  });
  storage.tasks.start(heat.id);
  const s1 = storage.steps.append(heat.id, { kind: 'plan', name: 'Plan', input: { q: 1 } });
  storage.steps.start(s1.id);
  storage.steps.complete(s1.id, { plan: ['a', 'b'] });
  storage.steps.append(heat.id, { kind: 'search', name: 'Search' });
  const a = storage.sources.add(heat.id, { url: 'https://example.org/heat', title: 'Heat basics' });
  storage.sources.setContent(a.id, { contentType: 'text/plain', text: 'Heat pumps move heat.' });
  const b = storage.sources.add(heat.id, { url: 'https://example.org/cop_100%', title: 'COP' });
  storage.reports.create(heat.id, {
    title: 'Heat report',
    content: '# Heat\nText',
    citedSourceIds: [a.id],
  });

  const solar = storage.tasks.create({ title: 'Solar', input: 'plain text input' });
  storage.tasks.start(solar.id);
  storage.tasks.complete(solar.id, { summary: 'done' });

  const failed = storage.tasks.create({ title: 'Wind', input: { question: 'Wind?' } });
  storage.tasks.start(failed.id);
  storage.tasks.fail(failed.id, 'Network down');

  return { heat, solar, failed, sources: { a, b }, step: s1 };
}

describe('inspector: tasks', () => {
  it('counts tasks by status', () => {
    const storage = memoryStorage();
    seed(storage);
    const counts = storage.inspect.taskStatusCounts();
    expect(counts.total).toBe(3);
    expect(counts.byStatus).toMatchObject({
      running: 1,
      completed: 1,
      failed: 1,
      pending: 0,
      interrupted: 0,
    });
  });

  it('lists tasks newest first with step and source counts', () => {
    const storage = memoryStorage();
    const { heat } = seed(storage);
    const { items, total } = storage.inspect.listTasks();
    expect(total).toBe(3);
    expect(items.map((t) => t.title)).toEqual(['Wind', 'Solar', 'Heat pumps']);
    expect(items.find((t) => t.id === heat.id)).toMatchObject({
      inputPreview: 'How efficient are heat pumps?',
      status: 'running',
      stepCount: 2,
      completedStepCount: 1,
      sourceCount: 2,
    });
    expect(items.find((t) => t.title === 'Solar')?.inputPreview).toBe('plain text input');
  });

  it('filters by status and searches title and input', () => {
    const storage = memoryStorage();
    seed(storage);
    expect(storage.inspect.listTasks({ status: ['failed'] }).items.map((t) => t.title)).toEqual([
      'Wind',
    ]);
    expect(storage.inspect.listTasks({ status: ['failed', 'completed'] }).total).toBe(2);
    expect(storage.inspect.listTasks({ search: 'heat' }).items.map((t) => t.title)).toEqual([
      'Heat pumps',
    ]);
    expect(storage.inspect.listTasks({ search: 'efficient' }).total).toBe(1); // matches input JSON
    expect(storage.inspect.listTasks({ search: 'nothing-matches' })).toEqual({
      items: [],
      total: 0,
    });
  });

  it('paginates with a stable total', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 7; i++) storage.tasks.create({ title: `Task ${i}`, input: {} });
    const page1 = storage.inspect.listTasks({ limit: 3, offset: 0 });
    const page3 = storage.inspect.listTasks({ limit: 3, offset: 6 });
    expect(page1.total).toBe(7);
    expect(page1.items).toHaveLength(3);
    expect(page3.items.map((t) => t.title)).toEqual(['Task 0']);
  });

  it('treats LIKE wildcards in search literally', () => {
    const storage = memoryStorage();
    storage.tasks.create({ title: '100% done', input: {} });
    storage.tasks.create({ title: '100 items', input: {} });
    expect(storage.inspect.listTasks({ search: '100%' }).items.map((t) => t.title)).toEqual([
      '100% done',
    ]);
    expect(likePattern('a_b%c\\')).toBe('%a\\_b\\%c\\\\%');
  });

  it('rejects invalid queries', () => {
    const storage = memoryStorage();
    expect(() => storage.inspect.listTasks({ status: ['exploded' as never] })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(() => storage.inspect.listTasks({ limit: 10_000 })).toThrow(/Invalid task query/);
  });

  it('loads task details with every step, counts and usage', () => {
    const storage = memoryStorage();
    const { heat, step } = seed(storage);
    storage.modelUsage.record({
      taskId: heat.id,
      stepId: step.id,
      provider: 'ollama',
      model: 'qwen3:8b',
      purpose: 'plan',
      completionTokens: 9,
    });
    const details = storage.inspect.getTaskDetails(heat.id);
    expect(details?.task).toMatchObject({ title: 'Heat pumps', status: 'running' });
    expect(details?.steps.map((s) => [s.seq, s.status, s.output])).toEqual([
      [1, 'completed', { plan: ['a', 'b'] }],
      [2, 'pending', null],
    ]);
    expect(details).toMatchObject({ sourceCount: 2, reportCount: 1, pendingApprovalCount: 0 });
    expect(details?.usage).toEqual([
      { provider: 'ollama', model: 'qwen3:8b', calls: 1, promptTokens: 0, completionTokens: 9 },
    ]);
    expect(storage.inspect.getTaskDetails('missing')).toBeUndefined();
  });

  it('previews structured and long inputs', () => {
    expect(inputPreview({ question: 'Q?' })).toBe('Q?');
    expect(inputPreview({ topic: 'x' })).toBe('{"topic":"x"}');
    expect(inputPreview('a'.repeat(300))).toHaveLength(200);
  });
});

describe('inspector: knowledge base', () => {
  it('lists sources with task, content status, size and hash', () => {
    const storage = memoryStorage();
    const { sources } = seed(storage);
    const result = storage.inspect.listSources();
    expect(result.total).toBe(2);
    expect(result.totals).toEqual({
      sources: 2,
      withContent: 1,
      contentBytes: Buffer.byteLength('Heat pumps move heat.'),
      tasksWithSources: 1,
    });
    const extracted = result.items.find((s) => s.id === sources.a.id);
    expect(extracted).toMatchObject({
      taskTitle: 'Heat pumps',
      url: 'https://example.org/heat',
      hasContent: true,
      contentType: 'text/plain',
      byteLength: 21,
    });
    expect(extracted?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.items.find((s) => s.id === sources.b.id)).toMatchObject({
      hasContent: false,
      byteLength: null,
      sha256: null,
    });
  });

  it('filters by content status, task and search', () => {
    const storage = memoryStorage();
    const { heat, solar } = seed(storage);
    expect(storage.inspect.listSources({ content: 'extracted' }).items.map((s) => s.title)).toEqual(
      ['Heat basics'],
    );
    expect(storage.inspect.listSources({ content: 'missing' }).items.map((s) => s.title)).toEqual([
      'COP',
    ]);
    expect(storage.inspect.listSources({ taskId: heat.id }).total).toBe(2);
    expect(storage.inspect.listSources({ taskId: solar.id }).total).toBe(0);
    expect(storage.inspect.listSources({ search: 'cop_100%' }).items.map((s) => s.title)).toEqual([
      'COP',
    ]);
  });

  it('opens a source with its extracted content kept separate from metadata', () => {
    const storage = memoryStorage();
    const { sources } = seed(storage);
    const details = storage.inspect.getSource(sources.a.id);
    expect(details?.source).toMatchObject({ title: 'Heat basics', metadata: null });
    expect(details?.content).toMatchObject({ text: 'Heat pumps move heat.', byteLength: 21 });
    expect(storage.inspect.getSource(sources.b.id)?.content).toBeNull();
    expect(storage.inspect.getSource('missing')).toBeUndefined();
  });
});

describe('inspector: reports', () => {
  it('lists reports with task, version and citation count', () => {
    const storage = memoryStorage();
    const { heat, sources } = seed(storage);
    storage.reports.create(heat.id, {
      title: 'Heat report',
      content: 'v2',
      citedSourceIds: [sources.a.id, sources.b.id],
    });
    const { items, total } = storage.inspect.listReports();
    expect(total).toBe(2);
    expect(items.map((r) => [r.version, r.citedCount, r.taskTitle])).toEqual([
      [2, 2, 'Heat pumps'],
      [1, 1, 'Heat pumps'],
    ]);
    expect(storage.inspect.listReports({ search: 'nomatch' }).total).toBe(0);
  });

  it('opens a report with resolved citations', () => {
    const storage = memoryStorage();
    const { sources } = seed(storage);
    const [summary] = storage.inspect.listReports().items;
    const details = storage.inspect.getReport(summary?.id ?? '');
    expect(details?.report.content).toBe('# Heat\nText');
    expect(details?.citedSources).toEqual([
      { id: sources.a.id, url: 'https://example.org/heat', title: 'Heat basics' },
    ]);
  });
});

describe('inspector: storage status, integrity and backup', () => {
  it('reports database status and row counts for every table', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const storage = openStorage({ path: dbPath });
    cleanups.unshift(() => storage.close());
    seed(storage);

    const status = storage.inspect.status();
    expect(status).toMatchObject({
      connected: true,
      path: dbPath,
      journalMode: 'wal',
      foreignKeys: true,
    });
    expect(status.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
    expect(status.files.databaseBytes).toBeGreaterThan(0);
    expect(status.tables.map((t) => t.name)).toEqual([...TABLE_NAMES]);
    expect(Object.fromEntries(status.tables.map((t) => [t.name, t.rows]))).toMatchObject({
      tasks: 3,
      task_steps: 2,
      sources: 2,
      source_contents: 1,
      reports: 1,
    });
    expect(status.migrations.map((m) => m.tag)).toEqual(['0000_initial', '0001_task_logs']);
    expect(status.lastIntegrityCheck).toBeNull();
  });

  it('runs an integrity check and remembers the last successful one', () => {
    const storage = memoryStorage();
    const result = storage.inspect.integrityCheck();
    expect(result).toMatchObject({ ok: true, messages: ['ok'] });
    const status = storage.inspect.status();
    expect(status.lastIntegrityCheck).toEqual(result);
    expect(status.lastSuccessfulIntegrityCheckAt).toBe(result.checkedAt);
  });

  it('detects corruption in the integrity check', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const storage = openStorage({ path: dbPath });
    seed(storage);
    storage.close();

    // Corrupt an index: point it at rows that do not exist.
    const raw = new BetterSqlite3(dbPath);
    raw.unsafeMode(true);
    raw.pragma('writable_schema = ON');
    raw.exec(
      `UPDATE sqlite_schema SET sql = replace(sql, '(\`status\`)', '(\`title\`)') WHERE name = 'tasks_status_idx'`,
    );
    raw.close();

    const reopened = openStorage({ path: dbPath });
    cleanups.unshift(() => reopened.close());
    const result = reopened.inspect.integrityCheck();
    expect(result.ok).toBe(false);
    expect(result.messages.join('\n')).toMatch(
      /tasks_status_idx|wrong # of entries|missing from index/,
    );
    expect(reopened.inspect.status().lastSuccessfulIntegrityCheckAt).toBeNull();
  });

  it('backs up to a new file and verifies it', async () => {
    const { dir, dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const storage = openStorage({ path: dbPath });
    cleanups.unshift(() => storage.close());
    seed(storage);

    const target = join(dir, 'backup.db');
    const result = await storage.inspect.backupTo(target);
    expect(result).toMatchObject({ path: target, verified: true });
    expect(result.bytes).toBeGreaterThan(0);

    const copy = openStorage({ path: target });
    expect(
      copy.tasks
        .list()
        .map((t) => t.title)
        .sort(),
    ).toEqual(['Heat pumps', 'Solar', 'Wind']);
    copy.close();
    expect(existsSync(`${target}.partial-${process.pid}`)).toBe(false);
  });

  it('refuses to overwrite the live database and leaves existing files intact on failure', async () => {
    const { dir, dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const storage = openStorage({ path: dbPath });
    cleanups.unshift(() => storage.close());
    await expect(storage.inspect.backupTo(dbPath)).rejects.toThrow(
      /cannot replace the live database/,
    );
    await expect(storage.inspect.backupTo(`${dbPath}-wal`)).rejects.toThrow(/live database/);

    const existing = join(dir, 'missing-folder', 'backup.db');
    await expect(storage.inspect.backupTo(existing)).rejects.toThrow();
    const keep = join(dir, 'keep.db');
    writeFileSync(keep, 'previous backup');
    await storage.inspect.backupTo(keep); // Caller confirmed overwrite.
    // Close every handle: Windows cannot delete files that are still open.
    const copy = new BetterSqlite3(keep, { readonly: true });
    cleanups.unshift(() => copy.close());
    expect(copy.pragma('quick_check', { simple: true })).toBe('ok');

    const memory = memoryStorage();
    cleanups.unshift(() => memory.close());
    await expect(memory.inspect.backupTo(join(dir, 'x.db'))).rejects.toThrow(/In-memory/);
  });
});

describe('persistence across restarts', () => {
  it('a task with completed steps and outputs reads back identically after reopening', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const first = openStorage({ path: dbPath });
    const task = first.tasks.create({ title: 'Survives restart', input: { question: 'Persist?' } });
    first.tasks.start(task.id);
    const step = first.steps.append(task.id, { kind: 'plan', name: 'Plan', input: { a: 1 } });
    first.steps.start(step.id);
    first.steps.complete(step.id, { answer: 'yes', nested: { list: [1, 2, 3] } });
    first.tasks.complete(task.id, { summary: 'all good' });
    const before = first.inspect.getTaskDetails(task.id);
    first.close();

    const second = openStorage({ path: dbPath });
    cleanups.unshift(() => second.close());
    const after = second.inspect.getTaskDetails(task.id);
    expect(after).toEqual(before);
    expect(after?.task).toMatchObject({ status: 'completed', output: { summary: 'all good' } });
    expect(after?.steps[0]).toMatchObject({
      status: 'completed',
      input: { a: 1 },
      output: { answer: 'yes', nested: { list: [1, 2, 3] } },
    });
    expect(second.inspect.listTasks().items.map((t) => t.title)).toEqual(['Survives restart']);
  });
});
