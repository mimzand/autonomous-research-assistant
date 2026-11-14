/**
 * Configuration precedence for ENV_OVERRIDE_KEYS (server URL, model, Chat and
 * Research engine): explicit valid environment variable > saved > default.
 * Deterministic: SQLite temp files and a scripted fetch; no network.
 */
import { taskModelsFor } from '@rka/agent-host';
import { createOllamaProvider, type FetchLike } from '@rka/model-provider';
import { openStorage, type Storage } from '@rka/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEnvOverrides } from './env-overrides.js';
import { createRuntimeConfig, SAVED_PREFIX } from './runtime-config.js';
import { ollamaApplier, toOllamaConfig } from './services.js';

const TUNNEL = 'example-tunnel.ngrok-free.dev';
const REMOTE_MODEL = 'qwen3.5:9b-mlx';

const dirs: string[] = [];
const opened: Storage[] = [];
afterEach(() => {
  opened.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rka-precedence-'));
  dirs.push(dir);
  return join(dir, 'app.db');
};
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (t: string) => Buffer.from(`enc:${t}`).reverse(),
  decryptString: (d: Buffer) => Buffer.from(d).reverse().toString().slice(4),
};
function open(path: string, env: NodeJS.ProcessEnv = {}) {
  const storage = openStorage({ path, cipher });
  opened.push(storage);
  const warn = vi.fn();
  const config = createRuntimeConfig({ storage, env, encryptionAvailable: () => true, warn });
  return { storage, config, warn };
}
function close(s: Storage) {
  s.close();
  opened.splice(opened.indexOf(s), 1);
}

describe('resolveEnvOverrides', () => {
  it('absent and empty variables are not overrides', () => {
    expect(resolveEnvOverrides({})).toEqual([]);
    expect(
      resolveEnvOverrides({ OLLAMA_HOST: '', OLLAMA_MODEL: '  ', AGENT_ENGINE: '\t' }),
    ).toEqual([]);
  });

  it.each([
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['localhost', 'http://localhost:11434'],
    [`https://${TUNNEL}`, `https://${TUNNEL}`],
    [`https://${TUNNEL}/`, `https://${TUNNEL}`],
    ['https://ollama.example.com:8443', 'https://ollama.example.com:8443'],
    ['https://proxy.example.com/ollama/', 'https://proxy.example.com/ollama'],
    ['http://192.168.1.20:11434', 'http://192.168.1.20:11434'],
  ])('OLLAMA_HOST=%s → %s', (raw, url) => {
    expect(resolveEnvOverrides({ OLLAMA_HOST: raw })).toEqual([
      { key: 'ollama.baseUrl', envVar: 'OLLAMA_HOST', value: url },
    ]);
  });

  it.each([
    ['ftp://example.com', /only http/],
    ['http://', /not a valid/],
    ['https://user:s3cret@example.com', /user name or password/],
    ['https://example.com/?x=1', /query/],
    ['0.0.0.0', null], // mapped to 127.0.0.1 as by the Ollama CLI
  ])('invalid OLLAMA_HOST=%s is reported, never silently replaced', (raw, error) => {
    const [o] = resolveEnvOverrides({ OLLAMA_HOST: raw });
    if (error === null) {
      expect(o?.value).toBe('http://127.0.0.1:11434');
      return;
    }
    expect(o?.value).toBeUndefined();
    expect(o?.error).toMatch(error);
    expect(o?.error).toMatch(/restart the app/);
    expect(o?.error).not.toContain('s3cret'); // credentials are never echoed
  });

  it('OLLAMA_MODEL and the engine variables are validated', () => {
    expect(
      resolveEnvOverrides({
        OLLAMA_MODEL: ` ${REMOTE_MODEL} `,
        AGENT_ENGINE: 'ADK',
        RESEARCH_ENGINE: 'Legacy',
      }),
    ).toEqual([
      { key: 'model.name', envVar: 'OLLAMA_MODEL', value: REMOTE_MODEL },
      { key: 'engine.chat', envVar: 'AGENT_ENGINE', value: 'adk' },
      { key: 'engine.research', envVar: 'RESEARCH_ENGINE', value: 'legacy' },
    ]);
    const bad = resolveEnvOverrides({ OLLAMA_MODEL: 'bad model!', AGENT_ENGINE: 'turbo' });
    expect(bad.map((o) => [o.key, o.value, Boolean(o.error)])).toEqual([
      ['model.name', undefined, true],
      ['engine.chat', undefined, true],
    ]);
  });
});

