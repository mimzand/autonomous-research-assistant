import { createAgentHost, type AgentHostPorts } from '@rka/agent-host';
import { loadResearchConfig } from '@rka/agent-runtime';
import {
  createOllamaProvider,
  loadOllamaConfig,
  ollamaTransportOptionsFromEnv,
} from '@rka/model-provider';
import { appDatabasePath, openStorage, type RecoveryReport } from '@rka/storage';
import { createReconfigurableWebServices, loadWebConfig } from '@rka/tools';
import { chatHandlers, dashboardHandlers, type RequestHandlers } from './handlers.js';

export interface AgentServicesOptions {
  /** Same layout as Electron's userData: the database is `<dataDir>/data/research.db`. */
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
}

export interface AgentServices {
  readonly handlers: RequestHandlers;
  readonly databasePath: string;
  readonly recovery: RecoveryReport;
  /** Stops the Chat stream a closed connection was receiving. */
  onDisconnect(connectionId: number): void;
  /** Resolves when no Chat reply is being generated. For tests and shutdown. */
  whenChatIdle(): Promise<void>;
  /** Closes the database. Idempotent. */
  close(): void;
}

const needsShell = (what: string) => () =>
  Promise.reject(new Error(`${what} needs the desktop shell (reverse RPC, Phase 6).`));

/** No shell is connected for reverse calls yet; the Phase 3 methods use none of these. */
const noShellPorts: AgentHostPorts = {
  emitResearchProgress: () => undefined,
  chooseBackupPath: needsShell('Choosing a backup file'),
  chooseFile: needsShell('Choosing a file'),
  openExternal: needsShell('Opening a link'),
};

/**
 * Opens the database (migrations, then recovery of tasks left running) and builds
 * the agent host on it. The agent is then the only SQLite writer. Serves the
 * Dashboard (Phase 3) and Chat plus model health (Phase 4).
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
    const host = createAgentHost({
      storage,
      modelProvider: createOllamaProvider(loadOllamaConfig(env), {
        ngrokBypassHosts: ollamaTransportOptionsFromEnv(env).ngrokBypassHosts,
      }),
      webServices: createReconfigurableWebServices(loadWebConfig(env)),
      settings: {
        researchDefaults: () => research,
        chatEngine: () => env['AGENT_ENGINE'],
        researchEngine: () => env['RESEARCH_ENGINE'],
        chatWebSearch: () => false,
      },
      ports: noShellPorts,
      // The agent owns the database, so Chat usage is recorded here (as Electron does in-process).
      onChatUsage: (usage) =>
        storage.modelUsage.record({ provider: 'ollama', purpose: 'chat', ...usage }),
    });
    return {
      handlers: {
        ...dashboardHandlers(host.dashboard),
        ...chatHandlers(host.chat, host.runtime),
      },
      databasePath,
      recovery,
      onDisconnect: (connectionId) => host.chat.stopForSink(connectionId),
      whenChatIdle: () => host.chat.whenIdle(),
      close: () => storage.close(),
    };
  } catch (error) {
    storage.close();
    throw error;
  }
}
