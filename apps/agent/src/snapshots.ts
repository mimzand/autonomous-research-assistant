import { randomUUID } from 'node:crypto';
import { type z } from 'zod';
import {
  type ReadSnapshotRequestSchema,
  type SnapshotChunkSchema,
  type SnapshotInfoSchema,
} from '@rka/agent-protocol';

/*
 * Backup as a download (agent Web API): clients without a desktop shell have no save
 * dialog, so the agent hands out a consistent copy of the database instead. The copy
 * is SQLite's serialize() of the live database (one read transaction, WAL content
 * included), held in memory for a few minutes and read back in chunks. The agent
 * writes no file and deletes none; the client decides where the bytes go.
 */

type SnapshotInfo = z.infer<typeof SnapshotInfoSchema>;
type ReadSnapshotRequest = z.infer<typeof ReadSnapshotRequestSchema>;
type SnapshotChunk = z.infer<typeof SnapshotChunkSchema>;

export const SNAPSHOT_TTL_MS = 10 * 60_000;
export const MAX_SNAPSHOTS = 2;
export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;

export interface SnapshotStore {
  create(): SnapshotInfo;
  /** A chunk of a snapshot; `null` when it is unknown or expired. Each read extends its life. */
  read(request: ReadSnapshotRequest): SnapshotChunk | null;
}

interface Held {
  readonly info: SnapshotInfo;
  readonly bytes: Buffer;
  expiresAt: number;
}

export function createSnapshotStore(deps: {
  /** better-sqlite3 `Database#serialize()` of the live database. */
  readonly serialize: () => Buffer;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxBytes?: number;
}): SnapshotStore {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? SNAPSHOT_TTL_MS;
  const maxBytes = deps.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const held = new Map<string, Held>();

  const prune = () => {
    for (const [id, snapshot] of held) if (snapshot.expiresAt <= now()) held.delete(id);
  };

  return {
    create() {
      prune();
      const bytes = deps.serialize();
      if (bytes.length > maxBytes) {
        throw new Error(
          `The database is ${bytes.length} bytes; downloads are limited to ${maxBytes} bytes. Use the desktop app's backup.`,
        );
      }
      // A standalone file: mark the header as rollback-journal (not WAL), as a backup is.
      if (bytes.length >= 20) {
        bytes[18] = 1;
        bytes[19] = 1;
      }
      while (held.size >= MAX_SNAPSHOTS) {
        const oldest = held.keys().next().value;
        if (oldest === undefined) break;
        held.delete(oldest);
      }
      const createdAt = new Date(now()).toISOString();
      const info: SnapshotInfo = {
        snapshotId: randomUUID(),
        fileName: `research-${createdAt.replace(/[:.]/g, '-')}.db`,
        sizeBytes: bytes.length,
        createdAt,
      };
      held.set(info.snapshotId, { info, bytes, expiresAt: now() + ttlMs });
      return info;
    },

    read({ snapshotId, offset, length }) {
      prune();
      const snapshot = held.get(snapshotId);
      if (!snapshot) return null;
      snapshot.expiresAt = now() + ttlMs;
      const start = Math.min(offset, snapshot.bytes.length);
      const end = Math.min(start + length, snapshot.bytes.length);
      return {
        offset: start,
        dataBase64: snapshot.bytes.subarray(start, end).toString('base64'),
        eof: end >= snapshot.bytes.length,
      };
    },
  };
}
