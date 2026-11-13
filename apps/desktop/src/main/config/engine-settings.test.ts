/**
 * Phase 7.4.2: Chat and Research engine choices as ordinary settings
 * (built-in default < AGENT_ENGINE / RESEARCH_ENGINE < saved in SQLite).
 */
import { SETTING_DEFINITION_BY_KEY, SettingsValuesSchema } from '@rka/shared';
import { openStorage, type Storage } from '@rka/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfig, SAVED_PREFIX } from './runtime-config.js';

const dirs: string[] = [];
const opened: Storage[] = [];
afterEach(() => {
  opened.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rka-engine-settings-'));
  dirs.push(dir);
  return join(dir, 'settings.db');
}

function open(path: string, env: NodeJS.ProcessEnv = {}) {
  const storage = openStorage({ path });
  opened.push(storage);
  const warn = vi.fn();
  const config = createRuntimeConfig({ storage, env, encryptionAvailable: () => false, warn });
  return { storage, config, warn };
}
const engines = (c: ReturnType<typeof open>['config']) => ({
  chat: c.getSettings()['engine.chat'],
  research: c.getSettings()['engine.research'],
});

describe('engine settings: definitions', () => {
  it('two select settings in the Agent Engines category, both defaulting to legacy', () => {
    for (const [key, env, applies] of [
      ['engine.chat', 'AGENT_ENGINE', 'immediately'],
      ['engine.research', 'RESEARCH_ENGINE', 'new-tasks'],
    ] as const) {
      expect(SETTING_DEFINITION_BY_KEY.get(key)).toMatchObject({
        category: 'engines',
        kind: 'select',
        builtin: 'legacy',
        env,
        applies,
        options: [
          { value: 'legacy', label: 'Legacy', description: expect.any(String) },
          { value: 'adk', label: 'Google ADK', description: expect.any(String) },
        ],
      });
    }
  });

  it('values are strictly "legacy" or "adk"', () => {
    for (const key of ['engine.chat', 'engine.research'] as const) {
      const schema = SettingsValuesSchema.shape[key];
      expect(schema.safeParse('legacy').success).toBe(true);
      expect(schema.safeParse('adk').success).toBe(true);
      for (const bad of ['ADK', 'Legacy', ' adk', '', 'turbo', null, 0, true]) {
        expect(schema.safeParse(bad).success, `${key} ${String(bad)}`).toBe(false);
      }
    }
  });
});

describe('engine settings: persistence and precedence', () => {
  it('defaults to legacy for both when nothing is saved and no variable is set', () => {
    const { config, warn } = open(dbPath());
    expect(engines(config)).toEqual({ chat: 'legacy', research: 'legacy' });
    expect(config.view().entries['engine.chat']).toMatchObject({
      source: 'default',
      envVar: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('Chat and Research are saved independently and reloaded after a restart', () => {
    const path = dbPath();
    const first = open(path);
    expect(first.config.updateSettings({ 'engine.chat': 'adk' })).toMatchObject({
      status: 'saved',
    });
    expect(engines(first.config)).toEqual({ chat: 'adk', research: 'legacy' });
    first.storage.close();
    opened.splice(opened.indexOf(first.storage), 1);

    const second = open(path);
    expect(engines(second.config)).toEqual({ chat: 'adk', research: 'legacy' });
    second.config.updateSettings({ 'engine.research': 'adk' });
    second.config.updateSettings({ 'engine.chat': 'legacy' });
    second.storage.close();
    opened.splice(opened.indexOf(second.storage), 1);

    const third = open(path);
    expect(engines(third.config)).toEqual({ chat: 'legacy', research: 'adk' });
    expect(third.config.view().entries['engine.research']?.source).toBe('saved');
  });

  it('invalid values are rejected and nothing is saved', () => {
    const { config, storage } = open(dbPath());
    for (const bad of ['turbo', 'ADK', '', null, 42]) {
      const result = config.updateSettings({ 'engine.chat': bad, 'engine.research': 'adk' });
      expect(result.status, String(bad)).toBe('invalid');
    }
    expect(engines(config)).toEqual({ chat: 'legacy', research: 'legacy' });
    expect(
      storage.settings.list().filter((e) => e.key.startsWith(`${SAVED_PREFIX}engine.`)),
    ).toEqual([]);
  });

  it('explicit environment variables override (case-insensitive, independent)', () => {
    const { config } = open(dbPath(), { AGENT_ENGINE: ' ADK ', RESEARCH_ENGINE: 'legacy' });
    expect(engines(config)).toEqual({ chat: 'adk', research: 'legacy' });
    expect(config.view().entries['engine.chat']).toMatchObject({
      source: 'environment',
      envVar: 'AGENT_ENGINE',
      overridden: true,
      envError: null,
      defaultValue: 'legacy',
    });
  });

  it('an override wins over the saved choice, which is kept and becomes active again without the variable', () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({ 'engine.chat': 'adk', 'engine.research': 'adk' });
    first.storage.close();
    opened.splice(opened.indexOf(first.storage), 1);

    const overridden = open(path, { AGENT_ENGINE: 'legacy' });
    expect(engines(overridden.config)).toEqual({ chat: 'legacy', research: 'adk' });
    expect(overridden.config.view().entries['engine.chat']).toMatchObject({
      source: 'environment',
      overridden: true,
      savedValue: 'adk', // the inactive fallback, never shown as active
    });
    // Read-only while overridden: nothing is saved over the user's choice.
    expect(overridden.config.updateSettings({ 'engine.chat': 'adk' })).toMatchObject({
      status: 'invalid',
      errors: { 'engine.chat': expect.stringMatching(/AGENT_ENGINE.*restart/) },
    });
    expect(overridden.config.updateSettings({ 'engine.research': 'legacy' }).status).toBe('saved');
    overridden.storage.close();
    opened.splice(opened.indexOf(overridden.storage), 1);

    const restored = open(path); // variable removed, app restarted
    expect(engines(restored.config)).toEqual({ chat: 'adk', research: 'legacy' });
    expect(restored.config.view().entries['engine.chat']).toMatchObject({
      source: 'saved',
      overridden: false,
    });
  });

  it('an empty variable is not an override', () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({ 'engine.research': 'adk' });
    first.storage.close();
    opened.splice(opened.indexOf(first.storage), 1);
    const second = open(path, { RESEARCH_ENGINE: '   ', AGENT_ENGINE: '' });
    expect(engines(second.config)).toEqual({ chat: 'legacy', research: 'adk' });
    expect(second.config.view().entries['engine.research']).toMatchObject({
      source: 'saved',
      overridden: false,
      envVar: null,
      envError: null,
    });
  });

  it('an invalid variable is not applied: the saved/default value stays, with a visible, actionable error', () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({ 'engine.research': 'adk' });
    first.storage.close();
    opened.splice(opened.indexOf(first.storage), 1);
    const { config, warn } = open(path, { AGENT_ENGINE: 'turbo', RESEARCH_ENGINE: 'gpt' });
    expect(engines(config)).toEqual({ chat: 'legacy', research: 'adk' });
    expect(config.view().entries['engine.chat']).toMatchObject({
      source: 'default',
      overridden: false,
      envVar: 'AGENT_ENGINE',
      envError: expect.stringMatching(/^AGENT_ENGINE="turbo" is not used: .*restart the app/),
    });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/^AGENT_ENGINE="turbo" is not used/),
      expect.stringMatching(/^RESEARCH_ENGINE="gpt" is not used/),
    ]);
    // Not overridden, so Settings can still be used.
    expect(config.updateSettings({ 'engine.chat': 'adk' }).status).toBe('saved');
  });

  it('an invalid value in an existing database is ignored with a warning (falls back to the default)', () => {
    const path = dbPath();
    const first = open(path);
    first.storage.settings.set(`${SAVED_PREFIX}engine.research`, 'turbo');
    first.storage.close();
    opened.splice(opened.indexOf(first.storage), 1);
    const second = open(path);
    expect(engines(second.config).research).toBe('legacy');
    expect(String(second.warn.mock.calls[0]?.[0])).toMatch(/engine\.research/);
  });

  it('a database from before Phase 7.4.2 (no engine rows) loads with the defaults', () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({ 'model.numCtx': 8192 });
    first.storage.close();
    opened.splice(opened.indexOf(first.storage), 1);
    const second = open(path, { RESEARCH_ENGINE: 'adk' });
    expect(engines(second.config)).toEqual({ chat: 'legacy', research: 'adk' });
    expect(second.config.getSettings()['model.numCtx']).toBe(8192);
  });

  it('a change is announced to listeners (the renderer refreshes Settings, no restart)', () => {
    const { config } = open(dbPath());
    const changes: string[][] = [];
    config.onChange(({ changed }) => changes.push([...changed]));
    config.updateSettings({ 'engine.chat': 'adk' });
    expect(changes).toEqual([['engine.chat']]);
  });
});
