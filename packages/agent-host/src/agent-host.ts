import {
  createAgentRuntime,
  createSourceStore,
  type AgentRuntime,
  type ResearchEvent,
  type ResearchLimits,
} from '@rka/agent-runtime';
import { type OllamaProvider } from '@rka/model-provider';
import { ResearchProgressEventSchema } from '@rka/shared';
import { type Storage } from '@rka/storage';
import {
  createToolRegistry,
  createWebTools,
  type ReconfigurableWebServices,
  type ToolRegistry,
} from '@rka/tools';
import { ChatController, type ChatUsage } from './chat-controller.js';
import { createAppChatEngines, createChatWebSearch } from './chat-engine.js';
import { createDashboardService, type DashboardService } from './dashboard.js';
import { type HostPorts, type HostUiPort } from './ports.js';
import { researchTaskModelsFor } from './research-engine.js';
import { createResearchToolsService, type ResearchToolsService } from './research-tools.js';

/** Run-time settings the host reads. Each accessor is called when its value is needed. */
export interface AgentHostSettings {
  /** Default research limits; read when each research task starts. */
  readonly researchDefaults: () => Partial<ResearchLimits>;
  /** `engine.chat`; read when each Chat request starts. */
  readonly chatEngine: () => string | undefined;
  /** `engine.research`; read when a research task is created, then pinned to the task. */
  readonly researchEngine: () => string | undefined;
  /** `chat.webSearch` (default off); read when each Chat request starts. */
  readonly chatWebSearch: () => boolean;
}

/** The shell capabilities the host uses. */
export type AgentHostPorts = Pick<
  HostPorts,
  'emitResearchProgress' | 'chooseBackupPath' | 'chooseFile' | 'openExternal'
>;

export interface AgentHostDeps {
  /** Opened (and recovered) by the shell. */
  readonly storage: Storage;
  /** The app's live provider; the shell keeps it in sync with the settings. */
  readonly modelProvider: OllamaProvider;
  /** The app's live web services; the shell keeps them in sync with the settings. */
  readonly webServices: ReconfigurableWebServices;
  readonly settings: AgentHostSettings;
  readonly ports: AgentHostPorts;
  /** Called once per completed Chat reply (e.g. to persist model usage). Must not throw. */
  readonly onChatUsage?: (usage: ChatUsage) => void;
}

export interface AgentHost {
  readonly runtime: AgentRuntime;
  readonly chat: ChatController;
  readonly dashboard: DashboardService;
  readonly researchTools: ResearchToolsService;
  /** The agent's tool registry (web_search, fetch_source). */
  readonly tools: ToolRegistry;
}

/** Research progress for the UI: only events that match the shared contract are emitted. */
export function forwardResearchProgress(
  emit: HostUiPort['emitResearchProgress'],
): (event: ResearchEvent) => void {
  return (event) => {
    const parsed = ResearchProgressEventSchema.safeParse(event);
    if (parsed.success) emit(parsed.data);
  };
}

/**
 * Composition root of the agent: tools, runtime, engines, Chat and the
 * Dashboard / Research Tools services. In-process; never imports Electron.
 */
export function createAgentHost(deps: AgentHostDeps): AgentHost {
  const { storage, modelProvider, webServices, settings, ports } = deps;

  // Web research tools. fetch_source can only reach public addresses; web_search
  // needs a SearXNG URL (Settings → Research & Web Search).
  const sourceStore = createSourceStore(storage);
  const tools = createToolRegistry(createWebTools({ ...webServices, store: sourceStore }));

  const runtime = createAgentRuntime({
    modelProvider,
    tools,
    storage,
    // Read when each task starts, so Settings changes apply to new tasks.
    researchDefaults: settings.researchDefaults,
    // A running task keeps the model configuration it started with, including its
    // Research engine (Settings → Agent Engines; default from RESEARCH_ENGINE, else
    // "legacy"), across restarts. The setting is read only when a task is created.
    taskModels: researchTaskModelsFor(modelProvider, { readFlag: settings.researchEngine }),
    searchConfigured: () => webServices.isSearchConfigured(),
    onResearchEvent: forwardResearchProgress(ports.emitResearchProgress),
  });

  const dashboard = createDashboardService({
    storage,
    runtime,
    chooseBackupPath: ports.chooseBackupPath,
  });

  const researchTools = createResearchToolsService({
    config: () => webServices.config(),
    services: webServices,
    tools,
    storage,
    sourceStore,
    chooseFile: ports.chooseFile,
    openExternal: ports.openExternal,
  });

  const chat = new ChatController({
    runtime,
    // The Chat transcript lives in the same database as research (one writer: the agent).
    conversations: storage.conversations,
    ...(deps.onChatUsage && { onUsage: deps.onChatUsage }),
    // Settings → Agent Engines (default from AGENT_ENGINE, else "legacy"); read when
    // each Chat request starts, so a running reply keeps its engine.
    selectEngine: createAppChatEngines({
      runtime,
      provider: modelProvider,
      readFlag: settings.chatEngine,
      // Settings → Agent Engines → Web search in Chat (default off). Legacy Chat only:
      // every model-produced tool call goes through the ToolGateway (web_search only).
      webSearch: createChatWebSearch({
        registry: tools,
        provider: modelProvider,
        settingEnabled: settings.chatWebSearch,
        searchConfigured: () => webServices.isSearchConfigured(),
        // Diagnostics only: tool, status, reason, sizes and a short hash; never the query.
        audit: (entry) => console.info(`Chat tool call: ${JSON.stringify(entry)}`),
      }),
    }),
  });

  return { runtime, chat, dashboard, researchTools, tools };
}
