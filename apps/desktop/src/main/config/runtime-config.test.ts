import { loadResearchConfig, ResearchLimitsSchema } from '@rka/agent-runtime';
import { loadOllamaConfig } from '@rka/model-provider';
import { SETTING_DEFINITION_BY_KEY, SETTING_KEYS, type SettingKey } from '@rka/shared';
import { openStorage, type Storage } from '@rka/storage';
import { loadWebConfig } from '@rka/tools';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRuntimeConfig,
  environmentDefaults,
  SAVED_PREFIX,
  SECRET_PREFIX,
  type ConfigApplier,
} from './runtime-config.js';

/** Reversible stand-in for Electron safeStorage (the real one is OS-bound). */
const cipher = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text: string) => Buffer.from(`enc:${text}`).reverse(),
  decryptString: (data: Buffer) => Buffer.from(data).reverse().toString().slice(4),
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(options: { env?: NodeJS.ProcessEnv; storage?: Storage; encryption?: boolean } = {}) {
  const storage =
    options.storage ??
    openStorage({ path: ':memory:', cipher: cipher(options.encryption ?? true) });
  const warn = vi.fn();
  const config = createRuntimeConfig({
    storage,
    env: options.env ?? {},
    encryptionAvailable: () => options.encryption ?? true,
    warn,
  });
  return { storage, config, warn };
}

const recorder = (name: string, keys: SettingKey[]) => {
  const calls: string[] = [];
  const applier: ConfigApplier = {
    name,
    keys,
    apply: (next) => calls.push(keys.map((k) => String(next[k])).join(',')),
  };
  return { applier, calls };
};

describe('loading settings', () => {
  it('starts from the built-in defaults', () => {
    const { config } = setup();
    expect(config.getSettings()).toMatchObject({
      'ollama.baseUrl': 'http://127.0.0.1:11434',
      'model.name': 'qwen3:8b',
      'model.numCtx': 4096,
      'model.temperature': null,
      'searxng.url': null,
      'general.startSection': 'chat',
      'security.requireHttpsForRemote': false,
    });
    const view = config.view();
    expect(view.entries['model.name']).toEqual({
      source: 'default',
      defaultValue: 'qwen3:8b',
      envVar: null,
    });
    expect(view.secrets).toEqual({ 'ollama.authToken': { set: false } });
  });

  it('built-in defaults match the existing loaders (no drift)', () => {
    const { config } = setup();
    const v = config.getSettings();
    const ollama = loadOllamaConfig({});
    const web = loadWebConfig({});
    const research = ResearchLimitsSchema.parse({});
    expect([v['ollama.baseUrl'], v['model.name'], v['model.numCtx']]).toEqual([
      ollama.baseUrl,
      ollama.model,
      ollama.numCtx,
    ]);
    expect([
      v['ollama.requestTimeoutMs'],
      v['model.generateTimeoutMs'],
      v['ollama.streamIdleTimeoutMs'],
    ]).toEqual([ollama.requestTimeoutMs, ollama.generateTimeoutMs, ollama.streamIdleTimeoutMs]);
    expect([
      v['web.fetchTimeoutMs'],
      v['web.searchTimeoutMs'],
      v['web.maxDownloadBytes'],
      v['web.maxTextChars'],
      v['web.maxPdfPages'],
    ]).toEqual([
      web.fetchTimeoutMs,
      web.searchTimeoutMs,
      web.maxDownloadBytes,
      web.maxTextChars,
      web.maxPdfPages,
    ]);
    expect([
      v['research.maxQuestions'],
      v['research.maxSources'],
      v['research.resultsPerQuery'],
      v['research.modelRetries'],
      v['research.toolRetries'],
      v['research.retryBackoffMs'],
      v['research.modelTimeoutMs'],
    ]).toEqual([
      research.maxQuestions,
      research.maxSources,
      research.resultsPerQuery,
      research.modelRetries,
      research.toolRetries,
      research.retryBackoffMs,
      research.modelTimeoutMs,
    ]);
    expect(loadResearchConfig({})).toEqual({});
  });

  it('uses environment variables as defaults and says which variable set them', () => {
    const env = {
      OLLAMA_HOST: '192.168.1.100:11434',
      OLLAMA_MODEL: 'llama3.2:3b',
      SEARXNG_URL: 'http://127.0.0.1:8080',
      RESEARCH_MAX_SOURCES: '4',
    };
    const { config } = setup({ env });
    expect(config.getSettings()).toMatchObject({
      'ollama.baseUrl': 'http://192.168.1.100:11434',
      'model.name': 'llama3.2:3b',
      'searxng.url': 'http://127.0.0.1:8080',
      'research.maxSources': 4,
    });
    expect(config.view().entries['model.name']).toMatchObject({
      source: 'environment',
      envVar: 'OLLAMA_MODEL',
    });
    expect(environmentDefaults(env).vars).toEqual({
      'model.name': 'OLLAMA_MODEL',
      'ollama.baseUrl': 'OLLAMA_HOST',
      'searxng.url': 'SEARXNG_URL',
      'research.maxSources': 'RESEARCH_MAX_SOURCES',
    });
  });

  it('an invalid environment value stops startup (as before)', () => {
    expect(() => setup({ env: { RESEARCH_MODEL_RETRIES: '9' } })).toThrow(/RESEARCH_MODEL_RETRIES/);
    expect(() => setup({ env: { OLLAMA_NUM_CTX: 'big' } })).toThrow();
  });

  it('every setting has a definition and a category', () => {
    for (const key of SETTING_KEYS)
      expect(SETTING_DEFINITION_BY_KEY.get(key)?.category).toBeTruthy();
  });
});

