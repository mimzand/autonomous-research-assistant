import { openStorage, type Storage } from '@rka/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentSecretStore, type DecryptWithShell } from './secrets.js';

const KEY = 'ollama.authToken';
const ROW = `secret.${KEY}`;
const B64 = (text: string) => Buffer.from(text).toString('base64');

let storage: Storage;
afterEach(() => storage.close());

function setup(decrypt: DecryptWithShell) {
  storage = openStorage({ path: ':memory:' });
  const log = vi.fn<(message: string) => void>();
  return { store: createAgentSecretStore({ storage, decrypt, log }), log };
}

describe('createAgentSecretStore', () => {
  it('stores only ciphertext and keeps the decrypted value in memory', async () => {
    const decrypt = vi.fn<DecryptWithShell>(async () => 'plain-token');
    const { store, log } = setup(decrypt);
    await store.store(KEY, B64('cipher'));
    expect(storage.settings.getSecretCiphertext(ROW)).toBe(B64('cipher'));
    expect(decrypt).toHaveBeenCalledWith(KEY, B64('cipher'));
    expect(store.has(KEY)).toBe(true);
    expect(store.get(KEY)).toBe('plain-token');
    expect(JSON.stringify(log.mock.calls)).not.toContain('plain-token');
  });

  it('removes the row and the value with null', async () => {
    const { store } = setup(async () => 'plain');
    await store.store(KEY, B64('cipher'));
    await store.store(KEY, null);
    expect(store.has(KEY)).toBe(false);
    expect(store.get(KEY)).toBeUndefined();
    expect(storage.settings.getSecretCiphertext(ROW)).toBeUndefined();
  });

  it('refuses to encrypt (the shell does that)', () => {
    const { store } = setup(async () => null);
    expect(() => store.set(KEY, 'x')).toThrow(/desktop shell encrypts/);
  });

  it('loads stored secrets once per ready shell', async () => {
    const decrypt = vi.fn<DecryptWithShell>(async () => 'from-disk');
    const { store } = setup(decrypt);
    storage.settings.setSecretCiphertext(ROW, B64('disk'));
    await store.ready(1);
    await store.ready(1);
    await store.ready(2);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(store.get(KEY)).toBe('from-disk');
  });

  it('after a failure, retries only for another connection and logs the key only', async () => {
    const decrypt = vi
      .fn<DecryptWithShell>()
      .mockRejectedValueOnce(Object.assign(new Error('boom secret'), { code: 'timeout' }))
      .mockResolvedValue('ok');
    const { store, log } = setup(decrypt);
    storage.settings.setSecretCiphertext(ROW, B64('disk'));
    await store.ready(1);
    await store.ready(1);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(store.get(KEY)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('(timeout)'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('boom secret');
    await store.ready(2);
    expect(store.get(KEY)).toBe('ok');
  });

  it('a slow older decrypt never overwrites a newer stored value', async () => {
    let releaseOld!: (value: string) => void;
    const decrypt = vi
      .fn<DecryptWithShell>()
      .mockImplementationOnce(() => new Promise((resolve) => (releaseOld = resolve)))
      .mockResolvedValue('new');
    const { store } = setup(decrypt);
    storage.settings.setSecretCiphertext(ROW, B64('old'));
    const loading = store.ready(1);
    await store.store(KEY, B64('new'));
    releaseOld('old');
    await loading;
    expect(store.get(KEY)).toBe('new');
  });

  it('a value the shell cannot decrypt stays unavailable', async () => {
    const { store, log } = setup(async () => null);
    await store.store(KEY, B64('bad'));
    expect(store.has(KEY)).toBe(true);
    expect(store.get(KEY)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not decrypt'));
  });
});
