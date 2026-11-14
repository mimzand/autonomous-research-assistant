import { type AgentClient } from '@rka/agent-client';
import { secretValueProblem } from '@rka/agent-host';
import { type RequestMethodName, type RequestResult } from '@rka/agent-protocol';
import {
  SecretUpdateRequestSchema,
  SettingsUpdateResultSchema,
  type SettingsChangedEvent,
  type SettingsUpdateResult,
  type SettingsView,
} from '@rka/shared';

/*
 * AGENT_TRANSPORT=service, Phase 7: Settings are owned by the agent; this shell
 * is a client of them and the only holder of the OS key store.
 *
 * Secret persistence (decision): the agent keeps the Ollama token as ciphertext
 * in SQLite, in the same rows and format as the in-process app. This shell
 * validates and encrypts a new value with safeStorage and sends only the
 * ciphertext (`settings.storeSecret`); it decrypts stored ciphertext when the
 * agent asks (`shell.getSecret`). Plaintext never reaches disk or the renderer.
 */

/** Electron's safeStorage, as this module uses it (kept as an interface: no Electron import). */
export interface ShellSecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** A view always carries this shell's encryption availability: the agent holds no key. */
interface WithView {
  readonly view: SettingsView;
}
const hasView = (value: unknown): value is WithView =>
  typeof value === 'object' && value !== null && 'view' in value;

export interface ServiceSettings {
  /** Adds the shell's encryption availability to a settings result before it goes to the renderer. */
  patchResult<M extends RequestMethodName>(method: M, result: RequestResult<M>): RequestResult<M>;
  /** `ui.settingsChanged` from the agent, ready for the renderer. */
  changedEvent(event: SettingsChangedEvent): SettingsChangedEvent;
  /** `settings:set-secret`: validates and encrypts here, stores the ciphertext in the agent. */
  setSecret(payload: unknown): Promise<SettingsUpdateResult>;
  /** The saved default backup folder, as last seen in a settings view (null until then). */
  backupDirectory(): string | null;
  /** Decrypts stored ciphertext for the agent (`shell.getSecret`); null when it cannot. Never logs. */
  decrypt(ciphertext: string): string | null;
}

export function createServiceSettings(deps: {
  readonly client: Pick<AgentClient, 'request'>;
  readonly cipher: ShellSecretCipher;
  readonly timeoutMs: number;
}): ServiceSettings {
  const { cipher } = deps;
  let backupDirectory: string | null = null;

  const patchView = (view: SettingsView): SettingsView => {
    backupDirectory = view.values['backup.defaultDirectory'];
    return { ...view, encryptionAvailable: cipher.isEncryptionAvailable() };
  };

  const patchResult: ServiceSettings['patchResult'] = (method, result) => {
    if (method === 'settings.get') return patchView(result as SettingsView) as typeof result;
    if (method.startsWith('settings.') && hasView(result)) {
      return { ...result, view: patchView(result.view) } as typeof result;
    }
    return result;
  };

  return {
    patchResult,

    // Already validated by the client (parseEvent); only the key-store flag is added.
    changedEvent: (event) => ({ ...event, view: patchView(event.view) }),

    async setSecret(payload) {
      const { key, value } = SecretUpdateRequestSchema.parse(payload);
      const trimmed = value?.trim() ?? '';
      const problem = secretValueProblem(key, trimmed, cipher.isEncryptionAvailable());
      if (problem) return SettingsUpdateResultSchema.parse(problem);
      let ciphertext: string | null = null;
      if (trimmed) {
        try {
          ciphertext = cipher.encryptString(trimmed).toString('base64');
        } catch {
          // Never include the value (or an error that might) in the result.
          return {
            status: 'failed',
            message: 'The token could not be encrypted. Nothing was saved.',
          };
        }
      }
      const result = await deps.client.request(
        'settings.storeSecret',
        { key, ciphertext },
        { timeoutMs: deps.timeoutMs },
      );
      return patchResult('settings.storeSecret', result);
    },

    backupDirectory: () => backupDirectory,

    decrypt(ciphertext) {
      try {
        return cipher.decryptString(Buffer.from(ciphertext, 'base64'));
      } catch {
        return null;
      }
    },
  };
}