describe('updating settings', () => {
  it('validates, applies to the affected services only, persists, and notifies', () => {
    const { config, storage } = setup();
    const ollama = recorder('ollama', ['ollama.baseUrl', 'model.name']);
    const web = recorder('web', ['searxng.url']);
    config.register(ollama.applier);
    config.register(web.applier);
    const events: string[][] = [];
    // Listeners see the saved state (sources) already updated.
    config.onChange((e) => {
      events.push([...e.changed]);
      expect(config.view().entries['model.name']?.source).toBe('saved');
    });

    const result = config.updateSettings({
      'ollama.baseUrl': ' http://192.168.1.100:11434/ ',
      'model.name': 'llama3.2:3b',
    });
    expect(result).toMatchObject({
      status: 'saved',
      changed: ['model.name', 'ollama.baseUrl'],
      warnings: [expect.stringMatching(/Plain HTTP to another computer/)],
    });
    expect(ollama.calls).toEqual([
      'http://127.0.0.1:11434,qwen3:8b',
      'http://192.168.1.100:11434,llama3.2:3b',
    ]);
    expect(web.calls).toHaveLength(1); // only the initial registration
    expect(events).toEqual([['model.name', 'ollama.baseUrl']]);
    expect(storage.settings.get(`${SAVED_PREFIX}ollama.baseUrl`)).toBe(
      'http://192.168.1.100:11434',
    );
    expect(config.view().entries['ollama.baseUrl']?.source).toBe('saved');
  });

  it('normalises URLs like Ollama does', () => {
    const { config } = setup();
    const set = (url: string) => {
      config.updateSettings({ 'ollama.baseUrl': url });
      return config.getSetting('ollama.baseUrl');
    };
    expect(set('192.168.1.100')).toBe('http://192.168.1.100:11434');
    expect(set('ollama.lan:12000')).toBe('http://ollama.lan:12000');
    expect(set('https://ollama.example.com/')).toBe('https://ollama.example.com');
    expect(set('https://example.com/ollama/')).toBe('https://example.com/ollama');
    config.updateSettings({ 'searxng.url': '' });
    expect(config.getSetting('searxng.url')).toBeNull();
  });

  it('rejects invalid values and changes nothing', () => {
    const { config, storage } = setup();
    const applier = recorder('ollama', ['model.temperature']);
    config.register(applier.applier);
    const result = config.updateSettings({
      'model.temperature': 3,
      'model.numCtx': 100,
      'ollama.baseUrl': 'https://user:pw@example.com',
      'searxng.url': 'ftp://x',
      'model.name': 'bad name!',
      'no.such.key': 1,
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(Object.keys(result.errors).sort()).toEqual([
      'model.name',
      'model.numCtx',
      'model.temperature',
      'no.such.key',
      'ollama.baseUrl',
      'searxng.url',
    ]);
    expect(result.errors['ollama.baseUrl']).toMatch(/user name or password/);
    expect(applier.calls).toHaveLength(1);
    expect(storage.settings.list()).toEqual([]);
    expect(config.validateSettings({ 'model.temperature': 0.7 })).toEqual({
      ok: true,
      errors: {},
      warnings: [],
    });
  });

  it('enforces "Require HTTPS for remote servers" across settings', () => {
    const { config } = setup();
    expect(config.updateSettings({ 'ollama.baseUrl': 'http://10.0.0.5:11434' }).status).toBe(
      'saved',
    );
    expect(config.updateSettings({ 'security.requireHttpsForRemote': true })).toMatchObject({
      status: 'invalid',
      errors: { 'security.requireHttpsForRemote': expect.stringMatching(/Ollama URL/) },
    });
    expect(
      config.updateSettings({
        'security.requireHttpsForRemote': true,
        'ollama.baseUrl': 'https://ollama.example.com',
      }).status,
    ).toBe('saved');
    expect(config.updateSettings({ 'searxng.url': 'http://192.168.1.2:8080' })).toMatchObject({
      status: 'invalid',
      errors: { 'searxng.url': expect.stringMatching(/plain HTTP/) },
    });
    // Loopback is always allowed.
    expect(config.updateSettings({ 'ollama.baseUrl': 'http://127.0.0.1:11434' }).status).toBe(
      'saved',
    );
  });

  it('rolls back the running services when applying fails', () => {
    const { config, storage } = setup();
    const good = recorder('web', ['searxng.url']);
    config.register(good.applier);
    config.register({
      name: 'broken',
      keys: ['web.fetchTimeoutMs'],
      apply: (next) => {
        if (next['web.fetchTimeoutMs'] === 5000) throw new Error('cannot apply');
      },
    });
    const result = config.updateSettings({
      'searxng.url': 'http://127.0.0.1:8080',
      'web.fetchTimeoutMs': 5000,
    });
    expect(result).toEqual({
      status: 'failed',
      message: 'The settings were not changed: cannot apply',
    });
    // Applied, then restored to the previous value.
    expect(good.calls).toEqual(['null', 'http://127.0.0.1:8080', 'null']);
    expect(config.getSetting('searxng.url')).toBeNull();
    expect(storage.settings.list()).toEqual([]);
  });

  it('rolls back the running services when saving fails', () => {
    const { config, storage } = setup();
    const applier = recorder('ollama', ['model.name']);
    config.register(applier.applier);
    vi.spyOn(storage, 'transaction').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(config.updateSettings({ 'model.name': 'llama3.2:3b' })).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/disk full/),
    });
    expect(applier.calls).toEqual(['qwen3:8b', 'llama3.2:3b', 'qwen3:8b']);
    expect(config.getSetting('model.name')).toBe('qwen3:8b');
  });

  it('keeps explicitly saved values even when they equal the default', () => {
    const { config, storage } = setup();
    config.updateSettings({ 'model.numCtx': 4096 });
    expect(storage.settings.get(`${SAVED_PREFIX}model.numCtx`)).toBe(4096);
    expect(config.view().entries['model.numCtx']?.source).toBe('saved');
  });
});