describe('precedence: environment override > saved > default', () => {
  it('defaults when nothing is saved and nothing is set', () => {
    const { config } = open(dbPath());
    expect(config.getSettings()).toMatchObject({
      'ollama.baseUrl': 'http://127.0.0.1:11434',
      'model.name': 'qwen3:8b',
      'engine.chat': 'legacy',
      'engine.research': 'legacy',
    });
    for (const key of ['ollama.baseUrl', 'model.name', 'engine.chat', 'engine.research'] as const)
      expect(config.view().entries[key]).toMatchObject({ source: 'default', overridden: false });
  });

  it('reproduces the reported mismatch and fixes it: OLLAMA_HOST and OLLAMA_MODEL both win over saved values', () => {
    const path = dbPath();
    const first = open(path);
    // Earlier session: the local URL was saved in Settings (explicit saves are kept even
    // when equal to the default), and so was a model.
    first.config.updateSettings({ 'ollama.baseUrl': 'http://127.0.0.1:11434' });
    first.config.updateSettings({ 'model.name': 'qwen3:8b' });
    close(first.storage);

    const env = { OLLAMA_HOST: `https://${TUNNEL}`, OLLAMA_MODEL: REMOTE_MODEL };
    const { config, storage } = open(path, env);
    expect(config.getSettings()['ollama.baseUrl']).toBe(`https://${TUNNEL}`);
    expect(config.getSettings()['model.name']).toBe(REMOTE_MODEL);
    expect(config.view().entries['ollama.baseUrl']).toMatchObject({
      source: 'environment',
      envVar: 'OLLAMA_HOST',
      overridden: true,
      savedValue: 'http://127.0.0.1:11434',
    });
    // The override is never written into the user's saved settings.
    expect(
      Object.fromEntries(
        storage.settings
          .list()
          .filter((e) => e.key.startsWith(SAVED_PREFIX))
          .map((e) => [e.key, e.value]),
      ),
    ).toEqual({
      [`${SAVED_PREFIX}ollama.baseUrl`]: 'http://127.0.0.1:11434',
      [`${SAVED_PREFIX}model.name`]: 'qwen3:8b',
    });
  });

  it('saved values apply when the variables are absent, and again after an override is removed', () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({
      'ollama.baseUrl': 'http://192.168.1.20:11434',
      'model.name': 'llama3.2:3b',
    });
    close(first.storage);
    const overridden = open(path, { OLLAMA_HOST: `https://${TUNNEL}`, OLLAMA_MODEL: REMOTE_MODEL });
    expect(overridden.config.getSettings()['ollama.baseUrl']).toBe(`https://${TUNNEL}`);
    close(overridden.storage);
    const restored = open(path);
    expect(restored.config.getSettings()).toMatchObject({
      'ollama.baseUrl': 'http://192.168.1.20:11434',
      'model.name': 'llama3.2:3b',
    });
    expect(restored.config.view().entries['ollama.baseUrl']).toMatchObject({
      source: 'saved',
      overridden: false,
    });
  });

  it('overridden settings are read-only; other settings stay editable; Reset only clears the saved fallback', () => {
    const { config } = open(dbPath(), { OLLAMA_MODEL: REMOTE_MODEL });
    expect(config.updateSettings({ 'model.name': 'other:1b' })).toMatchObject({
      status: 'invalid',
      errors: { 'model.name': expect.stringMatching(/OLLAMA_MODEL.*restart/) },
    });
    expect(config.validateSettings({ 'model.name': 'other:1b' }).ok).toBe(false);
    expect(config.updateSettings({ 'model.temperature': 0.3 }).status).toBe('saved');
    expect(config.resetSettings(['model.name']).status).toBe('saved');
    expect(config.getSettings()['model.name']).toBe(REMOTE_MODEL);
  });

  it('an invalid OLLAMA_HOST is not applied: the saved URL stays active and the error is visible', () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({ 'ollama.baseUrl': 'http://192.168.1.20:11434' });
    close(first.storage);
    const { config, warn } = open(path, { OLLAMA_HOST: 'ftp://example.com' });
    expect(config.getSettings()['ollama.baseUrl']).toBe('http://192.168.1.20:11434');
    expect(config.view().entries['ollama.baseUrl']).toMatchObject({
      source: 'saved',
      overridden: false,
      envError: expect.stringMatching(/^OLLAMA_HOST="ftp:\/\/example.com" is not used/),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/OLLAMA_HOST/));
  });
});

