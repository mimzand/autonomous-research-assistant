import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotChunkSchema, SnapshotInfoSchema } from '@rka/agent-protocol';
import { openStorage } from '@rka/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createSnapshotStore } from './snapshots.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Reads a whole snapshot back the way the Web API does. */
function readAll(
  store: ReturnType<typeof createSnapshotStore>,
  snapshotId: string,
  length: number,
) {
  const parts: Buffer[] = [];
  for (let offset = 0; ;) {
    const chunk = store.read({ snapshotId, offset, length });
    if (!chunk) throw new Error('snapshot gone');
    expect(SnapshotChunkSchema.parse(chunk)).toEqual(chunk);
    const bytes = Buffer.from(chunk.dataBase64, 'base64');
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.eof) return Buffer.concat(parts);
  }
}

describe('createSnapshotStore', () => {
  it('serves a consistent copy of the live database as a standalone SQLite file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rka-snapshot-'));
    dirs.push(dir);
    const storage = openStorage({ path: join(dir, 'research.db') });
    const task = storage.tasks.create({ title: 'Snapshot me', input: { question: 'q' } });
    const store = createSnapshotStore({ serialize: () => storage.sqlite.serialize() });

    const info = store.create();
    expect(SnapshotInfoSchema.parse(info)).toEqual(info);
    // Written after the snapshot: must not be in it.
    storage.tasks.create({ title: 'Later', input: { question: 'q' } });

    const bytes = readAll(store, info.snapshotId, 4096);
    expect(bytes.length).toBe(info.sizeBytes);
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    expect([bytes[18], bytes[19]]).toEqual([1, 1]); // not WAL: opens as a plain file

    const file = join(dir, info.fileName);
    writeFileSync(file, bytes);
    const copy = openStorage({ path: file });
    expect(copy.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copy.tasks.require(task.id).title).toBe('Snapshot me');
    expect(copy.inspect.taskStatusCounts()).toMatchObject({ total: 1 });
    copy.close();
    storage.close();
  });

  it('returns null for an unknown or expired snapshot, and reads extend its life', () => {
    let time = 0;
    const store = createSnapshotStore({
      serialize: () => Buffer.from('SQLite format 3\0'.padEnd(64, 'x')),
      now: () => time,
      ttlMs: 1000,
    });
    const { snapshotId } = store.create();
    expect(store.read({ snapshotId: crypto.randomUUID(), offset: 0, length: 10 })).toBeNull();
    time = 900;
    expect(store.read({ snapshotId, offset: 0, length: 10 })).not.toBeNull();
    time = 1800; // within 1000 ms of the last read
    expect(store.read({ snapshotId, offset: 60, length: 10 })).toMatchObject({ eof: true });
    time = 2900;
    expect(store.read({ snapshotId, offset: 0, length: 10 })).toBeNull();
  });

  it('keeps at most two snapshots and refuses databases over the limit', () => {
    const store = createSnapshotStore({ serialize: () => Buffer.alloc(100), maxBytes: 200 });
    const first = store.create();
    store.create();
    store.create();
    expect(store.read({ snapshotId: first.snapshotId, offset: 0, length: 1 })).toBeNull();
    const big = createSnapshotStore({ serialize: () => Buffer.alloc(300), maxBytes: 200 });
    expect(() => big.create()).toThrow(/limited to 200 bytes/);
  });
});