describe('resetting settings', () => {
  it('resets one setting to the environment value, or all settings', () => {
    const { config, storage } = setup({ env: { OLLAMA_MODEL: 'env-model:1b' } });
    config.updateSettings({ 'model.name': 'llama3.2:3b', 'model.temperature': 0.5 });
    expect(config.resetSetting('model.name')).toMatchObject({
      status: 'saved',
      changed: ['model.name'],
    });
    expect(config.getSetting('model.name')).toBe('env-model:1b');
    expect(config.getSetting('model.temperature')).toBe(0.5);
    config.setSecret('ollama.authToken', 'tok');
    expect(config.resetSettings()).toMatchObject({
      status: 'saved',
      changed: ['model.temperature'],
    });
    expect(config.getSetting('model.temperature')).toBeNull();
    // Secrets are not touched by "reset all".
    expect(storage.settings.list().map((e) => e.key)).toEqual([`${SECRET_PREFIX}ollama.authToken`]);
    expect(config.resetSettings(['bogus'])).toMatchObject({ status: 'invalid' });
  });
});

describe('secrets', () => {
  it('stores the token encrypted, reads it back in main only, and never exposes it', () => {
    const { config, storage } = setup();
    expect(config.setSecret('ollama.authToken', '  sk-proxy-token-123  ')).toMatchObject({
      status: 'saved',
      view: { secrets: { 'ollama.authToken': { set: true } } },
    });
    const row = storage.settings.list().find((e) => e.key === `${SECRET_PREFIX}ollama.authToken`);
    expect(row).toMatchObject({ isSecret: true, value: '[encrypted]' });
    expect(config.getSecret('ollama.authToken')).toBe('sk-proxy-token-123');
    expect(JSON.stringify(config.view())).not.toContain('sk-proxy-token-123');

    expect(config.setSecret('ollama.authToken', 'has space')).toMatchObject({ status: 'invalid' });
    config.setSecret('ollama.authToken', null);
    expect(config.getSecret('ollama.authToken')).toBeUndefined();
    expect(config.view().secrets['ollama.authToken']).toEqual({ set: false });
  });

  it('refuses to store a secret without OS encryption', () => {
    const { config, storage } = setup({ encryption: false });
    expect(config.setSecret('ollama.authToken', 'tok')).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/encryption is not available/),
    });
    expect(storage.settings.list()).toEqual([]);
  });
});

