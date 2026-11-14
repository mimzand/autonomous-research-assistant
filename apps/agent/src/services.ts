import { createAgentHost, type AgentHostPorts } from '@rka/agent-host';
import { loadResearchConfig } from '@rka/agent-runtime';
import {
  createOllamaProvider,
  loadOllamaConfig,
  ollamaTransportOptionsFromEnv,
} from '@rka/model-provider';
import { appDatabasePath, openStorage, type RecoveryReport } from '@rka/storage';
import {
  createReconfigurableWebServices,
  loadWebConfig,
  type ReconfigurableWebServices,
} from '@rka/tools';
import {
  chatHandlers,
  dashboardHandlers,
  researchHandlers,
  researchToolsHandlers,
  type RequestHandlers,
} from './handlers.js';
import { type AgentServerLink } from './server.js';
import { createShellPorts, type ShellSecrets } from './shell-ports.js';

export interface AgentServicesOptions {
  /** Same layout as Electron's userData: the database is `<dataDir>/data/research.db`. */
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  /** Replaces the env-configured web services (tests: a scripted web, no network). */
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
  /** Secrets kept by the desktop shell (reverse calls). Unused until Phase 7. */
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
 * lifecycle with `ui.researchProgress` events (Phase 5), and Research Tools plus
 * backup, whose dialogs and links are reverse calls to the shell (Phase 6).
 *
 * Model, web and research settings come from the environment only (as defaults
 * in the desktop app). Saved Settings, the Ollama access token and live
 * reconfiguration move here in Phase 7.
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
    const research = loadResearchConfig(env);
    let server: AgentServerLink | undefined;
    const shell = createShellPorts({ connections: () => server?.connections() ?? [] });
    const ports: AgentHostPorts = {
      emitResearchProgress: (event) => server?.broadcast('ui.researchProgress', event),
      chooseBackupPath: shell.ports.chooseBackupPath,
      chooseFile: shell.ports.chooseFile,
      openExternal: shell.ports.openExternal,
    };
    const host = createAgentHost({
      storage,
      modelProvider: createOllamaProvider(loadOllamaConfig(env), {
        ngrokBypassHosts: ollamaTransportOptionsFromEnv(env).ngrokBypassHosts,
      }),
      webServices: options.webServices ?? createReconfigurableWebServices(loadWebConfig(env)),
      settings: {
        researchDefaults: () => research,
        chatEngine: () => env['AGENT_ENGINE'],
        researchEngine: () => env['RESEARCH_ENGINE'],
        chatWebSearch: () => false,
      },
      ports,
      // The agent owns the database, so Chat usage is recorded here (as Electron does in-process).
      onChatUsage: (usage) =>
        storage.modelUsage.record({ provider: 'ollama', purpose: 'chat', ...usage }),
    });
    return {
      handlers: {
        ...dashboardHandlers(host.dashboard),
        ...chatHandlers(host.chat, host.runtime),
        ...researchHandlers(host.dashboard),
        ...researchToolsHandlers(host.researchTools, host.dashboard),
      },
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
