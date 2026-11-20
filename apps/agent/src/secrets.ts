import { SECRET_PREFIX, type SecretStore } from '@rka/agent-host';
import { type Storage } from '@rka/storage';
import { SECRET_SETTING_KEYS, type SecretSettingKey } from '@rka/shared';

/*
 * Secrets in the agent service (Phase 7). Persistence decision:
 *
 *   ciphertext in SQLite, decrypted only by the desktop shell.
 *
 * The rows are exactly the ones the in-process app writes (`secret.<key>`,
 * base64 safeStorage ciphertext, `isSecret`), so a token saved in either mode
 * works in the other. The agent holds no key: the shell encrypts a new value
 * (`settings.storeSecret` carries ciphertext only) and decrypts on request
 * (`shell.getSecret` carries the stored ciphertext). Plaintext lives only in this
 * process's memory; it is never written, logged or sent to a renderer.
 */

/** Asks a connected desktop shell to decrypt `ciphertext`; null when it cannot. */
export type DecryptWithShell = (
  key: SecretSettingKey,
  ciphertext: string,
) => Promise<string | null>;

export interface AgentSecretStore extends SecretStore {
  /**
   * Stores ciphertext the shell encrypted (or removes the secret with null), then
   * asks the shell to decrypt it so the new value is used at once.
   */
  store(key: SecretSettingKey, ciphertext: string | null): Promise<void>;
  /**
   * Decrypts every stored secret through the shell, once. After a failure it is
   * tried again only for another shell connection (e.g. the app was restarted),
   * so a broken shell never delays every request. Never throws; a secret that
   * cannot be read stays unavailable (requests go without it) and is reported
   * with its key only.
   */
  ready(connectionId: number): Promise<void>;
}

export function createAgentSecretStore(deps: {
  readonly storage: Pick<Storage, 'settings'>;
  readonly decrypt: DecryptWithShell;
  readonly log: (message: string) => void;
}): AgentSecretStore {
  const { storage } = deps;
  const plain = new Map<SecretSettingKey, string>();
  /** Bumped by every store(), so an older, slower decrypt never overwrites a newer value. */
  const version = new Map<SecretSettingKey, number>();
  let loading: Promise<boolean> | undefined;
  /** The connection whose request started the last load that failed. */
  let failedFor: number | undefined;

  const ciphertextOf = (key: SecretSettingKey) =>
    storage.settings.getSecretCiphertext(SECRET_PREFIX + key);

  async function load(key: SecretSettingKey): Promise<boolean> {
    const started = version.get(key) ?? 0;
    const ciphertext = ciphertextOf(key);
    if (!ciphertext) {
      plain.delete(key);
      return true;
    }
    try {
      const value = await deps.decrypt(key, ciphertext);
      if ((version.get(key) ?? 0) !== started) return true; // a newer store() won
      if (value) plain.set(key, value);
      else plain.delete(key);
      if (!value) deps.log(`The desktop shell could not decrypt the stored secret "${key}".`);
      return true;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      deps.log(
        `Could not read the secret "${key}" from the desktop shell (${typeof code === 'string' ? code : 'error'}).`,
      );
      return false;
    }
  }

  return {
    has: (key) => ciphertextOf(key) !== undefined,
    get: (key) => plain.get(key),
    set() {
      throw new Error(
        'The agent service cannot encrypt secrets: the desktop shell encrypts them (settings.storeSecret).',
      );
    },

    async store(key, ciphertext) {
      version.set(key, (version.get(key) ?? 0) + 1);
      plain.delete(key);
      if (ciphertext) storage.settings.setSecretCiphertext(SECRET_PREFIX + key, ciphertext);
      else storage.settings.delete(SECRET_PREFIX + key);
      if (ciphertext) await load(key);
    },

    ready(connectionId) {
      if (loading && failedFor !== undefined && failedFor !== connectionId) loading = undefined;
      loading ??= Promise.all(SECRET_SETTING_KEYS.map(load)).then((results) => {
        const ok = results.every(Boolean);
        failedFor = ok ? undefined : connectionId;
        return ok;
      });
      return loading.then(() => undefined);
    },
  };
}
