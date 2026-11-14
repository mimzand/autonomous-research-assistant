import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { StorageError } from '../errors.js';
import {
  adkAppState,
  adkEvents,
  adkSessions,
  adkUserState,
  type AdkEventRecord,
  type AdkSessionRecord,
  type JsonValue,
} from '../schema.js';
import { guarded } from '../sqlite-errors.js';
import { JsonValueSchema, parseInput } from '../validation.js';

/*
 * Storage for Google ADK sessions (migration 0002). ADK-agnostic: it stores
 * already-serialised events and already-split state deltas; the adk-runtime
 * package maps ADK semantics onto these primitives.
 *
 * Every read and write is scoped by (app name, user id, session id): a session
 * id alone never finds anything. Every write that touches more than one row
 * runs in one transaction.
 */

/** Size and count limits. Exceeding one is an `invalid-input` error, never a silent truncation. */
export const ADK_STORAGE_LIMITS = Object.freeze({
  /** One serialised event. */
  maxEventBytes: 1_048_576,
  /** Events stored per session (bounds every history read). */
  maxEventsPerSession: 10_000,
  /** One state scope (session, user or app) as JSON. */
  maxStateBytes: 1_048_576,
  /** Sessions returned by one list call. */
  maxListLimit: 500,
});

/** App names, user ids and session ids: no paths, wildcards or whitespace. */
export const AdkKeyPartSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, 'Use letters, digits and . _ : @ - only.');

const KeySchema = z.strictObject({
  appName: AdkKeyPartSchema,
  userId: AdkKeyPartSchema,
  sessionId: AdkKeyPartSchema,
});
export type AdkSessionKey = z.input<typeof KeySchema>;

type JsonObject = Record<string, JsonValue>;

const StateSchema = z
  .record(z.string(), JsonValueSchema)
  .refine((s) => Buffer.byteLength(JSON.stringify(s)) <= ADK_STORAGE_LIMITS.maxStateBytes, {
    message: `State exceeds ${ADK_STORAGE_LIMITS.maxStateBytes} bytes.`,
  });

const DeltasSchema = z.strictObject({
  app: StateSchema.default({}),
  user: StateSchema.default({}),
  session: StateSchema.default({}),
});
export type AdkStateDeltas = z.input<typeof DeltasSchema>;

const EventInputSchema = z.strictObject({
  id: z.string().min(1).max(256),
  invocationId: z.string().max(256),
  author: z.string().max(256).nullable(),
  timestampMs: z.number().int().nonnegative(),
  /** The event as plain JSON data. */
  data: z.record(z.string(), JsonValueSchema),
});

const ReadOptionsSchema = z.strictObject({
  /** Only the most recent N events (ADK `numRecentEvents`). */
  numRecentEvents: z.int().min(1).max(ADK_STORAGE_LIMITS.maxEventsPerSession).optional(),
  /** Only events with a timestamp after this (ADK `afterTimestamp`, epoch ms). */
  afterTimestampMs: z.number().nonnegative().optional(),
});

