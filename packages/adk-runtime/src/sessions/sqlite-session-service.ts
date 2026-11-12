/**
 * Durable ADK session service backed by the app's SQLite database
 * (`@rka/storage`, migration 0002).
 *
 * Mirrors the semantics of ADK 2.4.0's own `DatabaseSessionService`, with
 * these deliberate differences:
 *
 * - `listSessions` requires `userId`: one user's sessions are never listed
 *   together with another user's.
 * - A concurrent (stale) write is always rejected with ADK's
 *   `StaleSessionError`; there is no "last write wins" mode.
 * - The stored update time is strictly increasing, so a stale writer is
 *   detected even when two events share a millisecond.
 * - Ids, event sizes, state sizes and history reads are bounded.
 *
 * Partial (streaming) events are never stored: ADK's Runner does not append
 * them, and this service ignores them if it is asked to.
 */
import { randomUUID } from 'node:crypto';
import {
  ADK_STORAGE_LIMITS,
  isStorageError,
  type AdkEventRecord,
  type AdkSessionRepository,
  type AdkStateDeltas,
  type JsonValue,
} from '@rka/storage';
import { z } from 'zod';
import {
  type AppendEventRequest,
  BaseSessionService,
  type CreateSessionRequest,
  createEvent,
  type DeleteSessionRequest,
  type Event,
  type GetSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type Session,
  State,
} from '../adk.js';

export interface SqliteSessionServiceOptions {
  /** `storage.adkSessions` from `openStorage()`. */
  readonly repository: AdkSessionRepository;
  /** Clock (epoch ms). Injected in tests. */
  readonly now?: () => number;
  /** Session id generator when the caller gives none. */
  readonly newId?: () => string;
}

/**
 * Thrown when a write loses an optimistic-concurrency race. Compatible with
 * ADK's own `StaleSessionError`: ADK's `isStaleSessionError()` recognises it
 * (by name), so ADK code and callers handle it the same way. Defined here
 * because importing ADK's class would bundle ADK's database session service,
 * code executors and LocalEnvironment (see adk.ts).
 */
export class StaleSessionError extends Error {
  override readonly name = 'StaleSessionError';
}

/** Same check as ADK's `isStaleSessionError` (which matches by name). */
export function isStaleSessionError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'StaleSessionError';
}

/** Thrown when stored data cannot be turned back into ADK objects. */
export class SessionDataError extends Error {
  override readonly name = 'SessionDataError';
}

type JsonObject = Record<string, JsonValue>;

/** The minimal shape every stored event must have before it is handed to ADK. */
const StoredEventSchema = z.looseObject({
  id: z.string().min(1),
  invocationId: z.string(),
  timestamp: z.number(),
  author: z.string().optional(),
  content: z
    .looseObject({ role: z.string().optional(), parts: z.array(z.looseObject({})).optional() })
    .optional(),
  actions: z.looseObject({}).optional(),
  partial: z.literal(false).optional(),
});

export class SqliteSessionService extends BaseSessionService {
  readonly #repo: AdkSessionRepository;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(options: SqliteSessionServiceOptions) {
    super();
    this.#repo = options.repository;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
  }

  createSession({ appName, userId, state, sessionId }: CreateSessionRequest): Promise<Session> {
    return run(() => {
      const id = sessionId?.trim() ? sessionId.trim() : this.#newId();
      const stored = this.#repo.create({
        key: { appName, userId, sessionId: id },
        deltas: splitState(toJsonObject(state ?? {}, 'session state')),
        nowMs: this.#now(),
      });
      return {
        id,
        appName,
        userId,
        state: mergeStates(stored.appState, stored.userState, stored.session.state),
        events: [],
        lastUpdateTime: stored.session.updateTimeMs,
      };
    });
  }

  getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    return run(() => {
      const loaded = this.#repo.get(
        { appName, userId, sessionId },
        {
          // As in ADK's services, 0 / undefined mean "no filter".
          ...(config?.numRecentEvents && { numRecentEvents: config.numRecentEvents }),
          ...(config?.afterTimestamp && { afterTimestampMs: config.afterTimestamp }),
        },
      );
      if (!loaded) return undefined;
      return {
        id: sessionId,
        appName,
        userId,
        state: mergeStates(loaded.appState, loaded.userState, loaded.session.state),
        events: loaded.events.map(restoreEvent),
        lastUpdateTime: loaded.session.updateTimeMs,
      };
    });
  }

  listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    return run(() => {
      if (!userId) {
        throw new Error('SqliteSessionService.listSessions requires a userId.');
      }
      if (page !== undefined && (limit === undefined || !Number.isInteger(page) || page < 1)) {
        throw new Error('listSessions: `page` must be a positive integer and requires `limit`.');
      }
      const effectiveOffset =
        page !== undefined && limit !== undefined ? (page - 1) * limit : (offset ?? 0);
      const result = this.#repo.list({
        appName,
        userId,
        ...(limit !== undefined && { limit }),
        offset: effectiveOffset,
        ...(order && { order }),
      });
      const sessions = result.sessions.map((s) => ({
        id: s.id,
        appName,
        userId,
        state: mergeStates(result.appState, result.userState, s.state),
        events: [],
        lastUpdateTime: s.updateTimeMs,
      }));
      const pageSize = limit ?? Math.min(result.totalItems, ADK_STORAGE_LIMITS.maxListLimit);
      return {
        sessions,
        page: limit ? Math.floor(effectiveOffset / limit) + 1 : 1,
        limit: pageSize,
        totalItems: result.totalItems,
        totalPages: pageSize === 0 ? 0 : Math.ceil(result.totalItems / pageSize),
      };
    });
  }

  deleteSession({ appName, userId, sessionId }: DeleteSessionRequest): Promise<void> {
    return run(() => {
      this.#repo.delete({ appName, userId, sessionId });
    });
  }

  /**
   * Stores the event and its state delta in one transaction, then updates the
   * caller's in-memory session. If storing fails, the in-memory session is
   * left exactly as it was.
   */
  override async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
    if (event.partial) return event;
    const { stored, deltas } = serialiseEvent(event);
    let result;
    try {
      result = this.#repo.appendEvent({
        key: { appName: session.appName, userId: session.userId, sessionId: session.id },
        expectedUpdateTimeMs: session.lastUpdateTime,
        event: {
          id: event.id,
          invocationId: event.invocationId,
          author: event.author ?? null,
          timestampMs: Math.floor(event.timestamp),
          data: stored,
        },
        deltas,
      });
    } catch (error) {
      if (isStorageError(error) && error.code === 'conflict') {
        throw new StaleSessionError(
          `Session ${session.id} was changed by another writer since it was loaded. Reload it and retry.`,
        );
      }
      throw error;
    }
    // ADK's own bookkeeping on the in-memory copy (drops temp: keys from the
    // event, upserts it into session.events by id).
    await super.appendEvent({ session, event });
    // The stored state is authoritative (it includes other sessions' app/user writes).
    session.state = mergeStates(result.appState, result.userState, result.session.state);
    session.lastUpdateTime = result.session.updateTimeMs;
    return event;
  }
}

