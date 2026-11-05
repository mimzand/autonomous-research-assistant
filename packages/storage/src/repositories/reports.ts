import { and, desc, eq, inArray, max } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { StorageError } from '../errors.js';
import { reports, sources, type ReportRecord } from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { parseInput } from '../validation.js';

const CreateReportSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  content: z.string().max(2_000_000),
  citedSourceIds: z.array(z.string().min(1)).max(1000).default([]),
});
export type CreateReportInput = z.input<typeof CreateReportSchema>;

export function createReportRepository(db: Executor, ctx: StorageContext) {
  return {
    /**
     * Stores a new report version for a task. Every cited id must be a
     * source recorded for that task: reports can never cite invented sources.
     */
    create(taskId: string, input: CreateReportInput): ReportRecord {
      const data = parseInput(CreateReportSchema, input, 'report');
      const cited = [...new Set(data.citedSourceIds)];

      if (cited.length) {
        const known = db
          .select({ id: sources.id })
          .from(sources)
          .where(and(eq(sources.taskId, taskId), inArray(sources.id, cited)))
          .all()
          .map((row) => row.id);
        const unknown = cited.filter((id) => !known.includes(id));
        if (unknown.length) {
          throw new StorageError(
            'invalid-input',
            `Report cites sources that are not recorded for this task: ${unknown.join(', ')}`,
          );
        }
      }

      const last = db
        .select({ version: max(reports.version) })
        .from(reports)
        .where(eq(reports.taskId, taskId))
        .get();
      const now = ctx.now();
      return guarded('Create report', () =>
        db
          .insert(reports)
          .values({
            id: ctx.newId(),
            taskId,
            version: (last?.version ?? 0) + 1,
            title: data.title,
            format: 'markdown',
            content: data.content,
            citedSourceIds: cited,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get(),
      );
    },

    get(id: string): ReportRecord | undefined {
      return db.select().from(reports).where(eq(reports.id, id)).get();
    },

    latest(taskId: string): ReportRecord | undefined {
      return db
        .select()
        .from(reports)
        .where(eq(reports.taskId, taskId))
        .orderBy(desc(reports.version))
        .limit(1)
        .get();
    },

    /** Newest version first. */
    listByTask(taskId: string): ReportRecord[] {
      return db
        .select()
        .from(reports)
        .where(eq(reports.taskId, taskId))
        .orderBy(desc(reports.version))
        .all();
    },

    delete(id: string): boolean {
      return db.delete(reports).where(eq(reports.id, id)).run().changes > 0;
    },
  };
}

export type ReportRepository = ReturnType<typeof createReportRepository>;