const ListSchema = z.strictObject({
  appName: AdkKeyPartSchema,
  userId: AdkKeyPartSchema,
  limit: z.int().min(0).max(ADK_STORAGE_LIMITS.maxListLimit).optional(),
  offset: z.int().min(0).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export interface AdkStoredSession {
  readonly session: AdkSessionRecord;
  readonly appState: JsonObject;
  readonly userState: JsonObject;
}

export interface AdkLoadedSession extends AdkStoredSession {
  /** In append order. */
  readonly events: readonly AdkEventRecord[];
}

export interface AdkAppendResult {
  readonly session: AdkSessionRecord;
  readonly appState: JsonObject;
  readonly userState: JsonObject;
  /** False when an identical event with the same id was already stored (idempotent re-append). */
  readonly changed: boolean;
}

export function createAdkSessionRepository(db: Executor, ctx: StorageContext) {
  const sessionWhere = (k: z.output<typeof KeySchema>) =>
    and(
      eq(adkSessions.appName, k.appName),
      eq(adkSessions.userId, k.userId),
      eq(adkSessions.id, k.sessionId),
    );

  function appState(tx: Executor, appName: string): JsonObject {
    return tx.select().from(adkAppState).where(eq(adkAppState.appName, appName)).get()?.state ?? {};
  }
  function userState(tx: Executor, appName: string, userId: string): JsonObject {
    return (
      tx
        .select()
        .from(adkUserState)
        .where(and(eq(adkUserState.appName, appName), eq(adkUserState.userId, userId)))
        .get()?.state ?? {}
    );
  }

  /** Merges a delta into a shared state row (insert or update) and returns the new state. */
  function mergeApp(tx: Executor, appName: string, delta: JsonObject, now: string): JsonObject {
    const current = appState(tx, appName);
    if (Object.keys(delta).length === 0) return current;
    const next = checkedState({ ...current, ...delta }, 'app');
    tx.insert(adkAppState)
      .values({ appName, state: next, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: adkAppState.appName, set: { state: next, updatedAt: now } })
      .run();
    return next;
  }
  function mergeUser(
    tx: Executor,
    appName: string,
    userId: string,
    delta: JsonObject,
    now: string,
  ): JsonObject {
    const current = userState(tx, appName, userId);
    if (Object.keys(delta).length === 0) return current;
    const next = checkedState({ ...current, ...delta }, 'user');
    tx.insert(adkUserState)
      .values({ appName, userId, state: next, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [adkUserState.appName, adkUserState.userId],
        set: { state: next, updatedAt: now },
      })
      .run();
    return next;
  }

  return {
    /** Creates a session. Fails with `conflict` if the scoped id already exists. */
    create(input: {
      key: AdkSessionKey;
      deltas?: AdkStateDeltas;
      nowMs: number;
    }): AdkStoredSession {
      const key = parseInput(KeySchema, input.key, 'ADK session key');
      const deltas = parseInput(DeltasSchema, input.deltas ?? {}, 'ADK session state');
      const now = ctx.now();
      return guarded('Create ADK session', () =>
        db.transaction((tx) => {
          const app = mergeApp(tx, key.appName, deltas.app, now);
          const user = mergeUser(tx, key.appName, key.userId, deltas.user, now);
          const session = tx
            .insert(adkSessions)
            .values({
              appName: key.appName,
              userId: key.userId,
              id: key.sessionId,
              state: deltas.session,
              updateTimeMs: input.nowMs,
              eventCount: 0,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
          return { session, appState: app, userState: user };
        }),
      );
    },

    /** Loads a session with its events (append order). Undefined if it does not exist in this scope. */
    get(
      keyInput: AdkSessionKey,
      options: z.input<typeof ReadOptionsSchema> = {},
    ): AdkLoadedSession | undefined {
      const key = parseInput(KeySchema, keyInput, 'ADK session key');
      const read = parseInput(ReadOptionsSchema, options, 'ADK session read options');
      // One read transaction: session, events and shared state from the same snapshot.
      return db.transaction((tx) => {
        const session = tx.select().from(adkSessions).where(sessionWhere(key)).get();
        if (!session) return undefined;
        const conditions = [
          eq(adkEvents.appName, key.appName),
          eq(adkEvents.userId, key.userId),
          eq(adkEvents.sessionId, key.sessionId),
          ...(read.afterTimestampMs !== undefined
            ? [gt(adkEvents.timestampMs, read.afterTimestampMs)]
            : []),
        ];
        const query = tx
          .select()
          .from(adkEvents)
          .where(and(...conditions))
          .orderBy(desc(adkEvents.seq))
          .limit(read.numRecentEvents ?? ADK_STORAGE_LIMITS.maxEventsPerSession);
        const events = query.all().reverse();
        return {
          session,
          events,
          appState: appState(tx, key.appName),
          userState: userState(tx, key.appName, key.userId),
        };
      });
    },

    /** Sessions of one user in one app (no events), with pagination. */
    list(input: z.input<typeof ListSchema>): {
      readonly sessions: readonly AdkSessionRecord[];
      readonly totalItems: number;
      readonly appState: JsonObject;
      readonly userState: JsonObject;
    } {
      const q = parseInput(ListSchema, input, 'ADK session list');
      return db.transaction((tx) => {
        const where = and(eq(adkSessions.appName, q.appName), eq(adkSessions.userId, q.userId));
        const totalItems = tx.select({ n: count() }).from(adkSessions).where(where).get()?.n ?? 0;
        const order =
          q.order === 'asc'
            ? [asc(adkSessions.updateTimeMs), asc(adkSessions.id)]
            : q.order === 'desc'
              ? [desc(adkSessions.updateTimeMs), asc(adkSessions.id)]
              : [asc(adkSessions.createdAt), asc(adkSessions.id)];
        const sessions = tx
          .select()
          .from(adkSessions)
          .where(where)
          .orderBy(...order)
          .limit(q.limit ?? ADK_STORAGE_LIMITS.maxListLimit)
          .offset(q.offset ?? 0)
          .all();
        return {
          sessions,
          totalItems,
          appState: appState(tx, q.appName),
          userState: userState(tx, q.appName, q.userId),
        };
      });
    },

    /** Deletes one scoped session and (cascade) its events. Shared app/user state is kept. */
    delete(keyInput: AdkSessionKey): boolean {
      const key = parseInput(KeySchema, keyInput, 'ADK session key');
      return guarded(
        'Delete ADK session',
        () => db.delete(adkSessions).where(sessionWhere(key)).run().changes > 0,
      );
    },

    /**
     * Stores one event and applies its state deltas atomically.
     *
     * - Optimistic concurrency: fails with `conflict` if the stored session was
     *   updated after `expectedUpdateTimeMs` (the caller's copy is stale), so
     *   two writers can never silently overwrite each other.
     * - Idempotent: an identical event with the same id is a no-op; a changed
     *   event with the same id replaces the stored one in place (ADK upsert
     *   semantics) and keeps its position.
     */
    appendEvent(input: {
      key: AdkSessionKey;
      expectedUpdateTimeMs: number;
      event: z.input<typeof EventInputSchema>;
      deltas: AdkStateDeltas;
    }): AdkAppendResult {
      const key = parseInput(KeySchema, input.key, 'ADK session key');
      const event = parseInput(EventInputSchema, input.event, 'ADK event');
      const deltas = parseInput(DeltasSchema, input.deltas, 'ADK state delta');
      const serialised = JSON.stringify(event.data);
      const byteLength = Buffer.byteLength(serialised);
      if (byteLength > ADK_STORAGE_LIMITS.maxEventBytes) {
        throw new StorageError(
          'invalid-input',
          `ADK event exceeds ${ADK_STORAGE_LIMITS.maxEventBytes} bytes.`,
        );
      }
      const now = ctx.now();

      return guarded('Append ADK event', () =>
        db.transaction((tx) => {
          const session = tx.select().from(adkSessions).where(sessionWhere(key)).get();
          if (!session)
            throw new StorageError('not-found', `ADK session ${key.sessionId} was not found.`);
          if (session.updateTimeMs > input.expectedUpdateTimeMs) {
            throw new StorageError(
              'conflict',
              `ADK session ${key.sessionId} was modified by another writer (stale session). Reload it and retry.`,
            );
          }

          const existing = tx
            .select()
            .from(adkEvents)
            .where(
              and(
                eq(adkEvents.appName, key.appName),
                eq(adkEvents.userId, key.userId),
                eq(adkEvents.sessionId, key.sessionId),
                eq(adkEvents.id, event.id),
              ),
            )
            .get();
          if (existing && JSON.stringify(existing.event) === serialised) {
            return {
              session,
              appState: appState(tx, key.appName),
              userState: userState(tx, key.appName, key.userId),
              changed: false,
            };
          }

          const app = mergeApp(tx, key.appName, deltas.app, now);
          const user = mergeUser(tx, key.appName, key.userId, deltas.user, now);
          const nextState = checkedState({ ...session.state, ...deltas.session }, 'session');

          if (existing) {
            tx.update(adkEvents)
              .set({
                invocationId: event.invocationId,
                author: event.author,
                timestampMs: event.timestampMs,
                event: event.data,
                byteLength,
                updatedAt: now,
              })
              .where(
                and(
                  eq(adkEvents.appName, key.appName),
                  eq(adkEvents.userId, key.userId),
                  eq(adkEvents.sessionId, key.sessionId),
                  eq(adkEvents.id, event.id),
                ),
              )
              .run();
          } else {
            if (session.eventCount >= ADK_STORAGE_LIMITS.maxEventsPerSession) {
              throw new StorageError(
                'invalid-input',
                `ADK session ${key.sessionId} reached ${ADK_STORAGE_LIMITS.maxEventsPerSession} events.`,
              );
            }
            tx.insert(adkEvents)
              .values({
                appName: key.appName,
                userId: key.userId,
                sessionId: key.sessionId,
                id: event.id,
                seq: session.eventCount + 1,
                invocationId: event.invocationId,
                author: event.author,
                timestampMs: event.timestampMs,
                event: event.data,
                byteLength,
                createdAt: now,
                updatedAt: now,
              })
              .run();
          }

          const updated = tx
            .update(adkSessions)
            .set({
              state: nextState,
              // Strictly increasing: every stored change moves the version
              // forward (even two events in the same millisecond, or an event
              // with an older timestamp), so a writer holding an older copy is
              // always detected as stale.
              updateTimeMs: Math.max(session.updateTimeMs + 1, event.timestampMs),
              eventCount: existing ? session.eventCount : sql`${adkSessions.eventCount} + 1`,
              updatedAt: now,
            })
            .where(sessionWhere(key))
            .returning()
            .get();
          return { session: updated, appState: app, userState: user, changed: true };
        }),
      );
    },
  };
}

function checkedState(state: JsonObject, scope: string): JsonObject {
  if (Buffer.byteLength(JSON.stringify(state)) > ADK_STORAGE_LIMITS.maxStateBytes) {
    throw new StorageError(
      'invalid-input',
      `ADK ${scope} state exceeds ${ADK_STORAGE_LIMITS.maxStateBytes} bytes.`,
    );
  }
  return state;
}

export type AdkSessionRepository = ReturnType<typeof createAdkSessionRepository>;