describe('restart', () => {
  it('restores saved settings and secrets after the app restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rka-settings-'));
    dirs.push(dir);
    const path = join(dir, 'research.db');
    const first = setup({ storage: openStorage({ path, cipher: cipher() }) });
    first.config.updateSettings({
      'ollama.baseUrl': 'https://ollama.example.com',
      'model.name': 'llama3.2:3b',
      'model.topK': 40,
      'general.startSection': 'tasks',
    });
    first.config.setSecret('ollama.authToken', 'tok-abc');
    first.storage.close();

    const second = setup({
      storage: openStorage({ path, cipher: cipher() }),
      env: { OLLAMA_MODEL: 'env-model:1b' },
    });
    expect(second.config.getSettings()).toMatchObject({
      'ollama.baseUrl': 'https://ollama.example.com',
      'model.name': 'llama3.2:3b', // saved wins over the environment
      'model.topK': 40,
      'general.startSection': 'tasks',
    });
    expect(second.config.getSecret('ollama.authToken')).toBe('tok-abc');
    expect(second.config.view().startedWith.startSection).toBe('tasks');
    second.storage.close();
  });

  it('ignores a saved value that is no longer valid, with a warning', () => {
    const storage = openStorage({ path: ':memory:', cipher: cipher() });
    storage.settings.set(`${SAVED_PREFIX}model.numCtx`, 10);
    storage.settings.set('playground.task', 'kept'); // unrelated settings are untouched
    const { config, warn } = setup({ storage });
    expect(config.getSetting('model.numCtx')).toBe(4096);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Ignoring the saved value of "model.numCtx"/),
    );
  });

  it('reloadRuntimeConfiguration re-reads SQLite and re-applies every service', () => {
    const { config, storage } = setup();
    const applier = recorder('ollama', ['model.name']);
    config.register(applier.applier);
    storage.settings.set(`${SAVED_PREFIX}model.name`, 'other:7b');
    expect(config.reloadRuntimeConfiguration()).toMatchObject({
      status: 'saved',
      changed: ['model.name'],
    });
    expect(applier.calls).toEqual(['qwen3:8b', 'other:7b']);
  });
});
