import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyEnvText, loadSettingsFile } from './env.js';
import { isAllowedSetting, isAppUrl, isSafeExternalUrl } from './security.js';

describe('isAppUrl', () => {
  it('allows only file:// pages in production', () => {
    expect(isAppUrl('file:///C:/app/out/renderer/index.html', undefined)).toBe(true);
    expect(isAppUrl('https://example.com', undefined)).toBe(false);
    expect(isAppUrl('not a url', undefined)).toBe(false);
  });

  it('allows only the dev server origin in development', () => {
    const dev = 'http://localhost:5173';
    expect(isAppUrl('http://localhost:5173/#/tasks', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('file:///C:/app/index.html', dev)).toBe(false);
  });
});

describe('applyEnvText', () => {
  it('applies new keys without overriding existing ones', () => {
    const env: NodeJS.ProcessEnv = { OLLAMA_MODEL: 'from-shell' };
    const applied = applyEnvText(
      '# comment\nOLLAMA_HOST=127.0.0.1:11434\nOLLAMA_MODEL=from-file\n',
      env,
    );
    expect(applied).toEqual(['OLLAMA_HOST']);
    expect(env).toEqual({ OLLAMA_MODEL: 'from-shell', OLLAMA_HOST: '127.0.0.1:11434' });
  });
});

describe('isAppUrl with the packaged renderer path', () => {
  const index = join(tmpdir(), 'app', 'out', 'renderer', 'index.html');
  const policy = { devServerUrl: undefined, rendererIndexPath: index };

  it('accepts only the renderer index file (with hash or query)', () => {
    const url = pathToFileURL(index).href;
    expect(isAppUrl(url, policy)).toBe(true);
    expect(isAppUrl(`${url}#/tasks`, policy)).toBe(true);
    expect(isAppUrl(pathToFileURL(join(tmpdir(), 'evil.html')).href, policy)).toBe(false);
    expect(
      isAppUrl(pathToFileURL(join(tmpdir(), 'app', 'out', 'renderer', 'other.html')).href, policy),
    ).toBe(false);
    expect(isAppUrl('https://example.com/', policy)).toBe(false);
    expect(isAppUrl('file://server/share/index.html', policy)).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it.each([
    ['https://example.com/a?b=1', true],
    ['http://example.com', true],
    ['file:///C:/Windows/System32/calc.exe', false],
    ['javascript:alert(1)', false],
    ['ms-settings:privacy', false],
    ['search-ms:query=x', false],
    ['smb://server/share', false],
    ['https://user:pass@example.com', false],
    ['not a url', false],
    [`https://example.com/${'a'.repeat(3000)}`, false],
  ])('%s -> %s', (url, expected) => {
    expect(isSafeExternalUrl(url)).toBe(expected);
  });
});

describe('settings.env', () => {
  it('applies only allowed keys, keeps real environment variables, reports ignored keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rka-settings-'));
    try {
      const file = join(dir, 'settings.env');
      writeFileSync(
        file,
        'SEARXNG_URL=http://127.0.0.1:8080\nOLLAMA_MODEL=file-model\nNODE_OPTIONS=--inspect\nELECTRON_RUN_AS_NODE=1\nRESEARCH_MAX_SOURCES=4\n',
      );
      const env: NodeJS.ProcessEnv = { OLLAMA_MODEL: 'shell-model' };
      const result = loadSettingsFile(file, env, isAllowedSetting);
      expect(result?.applied.sort()).toEqual(['RESEARCH_MAX_SOURCES', 'SEARXNG_URL']);
      expect(result?.ignored.sort()).toEqual(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']);
      expect(env).toEqual({
        OLLAMA_MODEL: 'shell-model',
        SEARXNG_URL: 'http://127.0.0.1:8080',
        RESEARCH_MAX_SOURCES: '4',
      });
      expect(loadSettingsFile(join(dir, 'missing.env'), env, isAllowedSetting)).toBeUndefined();
      writeFileSync(file, `OLLAMA_HOST=${'x'.repeat(70_000)}`);
      expect(() => loadSettingsFile(file, {}, isAllowedSetting)).toThrow(/64 KB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows only the documented prefixes', () => {
    expect(isAllowedSetting('OLLAMA_HOST')).toBe(true);
    expect(isAllowedSetting('WEB_FETCH_TIMEOUT_MS')).toBe(true);
    expect(isAllowedSetting('PATH')).toBe(false);
    expect(isAllowedSetting('ollama_host')).toBe(false);
  });
});
