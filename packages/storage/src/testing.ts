/* Test-only helpers. Not exported from the package entry point. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SecretCipher } from './repositories/settings.js';
import { openStorage, type OpenStorageOptions, type Storage } from './storage.js';

/** Clock that advances 1 s per call, and sequential ids: deterministic ordering. */
export function deterministicContext() {
  let tick = 0;
  let id = 0;
  return {
    now: () => new Date(Date.UTC(2026, 10, 4, 10, 0, tick++)).toISOString(),
    newId: () => `id-${String(++id).padStart(4, '0')}`,
  };
}

export function memoryStorage(options: Partial<OpenStorageOptions> = {}): Storage {
  return openStorage({ path: ':memory:', context: deterministicContext(), ...options });
}

/** A temp directory for file-backed databases; call cleanup() afterwards. */
export function tempDir(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rka-storage-'));
  return {
    dir,
    dbPath: join(dir, 'data', 'research.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Reversible fake of Electron safeStorage (XOR + marker) for tests. */
export function fakeCipher(available = true): SecretCipher & { calls: number } {
  const key = 0x5a;
  return {
    calls: 0,
    isEncryptionAvailable: () => available,
    encryptString(plain) {
      this.calls++;
      return Buffer.concat([Buffer.from('ENC1'), Buffer.from(plain, 'utf8').map((b) => b ^ key)]);
    },
    decryptString(encrypted) {
      if (encrypted.subarray(0, 4).toString() !== 'ENC1') throw new Error('bad ciphertext');
      return Buffer.from(encrypted.subarray(4).map((b) => b ^ key)).toString('utf8');
    },
  };
}
