import {
  createAgentHost,
  createOllamaSettingsService,
  createRuntimeConfig,
  createSettingsService,
  ollamaApplier,
  toOllamaConfig,
  toResearchDefaults,
  toWebConfig,
  webApplier,
  type AgentHostPorts,
} from '@rka/agent-host';
import { createOllamaProvider, ollamaTransportOptionsFromEnv } from '@rka/model-provider';
import { appDatabasePath, openStorage, type RecoveryReport } from '@rka/storage';
import { createReconfigurableWebServices, type ReconfigurableWebServices } from '@rka/tools';
import {
  chatHandlers,
  dashboardHandlers,
  researchHandlers,
  researchToolsHandlers,
  settingsHandlers,
  withShellSecrets,
  type RequestHandlers,
} from './handlers.js';
import { createAgentSecretStore } from './secrets.js';
import { type AgentServerLink } from './server.js';
import { createShellPorts, type ShellSecrets } from './shell-ports.js';

export interface AgentServicesOptions {
  /** Same layout as Electron's userData: the database is `<dataDir>/data/research.db`. */
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  /**
   * Replaces the settings-configured web services (tests: a scripted web, no
   * network). Injected services are not reconfigured by Settings changes.
   */
  readonly webServices?: ReconfigurableWebServices;
}

export interface AgentServices {
  readonly handlers: RequestHandlers;
  readonly databasePath: string;
  readonly recovery: RecoveryReport;
  /** Stops the Chat stream a closed connection was receiving. */
  onDisconnect(connectionId: number): void;
  /**
   * Research progress goes to the server's `broadcast` from now on (dropped before);
   * secrets are asked of its connected shell.
   */
  attachServer(server: AgentServerLink): void;
  /** The shell's key store (reverse calls): decrypts the secrets the agent stores as ciphertext. */
  readonly secrets: ShellSecrets;
  /** Resolves when no Chat reply is being generated. For tests and shutdown. */
  whenChatIdle(): Promise<void>;
  /** Resolves when no research task is executing. For tests and shutdown. */
  whenTasksIdle(): Promise<void>;
  /** Closes the database. Idempotent. */
  close(): void;
}

/**
 * Opens the database (migrations, then recovery of tasks left running) and builds
 * the agent host on it. The agent is then the only SQLite writer. Serves the
 * Dashboard (Phase 3), Chat plus model health (Phase 4), the research task
 * lifecycle with `ui.researchProgress` events (Phase 5), Research Tools plus
 * backup, whose dialogs and links are reverse calls to the shell (Phase 6), and
 * Settings with the Ollama connection (Phase 7).
 *
 * Settings: the same Runtime Configuration Manager as the in-process app
 * (built-in < environment < saved in SQLite; env overrides for server, model and
 * engines), applied live to the Ollama provider and web services and broadcast
 * as `ui.settingsChanged`. The Ollama token is stored as ciphertext and
 * decrypted by the desktop shell (`secrets.ts`).
 */
export function openAgentServices(options: AgentServicesOptions): AgentServices {
  const log = options.log ?? (() => undefined);
  const { env } = options;
  const databasePath = appDatabasePath(options.dataDir);
  const storage = openStorage({ path: databasePath });
  try {
    const recovery = storage.recovery.recoverInterruptedTasks();
    if (recovery.interruptedTaskIds.length) {
      log(
        `Marked ${recovery.interruptedTaskIds.length} task(s) as interrupted after an unexpected shutdown.`,
      );
    }
    let server: AgentServerLink | undefined;
    const shell = createShellPorts({ connections: () => server?.connections() ?? [] });
    const secrets = createAgentSecretStore({
      storage,
      decrypt: (key, ciphertext) => shell.secrets.getSecret(key, ciphertext),
      log,
    });
    // Runtime Configuration Manager (shared with the in-process app). The agent holds no
    // key: encryption availability is the shell's, which adds it to the views it shows.
    const config = createRuntimeConfig({
      storage,
      env,
      encryptionAvailable: () => false,
      secrets,
      warn: log,
    });

    // Ollama: one live provider that follows the settings; Disconnect is session-only.
    let ollamaConnected = true;
    const transport = ollamaTransportOptionsFromEnv(env);
    const modelProvider = createOllamaProvider(toOllamaConfig(config.getSettings()), {
      getAuthToken: () => config.getSecret('ollama.authToken'),
      isConnected: () => ollamaConnected,
      ngrokBypassHosts: transport.ngrokBypassHosts,
    });
    config.register(ollamaApplier(modelProvider));
    const webServices =
      options.webServices ?? createReconfigurableWebServices(toWebConfig(config.getSettings()));
    if (!options.webServices) config.register(webApplier(webServices));

    const ports: AgentHostPorts = {
      emitResearchProgress: (event) => server?.broadcast('ui.researchProgress', event),
      chooseBackupPath: shell.ports.chooseBackupPath,
      chooseFile: shell.ports.chooseFile,
      openExternal: shell.ports.openExternal,
    };
    const host = createAgentHost({
      storage,
      modelProvider,
      webServices,
      settings: {
        researchDefaults: () => toResearchDefaults(config.getSettings()),
        chatEngine: () => config.getSettings()['engine.chat'],
        researchEngine: () => config.getSettings()['engine.research'],
        chatWebSearch: () => config.getSettings()['chat.webSearch'],
      },
      ports,
      // The agent owns the database, so Chat usage is recorded here (as Electron does in-process).
      onChatUsage: (usage) =>
        storage.modelUsage.record({ provider: 'ollama', purpose: 'chat', ...usage }),
    });

    const settings = createSettingsService({
      config,
      ollama: createOllamaSettingsService({
        config,
        provider: modelProvider,
        connection: {
          get: () => ollamaConnected,
          set: (connected) => {
            ollamaConnected = connected;
          },
        },
        recordUsage: (usage) =>
          storage.modelUsage.record({
            provider: 'ollama',
            purpose: 'settings:test-model',
            ...usage,
          }),
      }),
      chooseFolder: shell.ports.chooseFolder,
    });
    // Every connected shell gets the new state (it adds its own encryption availability).
    config.onChange(({ changed }) => {
      log(`Settings changed: ${changed.join(', ')}`);
      server?.broadcast('ui.settingsChanged', { changed: [...changed], view: config.view() });
    });

    return {
      handlers: withShellSecrets(
        {
          ...dashboardHandlers(host.dashboard),
          ...chatHandlers(host.chat, host.runtime),
          ...researchHandlers(host.dashboard),
          ...researchToolsHandlers(host.researchTools, host.dashboard),
          ...settingsHandlers(settings, config, secrets),
        },
        secrets,
      ),
      databasePath,
      recovery,
      onDisconnect: (connectionId) => host.chat.stopForSink(connectionId),
      attachServer: (next) => {
        server = next;
      },
      secrets: shell.secrets,
      whenChatIdle: () => host.chat.whenIdle(),
      whenTasksIdle: () => host.runtime.tasks.whenIdle(),
      close: () => storage.close(),
    };
  } catch (error) {
    storage.close();
    throw error;
  }
}