/** Runs a synchronous storage call as a promise (errors become rejections). */
function run<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Splits ADK state keys into app/user/session scopes; drops temp: keys. */
export function splitState(state: JsonObject): Required<AdkStateDeltas> {
  const deltas = { app: {} as JsonObject, user: {} as JsonObject, session: {} as JsonObject };
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(State.APP_PREFIX)) deltas.app[key.slice(State.APP_PREFIX.length)] = value;
    else if (key.startsWith(State.USER_PREFIX))
      deltas.user[key.slice(State.USER_PREFIX.length)] = value;
    else if (!key.startsWith(State.TEMP_PREFIX)) deltas.session[key] = value;
  }
  return deltas;
}

/** ADK's mergeStates: session keys as-is, app and user keys with their prefixes. */
export function mergeStates(
  app: JsonObject,
  user: JsonObject,
  session: JsonObject,
): Record<string, unknown> {
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(session)) merged[k] = structuredClone(v);
  for (const [k, v] of Object.entries(app)) merged[State.APP_PREFIX + k] = structuredClone(v);
  for (const [k, v] of Object.entries(user)) merged[State.USER_PREFIX + k] = structuredClone(v);
  return { ...merged };
}

/**
 * The event as plain JSON data, without temp: state keys, plus its split
 * state delta. JSON is ADK's own storage format (DatabaseSessionService stores
 * `JSON.stringify(event)`); values that JSON cannot represent are refused
 * rather than silently changed.
 */
export function serialiseEvent(event: Event): {
  stored: JsonObject;
  deltas: Required<AdkStateDeltas>;
} {
  const stateDelta = event.actions.stateDelta;
  const delta = toJsonObject(stateDelta, 'state delta');
  const actions = { ...event.actions, stateDelta: withoutTemp(delta) };
  const stored = toJsonObject({ ...event, actions }, 'event');
  return { stored, deltas: splitState(delta) };
}

/** Rebuilds an ADK event from stored JSON with ADK's own factory. */
export function restoreEvent(record: AdkEventRecord): Event {
  const parsed = StoredEventSchema.safeParse(record.event);
  if (!parsed.success || parsed.data.id !== record.id) {
    throw new SessionDataError(
      `Stored event ${record.id} (seq ${String(record.seq)}) is malformed.`,
    );
  }
  return createEvent(parsed.data as Parameters<typeof createEvent>[0]);
}

function withoutTemp(state: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(state).filter(([k]) => !k.startsWith(State.TEMP_PREFIX)),
  );
}

function toJsonObject(value: unknown, what: string): JsonObject {
  const problem = findNonJson(value, what);
  if (problem) throw new SessionDataError(`Cannot store ${problem}.`);
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Finds values JSON.stringify would silently drop or change (functions, NaN, Dates, bigint...). */
function findNonJson(value: unknown, path: string, depth = 0): string | undefined {
  if (depth > 64) return `${path}: nesting is too deep`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (value === undefined) return undefined; // Omitted, as in ADK's own JSON storage.
  if (typeof value === 'number')
    return Number.isFinite(value) ? undefined : `${path}: non-finite number`;
  if (typeof value !== 'object') return `${path}: ${typeof value} value`;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      if (item === undefined) return `${path}[${String(i)}]: undefined array item`;
      const p = findNonJson(item, `${path}[${String(i)}]`, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return `${path}: non-plain object`;
  for (const [k, v] of Object.entries(value)) {
    const p = findNonJson(v, `${path}.${k}`, depth + 1);
    if (p) return p;
  }
  return undefined;
}
