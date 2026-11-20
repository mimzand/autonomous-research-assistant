import type { ResearchProgressEvent, SecretSettingKey, SettingsChangedEvent } from '@rka/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  HostDialogPort,
  HostPorts,
  HostSecretsPort,
  HostShellPort,
  HostUiPort,
} from './index.js';

function fakePorts(): HostPorts & { readonly opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    emitResearchProgress: () => undefined,
    emitSettingsChanged: () => undefined,
    chooseBackupPath: () => Promise.resolve('C:\\backups\\research.db'),
    chooseFile: () => Promise.resolve(null),
    chooseFolder: (defaultPath) => Promise.resolve(defaultPath),
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    encryptionAvailable: () => true,
    getSecret: () => undefined,
  };
}

describe('@rka/agent-host entry', () => {
  it('loads without side effects', async () => {
    await expect(import('./index.js')).resolves.toBeDefined();
  });

  it('HostPorts combines the UI, dialog, shell and secrets ports', () => {
    expectTypeOf<HostPorts>().toExtend<HostUiPort>();
    expectTypeOf<HostPorts>().toExtend<HostDialogPort>();
    expectTypeOf<HostPorts>().toExtend<HostShellPort>();
    expectTypeOf<HostPorts>().toExtend<HostSecretsPort>();
  });

  it('port signatures match the shared contracts and current Electron call sites', () => {
    expectTypeOf<HostPorts['emitResearchProgress']>()
      .parameter(0)
      .toEqualTypeOf<ResearchProgressEvent>();
    expectTypeOf<HostPorts['emitSettingsChanged']>()
      .parameter(0)
      .toEqualTypeOf<SettingsChangedEvent>();
    expectTypeOf<HostPorts['chooseBackupPath']>().returns.toEqualTypeOf<Promise<string | null>>();
    expectTypeOf<HostPorts['chooseFile']>().returns.toEqualTypeOf<Promise<string | null>>();
    expectTypeOf<HostPorts['chooseFolder']>().parameters.toEqualTypeOf<[string | null]>();
    expectTypeOf<HostPorts['openExternal']>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<HostPorts['getSecret']>().parameter(0).toEqualTypeOf<SecretSettingKey>();
  });

  it('a plain object satisfies HostPorts (no Electron types needed)', async () => {
    const ports = fakePorts();
    expect(await ports.chooseBackupPath()).toBe('C:\\backups\\research.db');
    expect(await ports.chooseFile()).toBeNull();
    expect(await ports.chooseFolder(null)).toBeNull();
    await ports.openExternal('https://example.com/');
    expect(ports.opened).toEqual(['https://example.com/']);
    expect(ports.encryptionAvailable()).toBe(true);
    expect(ports.getSecret('ollama.authToken')).toBeUndefined();
  });
});
