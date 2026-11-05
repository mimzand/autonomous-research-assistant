import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeCipher, memoryStorage } from '../testing.js';

describe('settings repository', () => {
  it('stores, reads, validates, lists and deletes JSON settings', () => {
    const storage = memoryStorage();
    storage.settings.set('ollama.model', 'qwen3:8b');
    storage.settings.set('research.maxSources', 12);
    storage.settings.set('ui', { theme: 'dark' });

    expect(storage.settings.get('ollama.model')).toBe('qwen3:8b');
    expect(storage.settings.get('research.maxSources', z.int().positive())).toBe(12);
    expect(() => storage.settings.get('ollama.model', z.number())).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );

    storage.settings.set('ollama.model', 'qwen3:4b');
    expect(storage.settings.get('ollama.model')).toBe('qwen3:4b');
    expect(storage.settings.list().map((s) => s.key)).toEqual([
      'ollama.model',
      'research.maxSources',
      'ui',
    ]);

    expect(storage.settings.delete('ui')).toBe(true);
    expect(storage.settings.get('ui')).toBeUndefined();
  });

  it.each(['github.token', 'proxyPassword', 'search.api_key', 'apiKey', 'oauth.secret', 'cookie'])(
    'refuses to store credential-like key "%s" in plaintext',
    (key) => {
      const storage = memoryStorage();
      expect(() => storage.settings.set(key, 'value')).toThrow(
        expect.objectContaining({ code: 'secret-rejected' }),
      );
      expect(storage.settings.list()).toEqual([]);
    },
  );

  it('encrypts secrets: the database never contains the plaintext', () => {
    const cipher = fakeCipher();
    const storage = memoryStorage({ cipher });
    storage.settings.setSecret('search.api_key', 'sk-live-123456');

    const raw = storage.sqlite.prepare('SELECT value, is_secret FROM settings').get() as {
      value: string;
      is_secret: number;
    };
    expect(raw.is_secret).toBe(1);
    expect(raw.value).not.toContain('sk-live-123456');
    expect(Buffer.from(raw.value, 'base64').toString('latin1')).not.toContain('sk-live');

    expect(storage.settings.getSecret('search.api_key')).toBe('sk-live-123456');
    expect(storage.settings.list()).toEqual([
      expect.objectContaining({ key: 'search.api_key', value: '[encrypted]', isSecret: true }),
    ]);
    expect(() => storage.settings.get('search.api_key')).toThrow(/use getSecret/);
  });

  it('stores nothing when OS encryption is unavailable', () => {
    for (const cipher of [undefined, fakeCipher(false)]) {
      const storage = memoryStorage(cipher ? { cipher } : {});
      expect(() => storage.settings.setSecret('search.api_key', 'sk-live')).toThrow(
        expect.objectContaining({ code: 'encryption-unavailable' }),
      );
      expect(storage.settings.list()).toEqual([]);
    }
  });

  it('validates keys', () => {
    const storage = memoryStorage();
    expect(() => storage.settings.set('bad key!', 1)).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    storage.settings.set('plain', 1);
    expect(() =>
      memoryStorage({ cipher: fakeCipher() }).settings.getSecret('missing'),
    ).not.toThrow();
    expect(() => storage.settings.getSecret('plain')).toThrow(/not a secret/);
  });
});