describe('security exceptions', () => {
  it('the environment never bypasses "Require HTTPS for remote servers"', () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({ 'security.requireHttpsForRemote': true });
    close(first.storage);
    const { config } = open(path, { OLLAMA_HOST: 'http://10.0.0.5:11434' });
    expect(config.getSettings()['ollama.baseUrl']).toBe('http://127.0.0.1:11434');
    expect(config.view().entries['ollama.baseUrl']).toMatchObject({
      overridden: false,
      envError: expect.stringMatching(/Require HTTPS for remote servers/),
    });
  });

  it('turning on the HTTPS requirement is refused while a plain-HTTP remote override is active', () => {
    const { config } = open(dbPath(), { OLLAMA_HOST: 'http://10.0.0.5:11434' });
    expect(config.getSettings()['ollama.baseUrl']).toBe('http://10.0.0.5:11434');
    expect(config.updateSettings({ 'security.requireHttpsForRemote': true })).toMatchObject({
      status: 'invalid',
      errors: { 'security.requireHttpsForRemote': expect.stringMatching(/plain HTTP/) },
    });
  });

  it('security settings and secrets are not overridable from the environment', () => {
    const { config } = open(dbPath(), {
      SECURITY_REQUIRE_HTTPS: 'false',
      OLLAMA_AUTH_TOKEN: 'from-env',
    } as NodeJS.ProcessEnv);
    expect(config.getSecret('ollama.authToken')).toBeUndefined();
    expect(config.view().entries['security.requireHttpsForRemote']?.overridden).toBe(false);
  });

  it('views and errors never contain the access token', () => {
    const { config } = open(dbPath(), { OLLAMA_HOST: 'https://user:pw-123@example.com' });
    config.setSecret('ollama.authToken', 'tok-SECRET-1');
    const view = JSON.stringify(config.view());
    expect(view).not.toContain('tok-SECRET-1');
    expect(view).not.toContain('pw-123');
  });
});

describe('runtime consistency: every consumer uses the same effective URL and model', () => {
  function scripted(models: Record<string, string[]>) {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = (input, init = {}) => {
      seen.push({ url: input, headers: { ...(init.headers as Record<string, string>) } });
      const url = new URL(input);
      const installed = models[url.host] ?? [];
      const json = (v: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(v), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      if (url.pathname.endsWith('/api/version')) return json({ version: '0.40.14' });
      if (url.pathname.endsWith('/api/tags'))
        return json({ models: installed.map((name) => ({ name })) });
      if (url.pathname.endsWith('/api/show'))
        return json({ capabilities: ['completion'], model_info: {} });
      return json({ error: 'not found' }, 404);
    };
    return { seen, fetch };
  }

  it('health/preflight, model list and Research task capture use the overridden URL and model', async () => {
    const path = dbPath();
    const first = open(path);
    first.config.updateSettings({ 'ollama.baseUrl': 'http://127.0.0.1:11434' });
    close(first.storage);
    const { config } = open(path, { OLLAMA_HOST: `https://${TUNNEL}`, OLLAMA_MODEL: REMOTE_MODEL });

    // Local Ollama does not have the remote model; the tunnel does.
    const { seen, fetch } = scripted({
      '127.0.0.1:11434': ['qwen3:8b'],
      [TUNNEL]: [REMOTE_MODEL],
    });
    const provider = createOllamaProvider(toOllamaConfig(config.getSettings()), {
      fetch,
      ngrokBypassHosts: [TUNNEL],
      getAuthToken: () => 'tok',
    });
    config.register(ollamaApplier(provider));

    const health = await provider.checkHealth();
    expect(health).toMatchObject({
      status: 'ready',
      baseUrl: `https://${TUNNEL}`,
      model: REMOTE_MODEL,
    });
    expect((await provider.listModels()).map((m) => m.name)).toEqual([REMOTE_MODEL]);
    expect(taskModelsFor(provider).capture()).toMatchObject({
      name: REMOTE_MODEL,
      url: `https://${TUNNEL}`,
    });
    // Never the saved local URL; the trusted-host header only goes to the tunnel.
    expect(seen.every((s) => s.url.startsWith(`https://${TUNNEL}/`))).toBe(true);
    expect(seen.every((s) => s.headers['ngrok-skip-browser-warning'] === 'true')).toBe(true);
    expect(seen.every((s) => s.headers['authorization'] === 'Bearer tok')).toBe(true);
  });

  it('a local override gets neither the ngrok header nor (over plain HTTP to another computer) the token', async () => {
    for (const host of ['127.0.0.1:11434', 'http://10.0.0.5:11434']) {
      const { config } = open(dbPath(), { OLLAMA_HOST: host, OLLAMA_MODEL: 'qwen3:8b' });
      const { seen, fetch } = scripted({
        '127.0.0.1:11434': ['qwen3:8b'],
        '10.0.0.5:11434': ['qwen3:8b'],
      });
      const provider = createOllamaProvider(toOllamaConfig(config.getSettings()), {
        fetch,
        ngrokBypassHosts: [TUNNEL],
        getAuthToken: () => 'tok',
      });
      await provider.checkHealth();
      expect(seen.length, host).toBeGreaterThan(0);
      expect(
        seen.some((s) => 'ngrok-skip-browser-warning' in s.headers),
        host,
      ).toBe(false);
      const local = host.startsWith('127.');
      expect(
        seen.every((s) => (s.headers['authorization'] === 'Bearer tok') === local),
        host,
      ).toBe(true);
    }
  });
});
