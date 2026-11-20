import { createAgentHost } from '@rka/agent-host';
import {
  createOllamaSettingsService,
  createRuntimeConfig,
  createSettingsService,
  ollamaApplier,
  toOllamaConfig,
  toResearchDefaults,
  toWebConfig,
  webApplier,
} from '@rka/agent-host';
import { createOllamaProvider, ollamaTransportOptionsFromEnv } from '@rka/model-provider';
import { SettingsChangedEventSchema, type AppInfo } from '@rka/shared';
import { createReconfigurableWebServices } from '@rka/tools';
import { app, ipcMain, safeStorage } from 'electron';
import { probeAdkRuntime } from './adk-probe.js';
import { chatUsageRecorder, openAppStorage } from './app-storage.js';
import { createElectronHostPorts } from './host-ports.js';
import { registerIpcHandlers } from './ipc.js';
import { checkStartup } from './startup.js';

/*
 * AGENT_TRANSPORT=inprocess (development and tests only, Phase 8): the pre-Phase 8
 * startup path, with the agent host, SQLite and Settings in the Electron main
 * process. index.ts imports this module only behind `import.meta.env.DEV`, so a
 * production build (and the installed app) does not contain it: there the agent
 * always runs as a supervised service (agent-supervisor.ts).
 */

export interface InProcessShell {
  readonly isTrustedSender: (url: string) => boolean;
  readonly getAppInfo: () => AppInfo;
}

/**
 * AGENT_TRANSPORT=inprocess: the agent runs in this process on the local database.
 * Returns the startup check. Development and tests only; not in production builds.
 */
export function startInProcessAgent(shell: InProcessShell): () => void {
  // Opens SQLite (runs migrations) and recovers tasks interrupted by the last shutdown.
  // Secrets are encrypted with the OS key store (DPAPI on Windows) via safeStorage.
  const { storage, recovery } = openAppStorage({
    userDataDir: app.getPath('userData'),
    cipher: safeStorage,
  });
  if (recovery.interruptedTaskIds.length) {
    console.info(
      `Marked ${recovery.interruptedTaskIds.length} task(s) as interrupted after an unexpected shutdown.`,
    );
  }
  app.on('will-quit', () => storage.close());

  // Runtime Configuration Manager: built-in defaults < environment (.env,
  // settings.env, process environment; an invalid value stops startup) <
  // values saved in Settings (SQLite). Changes apply without a restart.
  const config = createRuntimeConfig({
    storage,
    env: process.env,
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  });

  // Ollama: one live provider that follows the settings. The access token is
  // read per request in the main process only; Disconnect is session-only.
  let ollamaConnected = true;
  // Trusted ngrok tunnels (OLLAMA_NGROK_BYPASS_HOSTS, main process only): only these
  // hosts, over HTTPS, get ngrok's browser-warning bypass header.
  const transport = ollamaTransportOptionsFromEnv(process.env);
  if (transport.invalid.length > 0) {
    console.warn(
      `Ignored ${String(transport.invalid.length)} invalid OLLAMA_NGROK_BYPASS_HOSTS entr(y/ies): use exact host names, comma-separated.`,
    );
  }
  if (transport.ngrokBypassHosts.length > 0) {
    console.info(
      `ngrok browser-warning bypass enabled for ${String(transport.ngrokBypassHosts.length)} trusted host(s).`,
    );
  }
  const modelProvider = createOllamaProvider(toOllamaConfig(config.getSettings()), {
    getAuthToken: () => config.getSecret('ollama.authToken'),
    isConnected: () => ollamaConnected,
    ngrokBypassHosts: transport.ngrokBypassHosts,
  });
  config.register(ollamaApplier(modelProvider));

  // Web research services. fetch_source can only reach public addresses; web_search
  // needs a SearXNG URL (Settings → Research & Web Search).
  const webServices = createReconfigurableWebServices(toWebConfig(config.getSettings()));
  config.register(webApplier(webServices));
  if (!webServices.isSearchConfigured()) {
    console.info('Web search is off: set the SearXNG URL in Settings to enable it.');
  }

  // OS capabilities (windows, dialogs, browser, key store) for the host and Settings.
  const ports = createElectronHostPorts({
    backupDirectory: () => config.getSetting('backup.defaultDirectory'),
    getSecret: (key) => config.getSecret(key),
  });

  // The agent: tools, runtime, Chat/Research engines, Chat, Dashboard and Research Tools.
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
    onChatUsage: chatUsageRecorder(storage),
  });

  const ollamaSettings = createOllamaSettingsService({
    config,
    provider: modelProvider,
    connection: {
      get: () => ollamaConnected,
      set: (connected) => {
        ollamaConnected = connected;
      },
    },
    recordUsage: (usage) =>
      storage.modelUsage.record({ provider: 'ollama', purpose: 'settings:test-model', ...usage }),
  });
  const settingsService = createSettingsService({
    config,
    ollama: ollamaSettings,
    chooseFolder: ports.chooseFolder,
  });
  // Typed change events: every window gets the new state (validated against the contract).
  config.onChange(({ changed }) => {
    const event = SettingsChangedEventSchema.parse({ changed, view: config.view() });
    console.info(`Settings changed: ${changed.join(', ')}`);
    ports.emitSettingsChanged(event);
  });

  registerIpcHandlers(ipcMain, {
    runtime: host.runtime,
    chat: host.chat,
    dashboard: host.dashboard,
    researchTools: host.researchTools,
    settings: settingsService,
    isTrustedSender: shell.isTrustedSender,
    getAppInfo: shell.getAppInfo,
  });

  // Startup check: Ollama reachable and the model installed. Never downloads a model;
  // the window shows the exact command to run when something is missing.
  return () =>
    void checkStartup(() => host.runtime.getModelHealth(), webServices.isSearchConfigured()).then(
      (result) => console.info(`Startup check: ${result.summary}`),
    );
}

/** ADK migration (phase 1): loads ADK in this process and runs its offline self-check. */
export function probeAdkInProcess(): void {
  void probeAdkRuntime().then(({ ok, summary }) =>
    ok ? console.info(`ADK runtime: ${summary}`) : console.warn(`ADK runtime: ${summary}`),
  );
}
