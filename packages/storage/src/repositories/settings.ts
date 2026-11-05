import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Executor, type StorageContext } from '../context.js';
import { StorageError } from '../errors.js';
import { settings, type JsonValue } from '../schema.js';
import { JsonValueSchema, parseInput } from '../validation.js';

/**
 * Encrypts secrets with an OS-protected key. Matches Electron's
 * `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Keys that look like credentials must go through setSecret (encrypted). */
export const SECRET_KEY_PATTERN =
  /(pass(word|phrase)?|secret|token|api[-_.]?key|credential|private[-_.]?key|auth|cookie|session)/i;

const KeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/i, 'Use letters, digits, ".", "_" or "-" (max 100).');

export interface SettingEntry {
  readonly key: string;
  /** Secrets are never returned by list(); use getSecret(). */
  readonly value: JsonValue | '[encrypted]';
  readonly isSecret: boolean;
  readonly updatedAt: string;
}

export function createSettingsRepository(
  db: Executor,
  ctx: StorageContext,
  cipher: SecretCipher | undefined,
) {
  function row(key: string) {
    return db.select().from(settings).where(eq(settings.key, key)).get();
  }

  function upsert(key: string, value: string, isSecret: boolean): void {
    const now = ctx.now();
    db.insert(settings)
      .values({ key, value, isSecret, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, isSecret, updatedAt: now } })
      .run();
  }

  function requireCipher(): SecretCipher {
    if (!cipher?.isEncryptionAvailable()) {
      throw new StorageError(
        'encryption-unavailable',
        'OS encryption is not available, so secrets cannot be stored. Nothing was saved.',
      );
    }
    return cipher;
  }

  return {
    /** Reads a normal setting, validated with `schema` when given. */
    get<S extends z.ZodType = z.ZodType<JsonValue>>(
      key: string,
      schema?: S,
    ): z.output<S> | undefined {
      const entry = row(parseInput(KeySchema, key, 'setting key'));
      if (!entry) return undefined;
      if (entry.isSecret) {
        throw new StorageError('secret-rejected', `Setting "${key}" is a secret; use getSecret().`);
      }
      const value = JSON.parse(entry.value) as unknown;
      return schema ? parseInput(schema, value, `setting "${key}"`) : (value as z.output<S>);
    },

    /** Stores a normal (non-secret) setting. Credential-like keys are refused. */
    set(key: string, value: JsonValue): void {
      const k = parseInput(KeySchema, key, 'setting key');
      if (SECRET_KEY_PATTERN.test(k)) {
        throw new StorageError(
          'secret-rejected',
          `"${k}" looks like a credential and would be stored in plaintext. Use setSecret().`,
        );
      }
      upsert(k, JSON.stringify(parseInput(JsonValueSchema, value, `setting "${k}"`)), false);
    },

    /** Encrypts with the OS key store. Throws (and stores nothing) if encryption is unavailable. */
    setSecret(key: string, plainText: string): void {
      const k = parseInput(KeySchema, key, 'setting key');
      const encrypted = requireCipher().encryptString(plainText).toString('base64');
      upsert(k, encrypted, true);
    },

    getSecret(key: string): string | undefined {
      const entry = row(parseInput(KeySchema, key, 'setting key'));
      if (!entry) return undefined;
      if (!entry.isSecret) {
        throw new StorageError('secret-rejected', `Setting "${key}" is not a secret; use get().`);
      }
      return requireCipher().decryptString(Buffer.from(entry.value, 'base64'));
    },

    delete(key: string): boolean {
      return db.delete(settings).where(eq(settings.key, key)).run().changes > 0;
    },

    list(): SettingEntry[] {
      return db
        .select()
        .from(settings)
        .orderBy(asc(settings.key))
        .all()
        .map((entry) => ({
          key: entry.key,
          value: entry.isSecret ? '[encrypted]' : (JSON.parse(entry.value) as JsonValue),
          isSecret: entry.isSecret,
          updatedAt: entry.updatedAt,
        }));
    },
  };
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
