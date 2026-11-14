import { afterEach, describe, expect, it } from 'vitest';
import { isStorageError } from '../errors.js';
import { openStorage, type Storage } from '../storage.js';
import { memoryStorage, tempDir } from '../testing.js';
import { type JsonValue } from '../schema.js';
import { ADK_STORAGE_LIMITS } from './adk-sessions.js';

const key = (sessionId = 's1', userId = 'u1', appName = 'app') => ({
  appName,
  userId,
  sessionId,
});
const ev = (id: string, timestampMs: number, extra: Record<string, JsonValue> = {}) => ({
  id,
  invocationId: 'inv-1',
  author: 'user',
  timestampMs,
  data: { id, timestamp: timestampMs, ...extra },
});
const noDelta = { app: {}, user: {}, session: {} };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isStorageError(error) ? error.code : 'not-a-storage-error';
  }
  return undefined;
}

let storage: Storage;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
function fresh(): Storage {
  storage = memoryStorage();
  cleanups.push(() => storage.close());
  return storage;
}

describe('ADK session repository', () => {
  it('creates and loads a session with split state; duplicate ids conflict', () => {
    const s = fresh();
    const created = s.adkSessions.create({
      key: key(),
      deltas: { app: { theme: 'dark' }, user: { name: 'M' }, session: { step: 1 } },
      nowMs: 1000,
    });
    expect(created.session).toMatchObject({ id: 's1', state: { step: 1 }, updateTimeMs: 1000 });
    expect(created.appState).toEqual({ theme: 'dark' });
    expect(created.userState).toEqual({ name: 'M' });
    expect(code(() => s.adkSessions.create({ key: key(), nowMs: 2000 }))).toBe('conflict');
    expect(s.adkSessions.get(key())).toMatchObject({
      session: { state: { step: 1 } },
      events: [],
      appState: { theme: 'dark' },
      userState: { name: 'M' },
    });
  });

  it('never finds a session outside its (app, user) scope', () => {
    const s = fresh();
    s.adkSessions.create({ key: key('s1', 'alice'), nowMs: 1 });
    expect(s.adkSessions.get(key('s1', 'bob'))).toBeUndefined();
    expect(s.adkSessions.get(key('s1', 'alice', 'other-app'))).toBeUndefined();
    expect(
      code(() =>
        s.adkSessions.appendEvent({
          key: key('s1', 'bob'),
          expectedUpdateTimeMs: 1,
          event: ev('e1', 2),
          deltas: noDelta,
        }),
      ),
    ).toBe('not-found');
    expect(s.adkSessions.delete(key('s1', 'bob'))).toBe(false);
    expect(s.adkSessions.get(key('s1', 'alice'))).toBeDefined();
  });

  it('rejects ids with wildcards, paths, whitespace or excessive length', () => {
    const s = fresh();
    for (const bad of ['', '%', 'a b', '../x', 'a/b', '*', 'x'.repeat(129), "a'b"]) {
      expect(
        code(() => s.adkSessions.get(key(bad))),
        bad,
      ).toBe('invalid-input');
      expect(
        code(() => s.adkSessions.get(key('s', bad))),
        bad,
      ).toBe('invalid-input');
    }
  });

  it('lists only one user’s sessions in one app, with pagination and no events', () => {
    const s = fresh();
    for (const [id, user, app] of [
      ['a', 'u1', 'app'],
      ['b', 'u1', 'app'],
      ['c', 'u1', 'app'],
      ['x', 'u2', 'app'],
      ['y', 'u1', 'other'],
    ] as const) {
      s.adkSessions.create({ key: key(id, user, app), nowMs: 1 });
    }
    const all = s.adkSessions.list({ appName: 'app', userId: 'u1' });
    expect(all.sessions.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(all.totalItems).toBe(3);
    const page = s.adkSessions.list({ appName: 'app', userId: 'u1', limit: 2, offset: 1 });
    expect(page.sessions.map((r) => r.id)).toEqual(['b', 'c']);
    expect(code(() => s.adkSessions.list({ appName: 'app', userId: 'u1', limit: 10_000 }))).toBe(
      'invalid-input',
    );
  });

  it('appends events in order, merges deltas atomically and advances the update time', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 100 });
    let t = 100;
    for (const id of ['e1', 'e2', 'e3']) {
      const result = s.adkSessions.appendEvent({
        key: key(),
        expectedUpdateTimeMs: t,
        event: ev(id, t + 1),
        deltas: { app: { [id]: 'a' }, user: { [id]: 'u' }, session: { last: id } },
      });
      t = result.session.updateTimeMs;
      expect(result.changed).toBe(true);
    }
    const loaded = s.adkSessions.get(key());
    expect(loaded?.events.map((e) => [e.id, e.seq])).toEqual([
      ['e1', 1],
      ['e2', 2],
      ['e3', 3],
    ]);
    expect(loaded?.session).toMatchObject({
      state: { last: 'e3' },
      eventCount: 3,
      updateTimeMs: 103,
    });
    expect(loaded?.appState).toEqual({ e1: 'a', e2: 'a', e3: 'a' });
    expect(loaded?.userState).toEqual({ e1: 'u', e2: 'u', e3: 'u' });
  });

  it('keeps append order even when timestamps go backwards', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 100 });
    s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 100,
      event: ev('late', 500),
      deltas: noDelta,
    });
    s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 500,
      event: ev('early', 200),
      deltas: noDelta,
    });
    const loaded = s.adkSessions.get(key());
    expect(loaded?.events.map((e) => e.id)).toEqual(['late', 'early']);
    expect(loaded?.session.updateTimeMs).toBe(501);
  });

  it('rejects a stale writer instead of silently overwriting (no last-write-wins)', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 100 });
    s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 100,
      event: ev('e1', 200),
      deltas: { session: { v: 1 } },
    });
    // A second writer still holding the copy from t=100.
    expect(
      code(() =>
        s.adkSessions.appendEvent({
          key: key(),
          expectedUpdateTimeMs: 100,
          event: ev('e2', 201),
          deltas: { session: { v: 2 } },
        }),
      ),
    ).toBe('conflict');
    const loaded = s.adkSessions.get(key());
    expect(loaded?.events.map((e) => e.id)).toEqual(['e1']);
    expect(loaded?.session.state).toEqual({ v: 1 });
  });

  it('detects a stale writer even when both events carry the same millisecond', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 100 });
    const first = s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 100,
      event: ev('e1', 100),
      deltas: { session: { owner: 'A' } },
    });
    expect(first.session.updateTimeMs).toBe(101);
    expect(
      code(() =>
        s.adkSessions.appendEvent({
          key: key(),
          expectedUpdateTimeMs: 100,
          event: ev('e2', 100),
          deltas: { session: { owner: 'B' } },
        }),
      ),
    ).toBe('conflict');
    expect(s.adkSessions.get(key())?.session.state).toEqual({ owner: 'A' });
  });

  it('does not duplicate an event re-appended with the same id; a changed one is replaced in place', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 100 });
    s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 100,
      event: ev('e1', 110),
      deltas: { session: { n: 1 } },
    });
    s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 110,
      event: ev('e2', 120),
      deltas: noDelta,
    });
    const again = s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 120,
      event: ev('e1', 110),
      deltas: { session: { n: 99 } },
    });
    expect(again.changed).toBe(false);
    let loaded = s.adkSessions.get(key());
    expect(loaded?.events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(loaded?.session).toMatchObject({ eventCount: 2, state: { n: 1 } });

    s.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 120,
      event: ev('e1', 110, { edited: true }),
      deltas: noDelta,
    });
    loaded = s.adkSessions.get(key());
    expect(loaded?.events.map((e) => [e.id, e.seq])).toEqual([
      ['e1', 1],
      ['e2', 2],
    ]);
    expect(loaded?.events[0]?.event).toMatchObject({ edited: true });
    expect(loaded?.session.eventCount).toBe(2);
  });

  it('bounds reads: numRecentEvents and afterTimestamp', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 0 });
    for (let i = 1; i <= 5; i++) {
      s.adkSessions.appendEvent({
        key: key(),
        expectedUpdateTimeMs: i - 1,
        event: ev(`e${i}`, i),
        deltas: noDelta,
      });
    }
    expect(s.adkSessions.get(key(), { numRecentEvents: 2 })?.events.map((e) => e.id)).toEqual([
      'e4',
      'e5',
    ]);
    expect(s.adkSessions.get(key(), { afterTimestampMs: 3 })?.events.map((e) => e.id)).toEqual([
      'e4',
      'e5',
    ]);
    expect(code(() => s.adkSessions.get(key(), { numRecentEvents: 0 }))).toBe('invalid-input');
  });

  it('refuses oversized events and state without writing anything', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 0 });
    const big = 'x'.repeat(ADK_STORAGE_LIMITS.maxEventBytes);
    expect(
      code(() =>
        s.adkSessions.appendEvent({
          key: key(),
          expectedUpdateTimeMs: 0,
          event: ev('big', 1, { text: big }),
          deltas: { app: { a: 1 } },
        }),
      ),
    ).toBe('invalid-input');
    expect(
      code(() =>
        s.adkSessions.appendEvent({
          key: key(),
          expectedUpdateTimeMs: 0,
          event: ev('ok', 1),
          deltas: { user: { blob: big } },
        }),
      ),
    ).toBe('invalid-input');
    const loaded = s.adkSessions.get(key());
    expect(loaded?.events).toEqual([]);
    expect(loaded?.appState).toEqual({});
    expect(loaded?.userState).toEqual({});
    expect(loaded?.session.updateTimeMs).toBe(0);
  });

  it('rolls back the whole append when the event insert fails', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 0 });
    s.sqlite.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON adk_events BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() =>
      s.adkSessions.appendEvent({
        key: key(),
        expectedUpdateTimeMs: 0,
        event: ev('e1', 1),
        deltas: { app: { a: 1 }, user: { u: 1 }, session: { s: 1 } },
      }),
    ).toThrow(/injected/);
    const loaded = s.adkSessions.get(key());
    expect(loaded).toMatchObject({
      events: [],
      appState: {},
      userState: {},
      session: { state: {}, eventCount: 0, updateTimeMs: 0 },
    });
  });

  it('rolls back the whole append when a state update fails', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 0 });
    s.sqlite.exec(
      "CREATE TRIGGER fail_state BEFORE INSERT ON adk_user_state BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() =>
      s.adkSessions.appendEvent({
        key: key(),
        expectedUpdateTimeMs: 0,
        event: ev('e1', 1),
        deltas: { app: { a: 1 }, user: { u: 1 }, session: { s: 1 } },
      }),
    ).toThrow(/injected/);
    expect(s.adkSessions.get(key())).toMatchObject({
      events: [],
      appState: {},
      userState: {},
      session: { state: {} },
    });
  });

  it('deletes one session and its events, keeping other sessions and shared state', () => {
    const s = fresh();
    s.adkSessions.create({
      key: key('a'),
      deltas: { app: { shared: 1 }, user: { pref: 'x' } },
      nowMs: 0,
    });
    s.adkSessions.create({ key: key('b'), nowMs: 0 });
    for (const id of ['a', 'b']) {
      s.adkSessions.appendEvent({
        key: key(id),
        expectedUpdateTimeMs: 0,
        event: ev(`${id}-e1`, 1),
        deltas: noDelta,
      });
    }
    expect(s.adkSessions.delete(key('a'))).toBe(true);
    expect(s.adkSessions.get(key('a'))).toBeUndefined();
    expect(
      s.sqlite.prepare("select count(*) as n from adk_events where session_id = 'a'").get(),
    ).toEqual({ n: 0 });
    expect(s.adkSessions.get(key('b'))).toMatchObject({
      events: [{ id: 'b-e1' }],
      appState: { shared: 1 },
      userState: { pref: 'x' },
    });
    expect(s.adkSessions.delete(key('a'))).toBe(false);
  });

  it('works inside storage.transaction (nested savepoint) and rolls back with it', () => {
    const s = fresh();
    s.adkSessions.create({ key: key(), nowMs: 0 });
    expect(() =>
      s.transaction((repos) => {
        repos.adkSessions.appendEvent({
          key: key(),
          expectedUpdateTimeMs: 0,
          event: ev('e1', 1),
          deltas: noDelta,
        });
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');
    expect(s.adkSessions.get(key())?.events).toEqual([]);
  });

  it('persists across close and reopen of a file database', () => {
    const { dbPath, cleanup } = tempDir();
    cleanups.push(cleanup);
    const first = openStorage({ path: dbPath });
    first.adkSessions.create({ key: key(), deltas: { user: { lang: 'fa' } }, nowMs: 0 });
    first.adkSessions.appendEvent({
      key: key(),
      expectedUpdateTimeMs: 0,
      event: ev('e1', 5),
      deltas: { session: { k: 'v' } },
    });
    first.close();
    const second = openStorage({ path: dbPath });
    cleanups.unshift(() => second.close());
    expect(second.adkSessions.get(key())).toMatchObject({
      session: { state: { k: 'v' }, updateTimeMs: 5, eventCount: 1 },
      events: [{ id: 'e1', seq: 1 }],
      userState: { lang: 'fa' },
    });
  });
});
