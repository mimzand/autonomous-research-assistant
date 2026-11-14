import { type ShellHandlers } from '@rka/agent-client';
import { type HostPorts } from '@rka/agent-host';
import { type ServiceSettings, type ShellSecretCipher } from './service-settings.js';

/** The OS capabilities the agent may ask for (Electron: `createElectronHostPorts`). */
export type ShellPortsSource = Pick<
  HostPorts,
  'chooseBackupPath' | 'chooseFile' | 'chooseFolder' | 'openExternal'
>;

/** The key store side of the shell (Electron: safeStorage, through `ServiceSettings`). */
export interface ShellKeyStore {
  readonly cipher: Pick<ShellSecretCipher, 'isEncryptionAvailable'>;
  readonly decrypt: ServiceSettings['decrypt'];
}

/**
 * AGENT_TRANSPORT=service: answers the agent's reverse requests with the same
 * Electron ports the in-process host uses. Paths go to the agent only (never to the
 * renderer); `openExternal` still refuses non-http(s) links; the save dialog owns the
 * overwrite confirmation. Secrets travel only on the authenticated agent connection:
 * the agent sends the stored ciphertext and gets the decrypted value back (Phase 7).
 */
export function shellRequestHandlers(ports: ShellPortsSource, keys: ShellKeyStore): ShellHandlers {
  return {
    'shell.chooseBackupPath': async () => ({ path: await ports.chooseBackupPath() }),
    'shell.chooseFile': async () => ({ path: await ports.chooseFile() }),
    'shell.chooseFolder': async ({ defaultPath }) => ({
      path: await ports.chooseFolder(defaultPath),
    }),
    'shell.openExternal': async ({ url }) => {
      await ports.openExternal(url);
      return null;
    },
    'shell.getSecret': ({ ciphertext }) => ({ value: keys.decrypt(ciphertext) }),
    'shell.encryptionAvailable': () => ({ available: keys.cipher.isEncryptionAvailable() }),
  };
}
