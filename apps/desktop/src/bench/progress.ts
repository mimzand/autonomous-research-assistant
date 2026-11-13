/**
 * Append-only JSONL progress log for the benchmark (phase 7.2).
 *
 * Every record is one line, appended and fsync'ed immediately, so whatever was
 * completed before an unexpected termination (even a forced power-off, as far
 * as the disk allows) can be read back. Records are built from an allow-list
 * of numeric and enum fields only: no prompts, answers, source text, URLs,
 * paths, headers or error messages are ever written.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { z } from 'zod';

const num = z.number().finite().nullable();
const engine = z.enum(['legacy', 'adk']);
const step = z.enum(['plan', 'evidence', 'analyze', 'report', 'review', 'unknown']);

export const ProgressRecordSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('bench-start'),
    at: z.string(),
    mode: z.enum(['fake', 'live']),
    model: z.string().max(200),
    serverIsLocal: z.boolean(),
    tasks: z.int(),
    maxRequests: z.int(),
    maxCompletionTokens: z.int(),
    requestTimeoutMs: z.int(),
    taskTimeoutMs: z.int(),
    overallTimeoutMs: z.int(),
    cooldownMs: z.int(),
    modelRetries: z.int(),
  }),
  z.strictObject({
    type: z.literal('adk-load'),
    at: z.string(),
    wallMs: z.number().finite(),
    cpuUserMs: z.number().finite(),
    cpuSystemMs: z.number().finite(),
    cpuShare: z.number().finite(),
    fsReads: z.number().finite(),
    cachedCallMs: z.number().finite(),
  }),
  z.strictObject({
    type: z.literal('task-start'),
    at: z.string(),
    index: z.int(),
    engine,
    warmup: z.boolean(),
    run: z.int(),
  }),
  z.strictObject({
    type: z.literal('call'),
    at: z.string(),
    task: z.int(),
    engine,
    call: z.int(),
    step,
    ok: z.boolean(),
    /** An error code (enum-like), never a message. */
    errorCode: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .nullable(),
    wallMs: num,
    ollamaTotalMs: num,
    ollamaLoadMs: num,
    promptTokens: num,
    completionTokens: num,
  }),
  z.strictObject({
    type: z.literal('task-end'),
    at: z.string(),
    index: z.int(),
    engine,
    status: z.string().max(40),
    stopReason: z.string().max(60).nullable(),
    completedAllSteps: z.boolean(),
    taskMs: num,
    modelCalls: z.int(),
    modelAttempts: z.int(),
    retries: z.int(),
    chatRequests: z.int(),
    otherRequests: z.int(),
    promptTokens: num,
    completionTokens: num,
    ollamaTotalMs: num,
    rssMb: num,
    heapUsedMb: num,
    systemFreeMb: num,
  }),
  z.strictObject({
    type: z.literal('bench-end'),
    at: z.string(),
    complete: z.boolean(),
    stopReason: z.string().max(60).nullable(),
    tasksCompleted: z.int(),
    requests: z.int(),
    completionTokens: z.int(),
  }),
]);
export type ProgressRecord = z.infer<typeof ProgressRecordSchema>;

export interface ProgressLog {
  write(record: ProgressRecord): void;
  close(): void;
  /** Records written in this process (also kept when no file is used). */
  readonly records: readonly ProgressRecord[];
}

/** Opens (appends to) the JSONL file, or keeps records in memory only when `path` is null. */
export function openProgressLog(path: string | null): ProgressLog {
  const fd = path ? openSync(path, 'a') : null;
  const records: ProgressRecord[] = [];
  return {
    records,
    write(record) {
      const parsed = ProgressRecordSchema.parse(record); // allow-list: unknown fields are rejected
      records.push(parsed);
      if (fd !== null) {
        writeSync(fd, `${JSON.stringify(parsed)}\n`);
        fsyncSync(fd);
      }
    },
    close() {
      if (fd !== null) closeSync(fd);
    },
  };
}

export interface ProgressSummary {
  /** True only when a bench-end record with complete=true was written. */
  readonly complete: boolean;
  readonly started: boolean;
  readonly tasksStarted: number;
  readonly tasksEnded: number;
  readonly lastCompleted: {
    readonly task: number;
    readonly engine: string;
    readonly step: string;
  } | null;
  readonly unfinishedTask: number | null;
  readonly stopReason: string | null;
  readonly invalidLines: number;
}

/** Reads a progress file written by a run that may have ended abruptly. */
export function summarizeProgress(text: string): ProgressSummary {
  const records: ProgressRecord[] = [];
  let invalidLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = ProgressRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else invalidLines++;
    } catch {
      invalidLines++; // e.g. a line cut off by a power loss
    }
  }
  const starts = records.filter((r) => r.type === 'task-start');
  const ends = records.filter((r) => r.type === 'task-end');
  const lastCall = records.filter((r) => r.type === 'call' && r.ok).at(-1);
  const end = records.find((r) => r.type === 'bench-end');
  const endedIdx = new Set(ends.map((e) => e.index));
  const unfinished = starts.find((s) => !endedIdx.has(s.index));
  return {
    complete: end?.type === 'bench-end' && end.complete,
    started: records.some((r) => r.type === 'bench-start'),
    tasksStarted: starts.length,
    tasksEnded: ends.length,
    lastCompleted:
      lastCall?.type === 'call'
        ? { task: lastCall.task, engine: lastCall.engine, step: lastCall.step }
        : null,
    unfinishedTask: unfinished?.type === 'task-start' ? unfinished.index : null,
    stopReason:
      end?.type === 'bench-end' ? end.stopReason : end ? null : 'no bench-end record (terminated)',
    invalidLines,
  };
}

export function readProgress(path: string): ProgressSummary {
  return summarizeProgress(readFileSync(path, 'utf8'));
}
