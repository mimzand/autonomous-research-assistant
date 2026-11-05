import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { StorageError } from '../errors.js';
import { sourceContents, sources, type SourceContentRecord, type SourceRecord } from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { JsonValueSchema, parseInput } from '../validation.js';

/** 5 MB of extracted text per source is plenty; larger pages are truncated upstream. */
export const MAX_SOURCE_TEXT_BYTES = 5 * 1024 * 1024;

const AddSourceSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  title: z.string().trim().max(1000).optional(),
  retrievedAt: z.iso.datetime().optional(),
  metadata: JsonValueSchema.optional(),
});
export type AddSourceInput = z.input<typeof AddSourceSchema>;

const ContentSchema = z.strictObject({
  contentType: z.string().trim().min(1).max(100),
  text: z.string().refine((t) => Buffer.byteLength(t, 'utf8') <= MAX_SOURCE_TEXT_BYTES, {
    message: `Text exceeds ${MAX_SOURCE_TEXT_BYTES} bytes.`,
  }),
});
export type SourceContentInput = z.input<typeof ContentSchema>;

export function createSourceRepository(db: Executor, ctx: StorageContext) {
  return {
    /** Adds a source to a task, or updates title/metadata if the URL is already recorded. */
    add(taskId: string, input: AddSourceInput): SourceRecord {
      const data = parseInput(AddSourceSchema, input, 'source');
      const now = ctx.now();
      return guarded('Add source', () =>
        db
          .insert(sources)
          .values({
            id: ctx.newId(),
            taskId,
            url: data.url,
            title: data.title ?? null,
            retrievedAt: data.retrievedAt ?? null,
            metadata: data.metadata ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [sources.taskId, sources.url],
            set: {
              ...(data.title !== undefined && { title: data.title }),
              ...(data.retrievedAt !== undefined && { retrievedAt: data.retrievedAt }),
              ...(data.metadata !== undefined && { metadata: data.metadata }),
              updatedAt: now,
            },
          })
          .returning()
          .get(),
      );
    },

    get(id: string): SourceRecord | undefined {
      return db.select().from(sources).where(eq(sources.id, id)).get();
    },

    listByTask(taskId: string): SourceRecord[] {
      return db
        .select()
        .from(sources)
        .where(eq(sources.taskId, taskId))
        .orderBy(asc(sources.createdAt), asc(sources.id))
        .all();
    },

    /** Stores (or replaces) the extracted text of a source. */
    setContent(sourceId: string, input: SourceContentInput): SourceContentRecord {
      const data = parseInput(ContentSchema, input, 'source content');
      const now = ctx.now();
      const sha256 = createHash('sha256').update(data.text, 'utf8').digest('hex');
      const byteLength = Buffer.byteLength(data.text, 'utf8');
      return guarded('Store source content', () =>
        db
          .insert(sourceContents)
          .values({
            id: ctx.newId(),
            sourceId,
            contentType: data.contentType,
            text: data.text,
            byteLength,
            sha256,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: sourceContents.sourceId,
            set: {
              contentType: data.contentType,
              text: data.text,
              byteLength,
              sha256,
              updatedAt: now,
            },
          })
          .returning()
          .get(),
      );
    },

    /** The task's source with exactly this URL (callers pass the canonical form). */
    findByUrl(taskId: string, url: string): SourceRecord | undefined {
      return db
        .select()
        .from(sources)
        .where(and(eq(sources.taskId, taskId), eq(sources.url, url)))
        .get();
    },

    /** The task's source whose stored text has this SHA-256 (duplicate content). */
    findByContentHash(taskId: string, sha256: string): SourceRecord | undefined {
      const row = db
        .select({ source: sources })
        .from(sources)
        .innerJoin(sourceContents, eq(sourceContents.sourceId, sources.id))
        .where(and(eq(sources.taskId, taskId), eq(sourceContents.sha256, sha256.toLowerCase())))
        .orderBy(asc(sources.createdAt), asc(sources.id))
        .get();
      return row?.source;
    },

    getContent(sourceId: string): SourceContentRecord | undefined {
      return db.select().from(sourceContents).where(eq(sourceContents.sourceId, sourceId)).get();
    },

    delete(id: string): boolean {
      return db.delete(sources).where(eq(sources.id, id)).run().changes > 0;
    },

    require(id: string): SourceRecord {
      const source = db.select().from(sources).where(eq(sources.id, id)).get();
      if (!source) throw new StorageError('not-found', `Source ${id} not found.`);
      return source;
    },
  };
}

export type SourceRepository = ReturnType<typeof createSourceRepository>;
